import type { GroveConfig, StackKind } from '../config/index.js';
import { DEFAULT_DRAIN_TIMEOUT_MS } from '../stack/index.js';
import type { GroupRegistrationRecord, RunnerRecord } from '../state/index.js';
import type { Action } from './actions.js';
import {
  describeWhere,
  type ForgeObservation,
  flattenObserved,
  hostStackError,
  type ObservedState,
} from './observed.js';
import { classifyRunners, isDestroyable } from './ownership.js';
import { groupForgeKey, sharedEntities } from './shared.js';

// A forge that refused and a forge grove never asked both mean the same
// thing here: nobody can say what that forge holds, so nothing goes.
function forgeGuard(
  name: string,
  forge: string,
  host: string | undefined,
  observation: ForgeObservation | undefined,
): Action | undefined {
  if (observation?.reachable === true) {
    return undefined;
  }
  return {
    kind: 'report-degraded',
    target: name,
    ...(host === undefined ? {} : { host }),
    reason:
      observation === undefined
        ? `forge "${forge}" was not observed on this pass, so grove leaves this runner in place`
        : `forge "${forge}" did not answer, so grove leaves this runner in place`,
    destructive: false,
  };
}

export interface TeardownOptions {
  includeUnmanaged?: boolean;
  drainTimeoutMs?: number;
  // The rows that hold each group's shared token, retired with the entity.
  registrations?: GroupRegistrationRecord[];
}

/**
 * Teardown is not apply with an empty config. It ignores what the config
 * wants and removes what grove owns, which is the managed column of the
 * ownership table. `includeUnmanaged` extends it to a name that matches with
 * no record behind it, and it is off by default because a name collision is
 * not consent.
 */
export function planTeardown(
  desired: GroveConfig,
  observed: ObservedState,
  records: RunnerRecord[],
  options: TeardownOptions = {},
): Action[] {
  const includeUnmanaged = options.includeUnmanaged === true;
  const fallbackDrain = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const drainByGroup = new Map(
    desired.groups.map((group) => [
      group.name,
      group.drain_timeout ?? fallbackDrain,
    ]),
  );
  const hosts = new Map(observed.hosts.map((entry) => [entry.host, entry]));
  const forges = new Map(observed.forges.map((entry) => [entry.forge, entry]));
  // A forge that gives a whole group one entity. The config says so, and a
  // forge whose kind changed under a running fleet is caught by what the
  // observation itself reported.
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
  // Runner names whose whole removal sequence made it into the plan. Only a
  // group where every one of those made it may lose its entity.
  const tornDown = new Set<string>();

  const degraded: Action[] = [];
  const removals: Action[] = [];
  const reports: Action[] = [];

  for (const entry of observed.hosts) {
    if (!entry.reachable) {
      degraded.push({
        kind: 'report-degraded',
        target: entry.host,
        host: entry.host,
        reason: entry.reason ?? 'unreachable',
        destructive: false,
      });
    }
  }
  for (const entry of observed.forges) {
    if (!entry.reachable) {
      degraded.push({
        kind: 'report-degraded',
        target: entry.forge,
        reason: entry.reason ?? 'the forge did not answer',
        destructive: false,
      });
    }
  }

  // A host or a forge that did not answer is dropped here, so silence never
  // reads as absence and grove never deletes half of what it cannot see.
  const seen = flattenObserved(observed, {
    skipUnreachable: true,
    records,
  });

  for (const entry of classifyRunners(seen, records)) {
    if (entry.ownership === 'foreign') {
      continue;
    }

    if (entry.ownership === 'record-only') {
      const host = entry.record?.host;
      const observation = host === undefined ? undefined : hosts.get(host);
      if (observation === undefined || !observation.reachable) {
        degraded.push({
          kind: 'report-degraded',
          target: entry.name,
          ...(host === undefined ? {} : { host }),
          reason: `host "${host ?? 'unknown'}" is unreachable, so grove leaves this record alone`,
          destructive: false,
        });
        continue;
      }
      // Nothing was seen anywhere, and only the supervisor the record names
      // can turn that into absence. While it is blind the record stays.
      const blind = hostStackError(
        observation,
        entry.record?.stack ?? 'docker',
      );
      if (blind !== undefined) {
        degraded.push({
          kind: 'report-degraded',
          target: entry.name,
          ...(host === undefined ? {} : { host }),
          reason: blind,
          destructive: false,
        });
        continue;
      }
      const recordForge = entry.record?.forge;
      if (recordForge !== undefined) {
        const blocked = forgeGuard(
          entry.name,
          recordForge,
          host,
          forges.get(recordForge),
        );
        if (blocked !== undefined) {
          degraded.push(blocked);
          continue;
        }
      }
      reports.push({
        kind: 'report-orphan-record',
        name: entry.name,
        recordId: entry.record?.id ?? 0,
        ...(host === undefined ? {} : { host }),
        reason:
          'the record has no container and no forge runner, so there is nothing to tear down',
        destructive: false,
      });
      continue;
    }

    if (!isDestroyable(entry, includeUnmanaged)) {
      reports.push({
        kind: 'report-unmanaged',
        name: entry.name,
        where: describeWhere(entry),
        ...(entry.host === undefined ? {} : { host: entry.host }),
        destructive: false,
      });
      continue;
    }

    // The record carries the host a forge-only sighting cannot. A runner grove
    // has a record for always has one, so an unreachable host below stops the
    // deregistration too, rather than stranding a container nobody can find.
    const host = entry.host ?? entry.record?.host;
    // The host is authoritative, so a sighting decides which stack this seat
    // runs on. A seat with no sighting is read through the supervisor its
    // record names, because that is the only one that can prove it is gone.
    const stack: StackKind =
      entry.native !== undefined
        ? 'native'
        : entry.container !== undefined
          ? 'docker'
          : (entry.record?.stack ?? 'docker');
    const present = entry.native !== undefined || entry.container !== undefined;
    if (host !== undefined) {
      const observation = hosts.get(host);
      if (observation === undefined || !observation.reachable) {
        degraded.push({
          kind: 'report-degraded',
          target: entry.name,
          host,
          reason:
            observation === undefined
              ? `host "${host}" was not observed on this pass, so grove leaves this runner and its forge record alone`
              : `host "${host}" is unreachable, so grove leaves this runner and its forge record alone`,
          destructive: false,
        });
        continue;
      }
      // Only this seat's own supervisor holds the removal back. The other one
      // can be blind without saying anything about this seat.
      const blind = hostStackError(observation, stack);
      if (blind !== undefined) {
        degraded.push({
          kind: 'report-degraded',
          target: entry.name,
          host,
          reason: blind,
          destructive: false,
        });
        continue;
      }
    }

    // A runner seen only at a forge may well be a container on a host that
    // did not answer. grove cannot tell those two apart, and deregistering
    // costs a working runner its registration, so this only goes ahead when
    // every host in the config answered.
    if (host === undefined) {
      const silent = Object.keys(desired.hosts).some((name) => {
        const observation = hosts.get(name);
        return observation === undefined || !observation.reachable;
      });
      if (silent) {
        degraded.push({
          kind: 'report-degraded',
          target: entry.name,
          reason: `host unknown and at least one host did not answer, so grove leaves runner "${entry.name}" alone`,
          destructive: false,
        });
        continue;
      }
    }

    const forge = entry.forge ?? entry.record?.forge;
    if (forge !== undefined) {
      const blocked = forgeGuard(entry.name, forge, host, forges.get(forge));
      if (blocked !== undefined) {
        degraded.push(blocked);
        continue;
      }
    }

    const drainTimeoutMs = drainByGroup.get(entry.group ?? '') ?? fallbackDrain;

    if (present && host !== undefined) {
      removals.push({
        kind: 'stop-container',
        host,
        name: entry.name,
        ...(stack === 'native' ? { stack } : {}),
        ...(entry.record === undefined ? {} : { recordId: entry.record.id }),
        drainTimeoutMs,
        destructive: true,
      });
    }
    // A shared forge hands the whole group one entity, and no manager of it
    // has a registration of its own to drop. The entity pass below is what
    // removes it, once every manager has gone.
    if (
      entry.forgeRunner !== undefined &&
      entry.scope !== undefined &&
      !(entry.forge !== undefined && sharedForges.has(entry.forge))
    ) {
      // A sighting always carries the forge it came from. Deleting at the
      // wrong forge is unrecoverable, so a missing name is a bug that stops
      // the pass rather than a blank that travels into the action.
      if (entry.forge === undefined) {
        throw new Error(
          `runner "${entry.name}" was seen at a forge grove cannot name`,
        );
      }
      removals.push({
        kind: 'deregister-runner',
        // Without a host the action runs in the forge bucket of its own. That
        // is the runner that lives only at the forge, so nothing on a host
        // has to happen before it.
        ...(host === undefined ? {} : { host }),
        forge: entry.forge,
        scope: entry.scope,
        name: entry.name,
        forgeRunnerId: entry.forgeRunner.id,
        ...(entry.record === undefined ? {} : { recordId: entry.record.id }),
        destructive: true,
      });
    }
    if (present && host !== undefined) {
      removals.push({
        kind: 'remove-container',
        host,
        name: entry.name,
        ...(stack === 'native' ? { stack } : {}),
        ...(entry.record === undefined ? {} : { recordId: entry.record.id }),
        destructive: true,
      });
    }
    if (entry.record !== undefined) {
      removals.push({
        kind: 'retire-record',
        ...(host === undefined ? {} : { host }),
        name: entry.name,
        recordId: entry.record.id,
        destructive: true,
      });
    }
    tornDown.add(entry.name);
  }

  // The entity goes after every manager, and only when every manager went.
  for (const observation of observed.forges) {
    if (observation.shared !== true || !observation.reachable) {
      continue;
    }
    for (const entity of sharedEntities(observation, records)) {
      const registration = registrationByGroup.get(
        groupForgeKey(entity.group, entity.forge),
      );
      // Only a row naming this entity belongs to it. A row for the group
      // that names another id holds that other entity's token, and GitLab
      // shows a glrt token once, so retiring it here would lose the only
      // copy of a token grove still needs.
      const ownRegistration =
        registration?.forgeRunnerId === entity.runner.id
          ? registration
          : undefined;
      // A record pointing at the entity, or such a row, proves grove minted it.
      const owned = entity.records.length > 0 || ownRegistration !== undefined;

      if (!owned && !includeUnmanaged) {
        // Name matches the convention, nothing backs it. The unmanaged cell,
        // which a name collision alone never opens.
        reports.push({
          kind: 'report-unmanaged',
          name: entity.runner.name,
          where: `runner entity ${entity.runner.id} at ${entity.forge}`,
          destructive: false,
        });
        continue;
      }
      if (
        owned &&
        !entity.records.every((record) => tornDown.has(record.name))
      ) {
        degraded.push({
          kind: 'report-degraded',
          target: entity.runner.name,
          reason: `grove could not tear down every manager of group "${entity.group}", so its runner entity at ${entity.forge} stays`,
          destructive: false,
        });
        continue;
      }

      // The highest-index seat, so the delete queues behind that host's own
      // removals. An entity with no seat left runs in a bucket of its own.
      const last = entity.records.at(-1);
      removals.push({
        kind: 'delete-shared-runner',
        ...(last === undefined ? {} : { host: last.host }),
        forge: entity.forge,
        scope: entity.scope,
        group: entity.group,
        name: entity.runner.name,
        forgeRunnerId: entity.runner.id,
        ...(ownRegistration === undefined
          ? {}
          : { registrationId: ownRegistration.id }),
        destructive: true,
      });
    }
  }

  return [...degraded, ...removals, ...reports];
}
