import type { LoadedConfig } from '../config/index.js';
import {
  classifyRunners,
  flattenObserved,
  type ObservedState,
  type OwnershipClass,
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
  ownership: OwnershipClass;
  recordId?: number;
}

export interface StatusReport {
  configPath: string;
  rows: StatusRow[];
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
  const seen = flattenObserved(observed, { skipUnreachable: false });

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
    rows.push({
      group: entry.group ?? entry.record?.group ?? '-',
      host: entry.host ?? entry.record?.host ?? '-',
      runner: entry.name,
      container: entry.container?.state ?? 'missing',
      containerStatus: entry.container?.status ?? '',
      forge: entry.forge ?? entry.record?.forge ?? '-',
      forgeStatus,
      ownership: entry.ownership,
      recordId: entry.record?.id,
    });
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
