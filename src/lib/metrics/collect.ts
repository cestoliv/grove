import type { GroveConfig } from '../config/index.js';
import type { HostStorage } from '../stack/index.js';
import {
  type LivenessState,
  META_DAEMON_PID,
  META_LAST_FAST_TICK,
  META_LAST_FULL_TICK,
  type StateStore,
} from '../state/index.js';
import {
  livenessFor,
  type StatusReport,
  type StatusRow,
} from '../status/report.js';
import type { MetricFamily, MetricSample } from './format.js';

// How long the last tick of each kind took. The tick stamps already exist in
// meta; these say whether a fleet is getting slower.
export const META_LAST_FAST_TICK_MS = 'last_fast_tick_ms';
export const META_LAST_FULL_TICK_MS = 'last_full_tick_ms';

export interface MetricsSnapshot {
  at: number;
  hosts: Array<{ host: string; reachable: boolean }>;
  forges: Array<{ forge: string; reachable: boolean }>;
  runners: Array<{
    group: string;
    host: string;
    forge: string;
    runner: string;
    // Wider than what the store records, because a snapshot also covers seats
    // grove could not observe at all.
    state: LivenessState | 'unknown';
  }>;
  expected: Array<{ group: string; host: string; count: number }>;
  suspects: number;
}

export interface SnapshotOptions {
  at: number;
  // The tick decides per row whether that row's forge answered, so it passes
  // its own reading rather than having this file guess.
  liveness?: (row: StatusRow) => LivenessState;
}

export function snapshotFromStatus(
  report: StatusReport,
  config: GroveConfig,
  options: SnapshotOptions,
): MetricsSnapshot {
  const reading = options.liveness ?? livenessFor;
  const downHosts = new Set(report.unreachableHosts);
  const downForges = new Set(report.unreachableForges);
  const expected: MetricsSnapshot['expected'] = [];
  for (const group of config.groups) {
    for (const [host, count] of Object.entries(group.placement)) {
      expected.push({ group: group.name, host, count });
    }
  }
  return {
    at: options.at,
    hosts: Object.keys(config.hosts).map((host) => ({
      host,
      reachable: !downHosts.has(host),
    })),
    forges: Object.keys(config.forges).map((forge) => ({
      forge,
      reachable: !downForges.has(forge),
    })),
    runners: report.rows.map((row) => ({
      group: row.group,
      host: row.host,
      forge: row.forge,
      runner: row.runner,
      // A host that did not answer said nothing about its seats. `missing`
      // would claim the container is gone, which grove never observed, and an
      // alert on it would fire once per seat for one host outage.
      state: downHosts.has(row.host) ? ('unknown' as const) : reading(row),
    })),
    expected,
    suspects: report.suspects.length,
  };
}

export interface StoreMetrics {
  restarts: Array<{ group: string; count: number }>;
  jobs: Array<{ group: string; outcome: string; count: number }>;
  lastFastTick?: number;
  lastFullTick?: number;
  lastFastMs?: number;
  lastFullMs?: number;
  daemonRunning: boolean;
}

function readNumber(store: StateStore, key: string): number | undefined {
  const raw = store.getMeta(key);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function readStoreMetrics(
  store: StateStore,
  isPidAlive: (pid: number) => boolean,
): StoreMetrics {
  // Keyed by group through the active records, so a retired seat's history
  // stops being counted. That is a counter reset, and it is the honest
  // answer: the seat no longer exists.
  const groupOf = new Map(
    store.activeRunners().map((record) => [record.id, record.group]),
  );

  const restarts = new Map<string, number>();
  for (const row of store.restartCounts()) {
    const group = groupOf.get(row.runnerId);
    if (group === undefined) {
      continue;
    }
    restarts.set(group, (restarts.get(group) ?? 0) + row.count);
  }

  const jobs = new Map<
    string,
    { group: string; outcome: string; count: number }
  >();
  for (const row of store.jobOutcomeCounts()) {
    const group = groupOf.get(row.runnerId);
    if (group === undefined) {
      continue;
    }
    const key = JSON.stringify([group, row.outcome]);
    const seen = jobs.get(key);
    jobs.set(key, {
      group,
      outcome: row.outcome,
      count: (seen?.count ?? 0) + row.count,
    });
  }

  const pid = readNumber(store, META_DAEMON_PID);
  const lastFastTick = readNumber(store, META_LAST_FAST_TICK);
  const lastFullTick = readNumber(store, META_LAST_FULL_TICK);
  const lastFastMs = readNumber(store, META_LAST_FAST_TICK_MS);
  const lastFullMs = readNumber(store, META_LAST_FULL_TICK_MS);

  return {
    restarts: [...restarts.entries()].map(([group, count]) => ({
      group,
      count,
    })),
    jobs: [...jobs.values()],
    ...(lastFastTick === undefined ? {} : { lastFastTick }),
    ...(lastFullTick === undefined ? {} : { lastFullTick }),
    ...(lastFastMs === undefined ? {} : { lastFastMs }),
    ...(lastFullMs === undefined ? {} : { lastFullMs }),
    daemonRunning:
      pid !== undefined && Number.isInteger(pid) && pid > 0 && isPidAlive(pid),
  };
}

/**
 * What the tick publishes and the exporter reads. Two slots rather than one,
 * because a fast tick observes the fleet and measures no storage, and the
 * last measurement should stay rather than disappear for 28 minutes.
 */
export class MetricsState {
  private current?: MetricsSnapshot;
  private lastStorage: HostStorage[] = [];

  // Both readers hand out a copy. The tick owns what it published, and a
  // scrape that sorted or spliced the array it was given would corrupt what
  // the next one reads.
  snapshot(): MetricsSnapshot | undefined {
    return this.current === undefined
      ? undefined
      : {
          ...this.current,
          hosts: [...this.current.hosts],
          forges: [...this.current.forges],
          runners: [...this.current.runners],
          expected: [...this.current.expected],
        };
  }

  storage(): HostStorage[] {
    return [...this.lastStorage];
  }

  setSnapshot(snapshot: MetricsSnapshot): void {
    this.current = snapshot;
  }

  setStorage(storage: HostStorage[]): void {
    this.lastStorage = storage;
  }
}

export interface BuildFamiliesInput {
  snapshot?: MetricsSnapshot;
  storage: HostStorage[];
  store: StoreMetrics;
  version: string;
  now: number;
}

function gauge(
  name: string,
  help: string,
  samples: MetricSample[],
): MetricFamily {
  return { name, type: 'gauge', help, samples };
}

function counter(
  name: string,
  help: string,
  samples: MetricSample[],
): MetricFamily {
  return { name, type: 'counter', help, samples };
}

export function buildFamilies(input: BuildFamiliesInput): MetricFamily[] {
  const { snapshot, storage, store } = input;
  const families: MetricFamily[] = [
    gauge('grove_build_info', 'The grove version this exporter runs.', [
      { labels: { version: input.version }, value: 1 },
    ]),
    gauge('grove_up', 'Always 1 while the exporter answers.', [{ value: 1 }]),
  ];

  if (snapshot !== undefined) {
    families.push(
      gauge(
        'grove_snapshot_age_seconds',
        'How long ago the tick that produced these fleet gauges ran.',
        [{ value: Math.max(0, Math.round((input.now - snapshot.at) / 1000)) }],
      ),
      gauge(
        'grove_host_reachable',
        'Whether the host answered on the last tick.',
        snapshot.hosts.map((host) => ({
          labels: { host: host.host },
          value: host.reachable ? 1 : 0,
        })),
      ),
      gauge(
        'grove_forge_reachable',
        'Whether the forge answered on the last full tick.',
        snapshot.forges.map((forge) => ({
          labels: { forge: forge.forge },
          value: forge.reachable ? 1 : 0,
        })),
      ),
    );

    const byState = new Map<
      string,
      {
        group: string;
        host: string;
        forge: string;
        state: string;
        value: number;
      }
    >();
    for (const seat of snapshot.runners) {
      const key = JSON.stringify([
        seat.group,
        seat.host,
        seat.forge,
        seat.state,
      ]);
      const seen = byState.get(key);
      byState.set(key, {
        group: seat.group,
        host: seat.host,
        forge: seat.forge,
        state: seat.state,
        value: (seen?.value ?? 0) + 1,
      });
    }
    families.push(
      gauge(
        'grove_runners',
        'Managed seats by group, host, forge and state.',
        [...byState.values()].map((entry) => ({
          labels: {
            group: entry.group,
            host: entry.host,
            forge: entry.forge,
            state: entry.state,
          },
          value: entry.value,
        })),
      ),
      gauge(
        'grove_runners_expected',
        'Seats the config asks for, by group and host.',
        snapshot.expected.map((entry) => ({
          labels: { group: entry.group, host: entry.host },
          value: entry.count,
        })),
      ),
      gauge(
        'grove_suspect_runners',
        'Seats one stuck signal agrees about, which grove reports and does not act on.',
        [{ value: snapshot.suspects }],
      ),
    );
  }

  families.push(
    gauge(
      'grove_daemon_running',
      'Whether the control loop is running on this node.',
      [{ value: store.daemonRunning ? 1 : 0 }],
    ),
  );

  const stamps: MetricSample[] = [];
  if (store.lastFastTick !== undefined) {
    stamps.push({
      labels: { kind: 'fast' },
      value: Math.round(store.lastFastTick / 1000),
    });
  }
  if (store.lastFullTick !== undefined) {
    stamps.push({
      labels: { kind: 'full' },
      value: Math.round(store.lastFullTick / 1000),
    });
  }
  families.push(
    gauge(
      'grove_last_tick_timestamp_seconds',
      'When each tick last ran.',
      stamps,
    ),
  );

  const durations: MetricSample[] = [];
  if (store.lastFastMs !== undefined) {
    durations.push({
      labels: { kind: 'fast' },
      value: store.lastFastMs / 1000,
    });
  }
  if (store.lastFullMs !== undefined) {
    durations.push({
      labels: { kind: 'full' },
      value: store.lastFullMs / 1000,
    });
  }
  families.push(
    gauge(
      'grove_tick_duration_seconds',
      'How long the last tick of each kind took.',
      durations,
    ),
  );

  families.push(
    counter(
      'grove_restarts_total',
      'Restarts grove made, over retained history.',
      store.restarts.map((entry) => ({
        labels: { group: entry.group },
        value: entry.count,
      })),
    ),
    counter(
      'grove_jobs_total',
      'Jobs seen, by group and outcome, over retained history.',
      store.jobs.map((entry) => ({
        labels: { group: entry.group, outcome: entry.outcome },
        value: entry.count,
      })),
    ),
  );

  const withDocker = storage.filter((host) => host.docker !== undefined);
  families.push(
    gauge(
      'grove_image_store_bytes',
      'Bytes the Docker image store takes on the host.',
      withDocker.map((host) => ({
        labels: { host: host.host },
        value: host.docker?.imagesBytes ?? 0,
      })),
    ),
    gauge(
      'grove_image_store_reclaimable_bytes',
      'Bytes docker image prune would free on the host.',
      withDocker.map((host) => ({
        labels: { host: host.host },
        value: host.docker?.imagesReclaimableBytes ?? 0,
      })),
    ),
    gauge(
      'grove_host_work_dir_bytes',
      'Bytes every managed work dir takes on the host.',
      storage
        .filter((host) => host.workDirBytes !== undefined)
        .map((host) => ({
          labels: { host: host.host },
          value: host.workDirBytes ?? 0,
        })),
    ),
    gauge(
      'grove_work_dir_bytes',
      'Bytes one seat work dir takes.',
      storage.flatMap((host) =>
        host.workDirs.map((seat) => ({
          labels: { host: host.host, runner: seat.name },
          value: seat.bytes,
        })),
      ),
    ),
  );

  return families;
}
