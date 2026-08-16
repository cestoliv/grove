import type { LoadedConfig } from '../config/index.js';
import {
  classifyRunners,
  flattenObserved,
  type ObservedState,
  type OwnershipClass,
  sharedEntities,
} from '../reconcile/index.js';
import type { LivenessState, RunnerRecord } from '../state/index.js';

export interface StatusRow {
  group: string;
  host: string;
  runner: string;
  container: string;
  containerStatus: string;
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

export interface StatusReport {
  configPath: string;
  rows: StatusRow[];
  sharedRunners: SharedRunnerRow[];
  unreachableHosts: string[];
  unreachableForges: string[];
  ok: boolean;
}

export function buildStatusReport(
  loaded: LoadedConfig,
  observed: ObservedState,
  records: RunnerRecord[],
): StatusReport {
  // Status only reports, it never decides what to destroy, so it keeps
  // whatever grove last knew about an unreachable host or forge instead of
  // dropping it.
  const seen = flattenObserved(observed, {
    skipUnreachable: false,
    records,
  });

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
    rows.push({
      group: entry.group ?? entry.record?.group ?? '-',
      host: entry.host ?? entry.record?.host ?? '-',
      runner: entry.name,
      container: entry.container?.state ?? 'missing',
      containerStatus: entry.container?.status ?? '',
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
    unreachableHosts,
    unreachableForges,
    ok: unreachableHosts.length === 0 && unreachableForges.length === 0,
  };
}

export function livenessFor(row: StatusRow): LivenessState {
  if (row.forgeStatus === 'busy') {
    return 'busy';
  }
  if (row.container === 'missing') {
    return 'missing';
  }
  return row.container === 'running' && row.forgeStatus === 'online'
    ? 'online'
    : 'offline';
}
