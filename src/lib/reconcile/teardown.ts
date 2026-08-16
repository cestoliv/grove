import type { GroveConfig } from '../config/index.js';
import { DEFAULT_DRAIN_TIMEOUT_MS } from '../stack/index.js';
import type { RunnerRecord } from '../state/index.js';
import type { Action } from './actions.js';
import {
  describeWhere,
  type ForgeObservation,
  flattenObserved,
  type ObservedState,
} from './observed.js';
import { classifyRunners, isDestroyable } from './ownership.js';

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
  const seen = flattenObserved(observed, { skipUnreachable: true });

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

    if (entry.container !== undefined && host !== undefined) {
      removals.push({
        kind: 'stop-container',
        host,
        name: entry.name,
        ...(entry.record === undefined ? {} : { recordId: entry.record.id }),
        drainTimeoutMs,
        destructive: true,
      });
    }
    if (entry.forgeRunner !== undefined && entry.scope !== undefined) {
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
    if (entry.container !== undefined && host !== undefined) {
      removals.push({
        kind: 'remove-container',
        host,
        name: entry.name,
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
  }

  return [...degraded, ...removals, ...reports];
}
