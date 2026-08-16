import type { GroveConfig, Scope } from '../config/index.js';
import { runnerName } from '../naming.js';
import {
  DEFAULT_DRAIN_TIMEOUT_MS,
  type DockerContainer,
} from '../stack/index.js';
import type { GroupRegistrationRecord, RunnerRecord } from '../state/index.js';
import type { Action } from './actions.js';
import {
  describeWhere,
  flattenObserved,
  type ObservedState,
} from './observed.js';
import { classifyRunners } from './ownership.js';
import {
  groupForgeKey,
  orphanSharedEntities,
  sharedEntities,
} from './shared.js';

export interface ReconcileOptions {
  drainTimeoutMs?: number;
  // A GitLab group registers once and starts N managers against one token.
  // The stored row is what tells grove the entity already exists.
  registrations?: GroupRegistrationRecord[];
}

interface DesiredRunner {
  name: string;
  group: string;
  index: number;
  host: string;
  forge: string;
}

interface ForgeSighting {
  scope: Scope;
  id: string;
}

function containerKey(host: string, name: string): string {
  return `${host} ${name}`;
}

// A desired seat is a name on one host. Two hosts never share a name, so the
// pair is what tells a moved seat from a converged one.
function placementKey(host: string, name: string): string {
  return `${host} ${name}`;
}

// Two forges can list the same name. Only the forge a record names may be
// deregistered for it, so a sighting is only ever looked up with both.
function sightingKey(forge: string, name: string): string {
  return `${forge} ${name}`;
}

// One group at one forge. A GitLab entity belongs to that pair and to
// nothing smaller, because every seat of the group shares it.
// One entity at one forge. Two forges can hand out the same runner id, so
// the pair is what identifies an entity across the whole pass.
function entityKey(forge: string, forgeRunnerId: string): string {
  return `${forge} ${forgeRunnerId}`;
}

export function reconcile(
  desired: GroveConfig,
  observed: ObservedState,
  records: RunnerRecord[],
  options: ReconcileOptions = {},
): Action[] {
  const fallbackDrain = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const hosts = new Map(observed.hosts.map((entry) => [entry.host, entry]));
  const forges = new Map(observed.forges.map((entry) => [entry.forge, entry]));
  // A forge that gives a whole group one entity. Deleting that entity takes
  // every manager with it, which is why a scale-down never touches it. The
  // config says which forges those are, and the observation catches a forge
  // whose kind changed under a fleet that is already running.
  const sharedForges = new Set([
    ...Object.entries(desired.forges)
      .filter(([, forge]) => forge.kind === 'gitlab')
      .map(([name]) => name),
    ...observed.forges
      .filter((observation) => observation.shared === true)
      .map((observation) => observation.forge),
  ]);
  const registrationByGroup = new Map(
    (options.registrations ?? [])
      .filter((row) => row.retiredAt === null)
      .map((row) => [groupForgeKey(row.group, row.forge), row] as const),
  );

  const unsupported: Action[] = [];
  const degraded: Action[] = [];
  const converge: Action[] = [];
  const removals: Action[] = [];
  const reports: Action[] = [];

  const drainByGroup = new Map<string, number>();
  for (const group of desired.groups) {
    drainByGroup.set(group.name, group.drain_timeout ?? fallbackDrain);
  }

  const wanted = new Map<string, DesiredRunner>();
  for (const group of desired.groups) {
    if (group.stack !== 'docker') {
      unsupported.push({
        kind: 'report-unsupported',
        group: group.name,
        reason: 'native runners arrive in milestone 4',
        destructive: false,
      });
      continue;
    }
    // Indexes run 1..count for the whole group, so a placement that spans
    // hosts never produces the same name twice.
    let index = 0;
    for (const [host, count] of Object.entries(group.placement)) {
      for (let seat = 0; seat < count; seat += 1) {
        index += 1;
        const name = runnerName(group.name, index);
        wanted.set(placementKey(host, name), {
          name,
          group: group.name,
          index,
          host,
          forge: group.forge,
        });
      }
    }
  }

  const activeRecords = records.filter((record) => record.retiredAt === null);
  const recordByPlacement = new Map(
    activeRecords.map((record) => [
      placementKey(record.host, record.name),
      record,
    ]),
  );
  const recordByName = new Map(
    activeRecords.map((record) => [record.name, record]),
  );

  // A host or a forge that did not answer is dropped here, so nothing below
  // reads silence as absence and deletes what it cannot see.
  const observedRunners = flattenObserved(observed, {
    skipUnreachable: true,
    records: activeRecords,
  });

  const containers = new Map<string, DockerContainer>();
  const sightings = new Map<string, ForgeSighting>();
  for (const entry of observedRunners) {
    if (entry.container !== undefined && entry.host !== undefined) {
      containers.set(containerKey(entry.host, entry.name), entry.container);
    }
    if (
      entry.forgeRunner !== undefined &&
      entry.forge !== undefined &&
      entry.scope !== undefined
    ) {
      sightings.set(sightingKey(entry.forge, entry.name), {
        scope: entry.scope,
        id: entry.forgeRunner.id,
      });
    }
  }

  // Every runner id a reachable forge listed. A stored registration pointing
  // at an entity somebody deleted is told from a live one right here.
  const entityIds = new Map<string, Set<string>>();
  for (const observation of forges.values()) {
    if (observation.reachable) {
      entityIds.set(
        observation.forge,
        new Set(observation.runners.map((listed) => listed.runner.id)),
      );
    }
  }

  const wantedGroups = new Set(
    [...wanted.values()].map((entry) =>
      groupForgeKey(entry.group, entry.forge),
    ),
  );
  const removedByGroup = new Map<string, RunnerRecord[]>();

  // Hosts and forges this pass needs and could not reach.
  const relevantHosts = new Set<string>();
  const relevantForges = new Set<string>();
  for (const entry of wanted.values()) {
    relevantHosts.add(entry.host);
    relevantForges.add(entry.forge);
  }
  for (const record of activeRecords) {
    relevantHosts.add(record.host);
    relevantForges.add(record.forge);
  }
  for (const name of [...relevantHosts].sort()) {
    const entry = hosts.get(name);
    if (entry === undefined) {
      degraded.push({
        kind: 'report-degraded',
        target: name,
        host: name,
        reason: 'host was not observed on this pass',
        destructive: false,
      });
      continue;
    }
    if (!entry.reachable) {
      degraded.push({
        kind: 'report-degraded',
        target: name,
        host: name,
        reason: entry.reason ?? 'unreachable',
        destructive: false,
      });
    }
  }
  for (const entry of forges.values()) {
    if (!entry.reachable) {
      degraded.push({
        kind: 'report-degraded',
        target: entry.forge,
        reason: entry.reason ?? 'the forge did not answer',
        destructive: false,
      });
    }
  }
  // A forge no observation covers is silence, not an empty forge. Reported
  // here so the destructive path below can refuse it the same way it refuses
  // a forge that answered with an error.
  for (const name of [...relevantForges].sort()) {
    if (!forges.has(name)) {
      degraded.push({
        kind: 'report-degraded',
        target: name,
        reason: `forge "${name}" was not observed on this pass`,
        destructive: false,
      });
    }
  }

  // One report per group, not one per seat, when a forge blocks a whole group.
  const forgeBlockedGroups = new Set<string>();

  for (const entry of wanted.values()) {
    const observation = hosts.get(entry.host);
    if (observation === undefined || !observation.reachable) {
      continue;
    }

    const guard = observation.workRoots[entry.group];
    if (guard !== undefined && !guard.ok) {
      degraded.push({
        kind: 'report-degraded',
        target: entry.name,
        host: entry.host,
        reason: guard.reason ?? 'the work root is not usable',
        destructive: false,
      });
      continue;
    }

    const record = recordByPlacement.get(placementKey(entry.host, entry.name));

    // The seat moved to another host. The record still points at the old
    // host, where the removal batch below drains it and retires the record,
    // so the create waits for the next pass rather than running the same
    // name in two places at once.
    if (record === undefined && recordByName.has(entry.name)) {
      continue;
    }

    const container = containers.get(containerKey(entry.host, entry.name));

    // The name matches but no record claims it. Reported below, never adopted.
    if (
      record === undefined &&
      (container !== undefined ||
        sightings.has(sightingKey(entry.forge, entry.name)))
    ) {
      continue;
    }

    if (container === undefined) {
      // Only a create needs a registration token. A start reuses the one the
      // container already holds, so a forge that did not answer must not
      // block it.
      const forgeObservation = forges.get(entry.forge);
      if (forgeObservation === undefined || !forgeObservation.reachable) {
        if (!forgeBlockedGroups.has(entry.group)) {
          forgeBlockedGroups.add(entry.group);
          degraded.push({
            kind: 'report-degraded',
            target: entry.group,
            reason:
              forgeObservation === undefined
                ? `forge "${entry.forge}" was not observed on this pass, so grove creates no runner for group "${entry.group}"`
                : `forge "${entry.forge}" did not answer, so grove creates no runner for group "${entry.group}"`,
            destructive: false,
          });
        }
        continue;
      }
      const stored = sharedForges.has(entry.forge)
        ? registrationByGroup.get(groupForgeKey(entry.group, entry.forge))
        : undefined;
      // The id of the entity behind the stored row, when the forge no longer
      // lists it. apply retires that row and no other, so a row another
      // process minted in between survives.
      const renew =
        stored !== undefined &&
        entityIds.get(entry.forge)?.has(stored.forgeRunnerId) !== true
          ? stored.forgeRunnerId
          : undefined;
      converge.push({
        kind: 'create-runner',
        host: entry.host,
        forge: entry.forge,
        group: entry.group,
        index: entry.index,
        name: entry.name,
        ...(record === undefined ? {} : { recordId: record.id }),
        ...(renew === undefined ? {} : { renewRegistration: renew }),
        // Renewing throws away the only copy of a glrt- token, so the
        // operator answers the confirmation prompt first.
        destructive: renew !== undefined,
      });
      continue;
    }

    if (container.state !== 'running' && container.state !== 'restarting') {
      converge.push({
        kind: 'start-container',
        host: entry.host,
        name: entry.name,
        ...(record === undefined ? {} : { recordId: record.id }),
        destructive: false,
      });
    }
  }

  // The highest index drains first, so a scale-down peels seats off the top
  // of the range in the order an operator reads them.
  const surplus = activeRecords
    .filter((record) => !wanted.has(placementKey(record.host, record.name)))
    .sort(
      (left, right) =>
        right.index - left.index || left.name.localeCompare(right.name),
    );

  for (const record of surplus) {
    const observation = hosts.get(record.host);
    if (observation === undefined || !observation.reachable) {
      degraded.push({
        kind: 'report-degraded',
        target: record.name,
        host: record.host,
        reason: `host "${record.host}" is unreachable, so grove leaves this runner and its forge record alone`,
        destructive: false,
      });
      continue;
    }

    const forgeObservation = forges.get(record.forge);
    if (forgeObservation === undefined) {
      degraded.push({
        kind: 'report-degraded',
        target: record.name,
        host: record.host,
        reason: `forge "${record.forge}" was not observed on this pass, so grove leaves this runner in place`,
        destructive: false,
      });
      continue;
    }
    if (!forgeObservation.reachable) {
      degraded.push({
        kind: 'report-degraded',
        target: record.name,
        host: record.host,
        reason: `forge "${record.forge}" did not answer, so grove leaves this runner in place`,
        destructive: false,
      });
      continue;
    }

    const container = containers.get(containerKey(record.host, record.name));
    // Only the forge this record names. A colliding name at another forge is
    // unmanaged there, so grove must never delete it.
    const sighting = sightings.get(sightingKey(record.forge, record.name));
    const shared = sharedForges.has(record.forge);
    const drainTimeoutMs = drainByGroup.get(record.group) ?? fallbackDrain;

    if (container !== undefined) {
      removals.push({
        kind: 'stop-container',
        host: record.host,
        name: record.name,
        recordId: record.id,
        drainTimeoutMs,
        destructive: true,
      });
    }
    // One entity serves every manager in the group, so removing one seat
    // must not deregister anything. The entity goes below, once the last
    // record for the group has gone with it.
    if (sighting !== undefined && !shared) {
      removals.push({
        kind: 'deregister-runner',
        host: record.host,
        forge: record.forge,
        scope: sighting.scope,
        name: record.name,
        forgeRunnerId: sighting.id,
        recordId: record.id,
        destructive: true,
      });
    }
    if (container !== undefined) {
      removals.push({
        kind: 'remove-container',
        host: record.host,
        name: record.name,
        recordId: record.id,
        destructive: true,
      });
    }
    // The report sits next to the retire it explains, so a reader of the plan
    // sees why the record goes without hunting through the report block.
    if (container === undefined && sighting === undefined) {
      removals.push({
        kind: 'report-orphan-record',
        name: record.name,
        recordId: record.id,
        host: record.host,
        reason: 'no container and no forge runner behind this record',
        destructive: false,
      });
    }
    removals.push({
      kind: 'retire-record',
      host: record.host,
      name: record.name,
      recordId: record.id,
      destructive: true,
    });
    const groupKey = groupForgeKey(record.group, record.forge);
    removedByGroup.set(groupKey, [
      ...(removedByGroup.get(groupKey) ?? []),
      record,
    ]);
  }

  // The entity goes only when every record behind it goes with it, and only
  // when the config wants no seat in that group any more.
  const ownedEntities = new Set<string>();
  for (const observation of forges.values()) {
    if (observation.shared !== true || !observation.reachable) {
      continue;
    }
    for (const entity of sharedEntities(observation, activeRecords)) {
      const key = groupForgeKey(entity.group, entity.forge);
      const registration = registrationByGroup.get(key);
      // An open registration row naming this id is what proves grove minted
      // the entity. That is ownership, and it holds whether the config still
      // wants the group and whether this pass deletes the entity, so the
      // report below never calls it somebody else's.
      const owned = registration?.forgeRunnerId === entity.runner.id;
      if (owned) {
        ownedEntities.add(entityKey(entity.forge, entity.runner.id));
      }
      if (wantedGroups.has(key)) {
        continue;
      }
      let host: string | undefined;
      if (entity.records.length === 0) {
        // Nothing points at this entity any more. Without the proof above it
        // belongs to somebody else, and grove only reports it.
        if (!owned) {
          continue;
        }
      } else {
        const removedIds = new Set(
          (removedByGroup.get(key) ?? []).map((record) => record.id),
        );
        if (!entity.records.every((record) => removedIds.has(record.id))) {
          continue;
        }
        // The highest-index seat, so the delete queues behind that host's own
        // removals rather than in a bucket of its own. A seat on another host
        // races it. A sibling on this host whose stop failed does not hold it
        // back either, because no seat carries the entity description. Either
        // way a container keeps running against an entity that is gone. It
        // draws no more jobs, its record was never retired, and the next pass
        // stops it again.
        host = entity.records[entity.records.length - 1].host;
      }
      removals.push({
        kind: 'delete-shared-runner',
        ...(host === undefined ? {} : { host }),
        forge: entity.forge,
        scope: entity.scope,
        group: entity.group,
        name: entity.runner.name,
        forgeRunnerId: entity.runner.id,
        ...(registration === undefined
          ? {}
          : { registrationId: registration.id }),
        destructive: true,
      });
    }
  }

  for (const entry of classifyRunners(observedRunners, activeRecords)) {
    if (entry.ownership !== 'unmanaged') {
      continue;
    }
    reports.push({
      kind: 'report-unmanaged',
      name: entry.name,
      where: describeWhere(entry),
      ...(entry.host === undefined ? {} : { host: entry.host }),
      destructive: false,
    });
  }

  // A shared entity produces no sighting when no record claims it, so it
  // would otherwise be invisible. The name matches the convention and no
  // record backs it, which is exactly the unmanaged cell. An entity grove
  // owns is not, however few records point at it right now.
  for (const entity of orphanSharedEntities(observed, activeRecords)) {
    if (ownedEntities.has(entityKey(entity.forge, entity.runner.id))) {
      continue;
    }
    reports.push({
      kind: 'report-unmanaged',
      name: entity.runner.name,
      where: `runner entity ${entity.runner.id} at ${entity.forge}`,
      destructive: false,
    });
  }

  return [...unsupported, ...degraded, ...converge, ...removals, ...reports];
}
