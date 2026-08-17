import type { LoadedConfig, StackKind } from '../config/index.js';
import {
  classifyRunners,
  flattenObserved,
  type ObservedState,
  type OwnershipClass,
  sharedEntities,
} from '../reconcile/index.js';
import type { HostStorage } from '../stack/index.js';
import type { LivenessState, RunnerRecord } from '../state/index.js';

export interface StatusRow {
  group: string;
  host: string;
  runner: string;
  // Which stack runs this seat. A record with nothing behind it takes the
  // stack its group declares, because that is what grove would create.
  stack: StackKind;
  // What the host runs: a container state, or a native unit state, or
  // `missing` when the host has neither.
  process: string;
  // What the host said about it, for example `Up 3 hours` or `pid 4242`.
  detail: string;
  forge: string;
  forgeStatus: 'online' | 'offline' | 'busy' | 'unknown';
  // Set for a runner whose forge runs one entity with many managers, and only
  // once grove has read the container's system id off the host.
  systemId?: string;
  // The raw GitLab word, because stale and offline are different problems.
  managerStatus?: string;
  contactedAt?: string;
  ownership: OwnershipClass;
  recordId?: number;
}

export interface SharedRunnerRow {
  forge: string;
  group: string;
  entityId: string;
  description: string;
  tags: string[];
  managers: number;
  // What the config asks for, so a mismatch is visible without arithmetic.
  expected: number;
}

export interface SuspectRow {
  runner: string;
  host: string;
  since: number;
  reason: string;
}

// What the control loop is doing, read from the lockfile and the meta table
// rather than derived from anything grove observed on this run.
export interface DaemonStatus {
  lockPath: string;
  pid?: number;
  command?: string;
  alive: boolean;
  lastFastTick?: number;
  lastFullTick?: number;
}

export interface StatusReportOptions {
  suspects?: SuspectRow[];
  daemon?: DaemonStatus;
  // Measured by the caller, because it costs two commands per host and only
  // `status` is willing to spend them.
  storage?: HostStorage[];
}

export interface StatusReport {
  configPath: string;
  rows: StatusRow[];
  sharedRunners: SharedRunnerRow[];
  suspects: SuspectRow[];
  daemon?: DaemonStatus;
  storage: HostStorage[];
  unreachableHosts: string[];
  unreachableForges: string[];
  ok: boolean;
}

export function buildStatusReport(
  loaded: LoadedConfig,
  observed: ObservedState,
  records: RunnerRecord[],
  options: StatusReportOptions = {},
): StatusReport {
  // Status only reports, it never decides what to destroy, so it keeps
  // whatever grove last knew about an unreachable host or forge instead of
  // dropping it.
  const seen = flattenObserved(observed, {
    skipUnreachable: false,
    records,
  });

  const stackByGroup = new Map(
    loaded.config.groups.map((group) => [group.name, group.stack]),
  );

  const rows: StatusRow[] = [];
  for (const entry of classifyRunners(seen, records)) {
    if (entry.ownership === 'foreign') {
      continue;
    }
    const forgeStatus =
      entry.forgeRunner === undefined
        ? ('unknown' as const)
        : entry.forgeRunner.busy
          ? ('busy' as const)
          : entry.forgeRunner.status;
    // The expansion attaches exactly the manager that belongs to this
    // runner, and nothing when grove cannot yet prove which one that is.
    const manager = entry.forgeRunner?.managers?.[0];
    const group = entry.group ?? entry.record?.group ?? '-';
    rows.push({
      group,
      host: entry.host ?? entry.record?.host ?? '-',
      runner: entry.name,
      // A sighting names its own stack. A record with nothing behind it
      // remembers the stack it was created on, and a record grove has never
      // seen falls back to what the group declares today.
      stack:
        entry.native !== undefined
          ? 'native'
          : entry.container !== undefined
            ? 'docker'
            : (entry.record?.stack ?? stackByGroup.get(group) ?? 'docker'),
      process: entry.native?.state ?? entry.container?.state ?? 'missing',
      detail: entry.native?.detail ?? entry.container?.status ?? '',
      forge: entry.forge ?? entry.record?.forge ?? '-',
      forgeStatus,
      ...(manager === undefined
        ? {}
        : {
            systemId: manager.systemId,
            managerStatus: manager.status,
            ...(manager.contactedAt === undefined
              ? {}
              : { contactedAt: manager.contactedAt }),
          }),
      ownership: entry.ownership,
      recordId: entry.record?.id,
    });
  }

  const expectedByGroup = new Map(
    loaded.config.groups.map((group) => [
      group.name,
      Object.values(group.placement).reduce((sum, count) => sum + count, 0),
    ]),
  );

  const sharedRunners: SharedRunnerRow[] = [];
  for (const observation of observed.forges) {
    if (observation.shared !== true) {
      continue;
    }
    for (const entity of sharedEntities(observation, records)) {
      sharedRunners.push({
        forge: entity.forge,
        group: entity.group,
        entityId: entity.runner.id,
        description: entity.runner.name,
        tags: entity.runner.labels,
        managers: (entity.runner.managers ?? []).length,
        expected: expectedByGroup.get(entity.group) ?? 0,
      });
    }
  }

  const unreachableHosts = observed.hosts
    .filter((host) => !host.reachable)
    .map((host) => host.host);
  const unreachableForges = observed.forges
    .filter((forge) => !forge.reachable)
    .map((forge) => forge.forge);

  return {
    configPath: loaded.path,
    rows,
    sharedRunners,
    suspects: options.suspects ?? [],
    ...(options.daemon === undefined ? {} : { daemon: options.daemon }),
    storage: options.storage ?? [],
    unreachableHosts,
    unreachableForges,
    ok: unreachableHosts.length === 0 && unreachableForges.length === 0,
  };
}

export function livenessFor(row: StatusRow): LivenessState {
  if (row.forgeStatus === 'busy') {
    return 'busy';
  }
  if (row.process === 'missing') {
    return 'missing';
  }
  return row.process === 'running' && row.forgeStatus === 'online'
    ? 'online'
    : 'offline';
}

/**
 * Liveness from the host alone. The fast tick calls no forge, so every row it
 * builds reads `unknown` at the forge, and `livenessFor` would call a running
 * seat offline. This says only what the host said, which is what the fast
 * tick actually knows.
 */
export function hostLivenessFor(row: StatusRow): LivenessState {
  if (row.process === 'missing') {
    return 'missing';
  }
  return row.process === 'running' ? 'online' : 'offline';
}
