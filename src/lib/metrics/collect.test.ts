import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import type { HostStorage } from '../stack/index.js';
import {
  META_DAEMON_PID,
  META_LAST_FAST_TICK,
  META_LAST_FULL_TICK,
  StateStore,
} from '../state/index.js';
import type { StatusReport } from '../status/report.js';
import {
  buildFamilies,
  META_LAST_FULL_TICK_MS,
  MetricsState,
  readStoreMetrics,
  snapshotFromStatus,
} from './collect.js';
import { renderExposition } from './format.js';

const CONFIG: GroveConfig = {
  tick: { fast: 120_000, full: 1_800_000 },
  hosts: { mac: { type: 'local' } },
  forges: { gh: { kind: 'github' } },
  groups: [
    {
      name: 'arm',
      forge: 'gh',
      scope: { level: 'organization', target: 'Acme' },
      placement: { mac: 2 },
      stack: 'docker',
    },
  ],
} as unknown as GroveConfig;

const REPORT: StatusReport = {
  configPath: '/x/grove.yaml',
  rows: [
    {
      group: 'arm',
      host: 'mac',
      runner: 'grove-arm-1',
      stack: 'docker',
      process: 'running',
      detail: 'Up 1 hour',
      forge: 'gh',
      forgeStatus: 'online',
      ownership: 'managed',
      recordId: 1,
    },
    {
      group: 'arm',
      host: 'mac',
      runner: 'grove-arm-2',
      stack: 'docker',
      process: 'missing',
      detail: '',
      forge: 'gh',
      forgeStatus: 'unknown',
      ownership: 'managed',
      recordId: 2,
    },
  ],
  sharedRunners: [],
  suspects: [
    { runner: 'grove-arm-1', host: 'mac', since: 1, reason: 'busy too long' },
  ],
  unreachableHosts: [],
  unreachableForges: ['gh'],
  ok: false,
} as unknown as StatusReport;

describe('snapshotFromStatus', () => {
  it('carries the hosts, the forges, the seats and what the config expects', () => {
    const snapshot = snapshotFromStatus(REPORT, CONFIG, { at: 1_700_000_000 });
    expect(snapshot.at).toBe(1_700_000_000);
    expect(snapshot.hosts).toEqual([{ host: 'mac', reachable: true }]);
    expect(snapshot.forges).toEqual([{ forge: 'gh', reachable: false }]);
    expect(snapshot.expected).toEqual([
      { group: 'arm', host: 'mac', count: 2 },
    ]);
    expect(snapshot.suspects).toBe(1);
    expect(snapshot.runners).toEqual([
      {
        group: 'arm',
        host: 'mac',
        forge: 'gh',
        runner: 'grove-arm-1',
        state: 'online',
      },
      {
        group: 'arm',
        host: 'mac',
        forge: 'gh',
        runner: 'grove-arm-2',
        state: 'missing',
      },
    ]);
  });

  it('calls a seat on a host that did not answer unknown', () => {
    const snapshot = snapshotFromStatus(
      { ...REPORT, unreachableHosts: ['mac'] },
      CONFIG,
      { at: 1 },
    );
    // Not `missing`: grove never looked at the container, so it has no reading
    // to publish and says so.
    expect(snapshot.runners.map((seat) => seat.state)).toEqual([
      'unknown',
      'unknown',
    ]);
    expect(snapshot.hosts).toEqual([{ host: 'mac', reachable: false }]);
  });

  it('takes the liveness reading the caller gives it', () => {
    const snapshot = snapshotFromStatus(REPORT, CONFIG, {
      at: 1,
      liveness: () => 'online',
    });
    expect(snapshot.runners.every((seat) => seat.state === 'online')).toBe(
      true,
    );
  });
});

describe('readStoreMetrics', () => {
  it('reads the counters, the tick stamps and whether the daemon is running', () => {
    const store = StateStore.open(':memory:');
    try {
      const runner = store.createRunner({
        group: 'arm',
        index: 1,
        host: 'mac',
        forge: 'gh',
        name: 'grove-arm-1',
      });
      store.recordEvent(runner.id, 'restarted', 'stuck');
      store.startJob(runner.id, 1);
      store.endJob(runner.id, 'unknown', 2);
      store.setMeta(META_LAST_FAST_TICK, '1700000000000');
      store.setMeta(META_LAST_FULL_TICK, '1700000000000');
      store.setMeta(META_LAST_FULL_TICK_MS, '4200');
      store.setMeta(META_DAEMON_PID, '4242');

      const metrics = readStoreMetrics(store, () => true);
      expect(metrics.restarts).toEqual([{ group: 'arm', count: 1 }]);
      expect(metrics.jobs).toEqual([
        { group: 'arm', outcome: 'unknown', count: 1 },
      ]);
      expect(metrics.lastFullTick).toBe(1_700_000_000_000);
      expect(metrics.lastFullMs).toBe(4200);
      expect(metrics.daemonRunning).toBe(true);
    } finally {
      store.close();
    }
  });

  it('calls the daemon not running when its pid is gone', () => {
    const store = StateStore.open(':memory:');
    try {
      store.setMeta(META_DAEMON_PID, '4242');
      expect(readStoreMetrics(store, () => false).daemonRunning).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('MetricsState', () => {
  it('holds the last snapshot and the last storage separately', () => {
    const state = new MetricsState();
    expect(state.snapshot()).toBeUndefined();
    expect(state.storage()).toEqual([]);

    const snapshot = snapshotFromStatus(REPORT, CONFIG, { at: 1 });
    state.setSnapshot(snapshot);
    state.setStorage([{ host: 'mac', workDirs: [] }]);
    expect(state.snapshot()).toEqual(snapshot);
    expect(state.storage()).toHaveLength(1);

    // A copy on every read. The tick owns what it published, and a reader that
    // sorted or spliced the array it was handed would corrupt the next scrape.
    state.storage().push({ host: 'ghost', workDirs: [] });
    state.snapshot()?.runners.pop();
    expect(state.storage()).toHaveLength(1);
    expect(state.snapshot()?.runners).toHaveLength(2);

    // A fast tick publishes a snapshot and measures no storage, and the last
    // measurement stays rather than disappearing for 28 minutes.
    state.setSnapshot(snapshotFromStatus(REPORT, CONFIG, { at: 2 }));
    expect(state.storage()).toHaveLength(1);
  });
});

describe('buildFamilies', () => {
  const storage: HostStorage[] = [
    {
      host: 'mac',
      docker: {
        imagesBytes: 4_000_000_000,
        imagesReclaimableBytes: 1_000_000_000,
        containersBytes: 1,
        volumesBytes: 2,
        buildCacheBytes: 3,
      },
      workDirBytes: 2048,
      workDirs: [{ name: 'grove-arm-1', bytes: 2048 }],
    },
  ];

  function text(): string {
    return renderExposition(
      buildFamilies({
        snapshot: snapshotFromStatus(REPORT, CONFIG, { at: 1_700_000_000_000 }),
        storage,
        store: {
          restarts: [{ group: 'arm', count: 3 }],
          jobs: [{ group: 'arm', outcome: 'unknown', count: 7 }],
          lastFastTick: 1_700_000_000_000,
          lastFullTick: 1_699_999_000_000,
          lastFastMs: 900,
          lastFullMs: 4200,
          daemonRunning: true,
        },
        version: '0.1.0',
        now: 1_700_000_030_000,
      }),
    );
  }

  it('publishes the build info and grove_up', () => {
    expect(text()).toContain('grove_build_info{version="0.1.0"} 1');
    expect(text()).toContain('grove_up 1');
  });

  it('publishes the seats by state against what the config expects', () => {
    expect(text()).toContain(
      'grove_runners{group="arm",host="mac",forge="gh",state="online"} 1',
    );
    expect(text()).toContain(
      'grove_runners{group="arm",host="mac",forge="gh",state="missing"} 1',
    );
    expect(text()).toContain(
      'grove_runners_expected{group="arm",host="mac"} 2',
    );
  });

  it('publishes reachability, suspects and the daemon', () => {
    expect(text()).toContain('grove_host_reachable{host="mac"} 1');
    expect(text()).toContain('grove_forge_reachable{forge="gh"} 0');
    expect(text()).toContain('grove_suspect_runners 1');
    expect(text()).toContain('grove_daemon_running 1');
  });

  it('publishes the tick stamps in seconds and their durations', () => {
    expect(text()).toContain(
      'grove_last_tick_timestamp_seconds{kind="fast"} 1700000000',
    );
    expect(text()).toContain('grove_tick_duration_seconds{kind="full"} 4.2');
  });

  it('publishes the counters', () => {
    expect(text()).toContain('grove_restarts_total{group="arm"} 3');
    expect(text()).toContain(
      'grove_jobs_total{group="arm",outcome="unknown"} 7',
    );
  });

  it('publishes storage per host and per seat', () => {
    expect(text()).toContain('grove_image_store_bytes{host="mac"} 4000000000');
    expect(text()).toContain(
      'grove_image_store_reclaimable_bytes{host="mac"} 1000000000',
    );
    expect(text()).toContain('grove_host_work_dir_bytes{host="mac"} 2048');
    expect(text()).toContain(
      'grove_work_dir_bytes{host="mac",runner="grove-arm-1"} 2048',
    );
  });

  it('publishes how stale the snapshot is', () => {
    expect(text()).toContain('grove_snapshot_age_seconds 30');
  });

  it('publishes grove_up and nothing about the fleet before the first tick', () => {
    const empty = renderExposition(
      buildFamilies({
        storage: [],
        store: { restarts: [], jobs: [], daemonRunning: false },
        version: '0.1.0',
        now: 1,
      }),
    );
    expect(empty).toContain('grove_up 1');
    expect(empty).not.toContain('grove_runners{');
    expect(empty).not.toContain('grove_snapshot_age_seconds');
  });
});
