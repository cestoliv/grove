import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { META_DAEMON_PID, StateStore } from '../state/index.js';
import type { Transport } from '../transport/index.js';
import { MetricsState } from './collect.js';
import { createCollector } from './exporter.js';

const CONFIG: GroveConfig = {
  tick: { fast: 120_000, full: 1_800_000 },
  metrics: { listen: '127.0.0.1:9130', scrapeCacheMs: 10_000 },
  hosts: { mac: { type: 'local' } },
  forges: { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
  groups: [
    {
      name: 'dind',
      forge: 'gl',
      scope: { level: 'instance' },
      placement: { mac: 1 },
      stack: 'docker',
      raw: { metrics_port: 9252 },
    },
  ],
} as unknown as GroveConfig;

function collectorFor(
  scrapeSeats: () => Promise<string[]>,
  now: () => number,
): { collect: () => Promise<string>; store: StateStore } {
  const store = StateStore.open(':memory:');
  const collect = createCollector({
    state: new MetricsState(),
    store: () => store,
    config: () => CONFIG,
    transports: () => new Map<string, Transport>(),
    version: '0.1.0',
    now,
    isPidAlive: () => false,
    scrapeSeats,
  });
  return { collect, store };
}

describe('createCollector', () => {
  it('renders grove own metrics even before a tick has run', async () => {
    const { collect, store } = collectorFor(
      async () => [],
      () => 1,
    );
    try {
      const text = await collect();
      expect(text).toContain('grove_up 1');
      expect(text).toContain('grove_build_info{version="0.1.0"}');
    } finally {
      store.close();
    }
  });

  it('merges each seat exposition under it', async () => {
    const { collect, store } = collectorFor(
      async () => [
        ['# TYPE jobs counter', 'jobs{runner="grove-dind-1"} 3', ''].join('\n'),
      ],
      () => 1,
    );
    try {
      const text = await collect();
      expect(text).toContain('grove_up 1');
      expect(text).toContain('jobs{runner="grove-dind-1"} 3');
      expect(text).toContain('# TYPE jobs counter');
    } finally {
      store.close();
    }
  });

  it('reuses one seat scrape for every scrape inside the cache window', async () => {
    let scrapes = 0;
    let clock = 1_000;
    const { collect, store } = collectorFor(
      async () => {
        scrapes += 1;
        return ['# TYPE jobs counter\njobs 1\n'];
      },
      () => clock,
    );
    try {
      await collect();
      await collect();
      expect(scrapes).toBe(1);

      clock += 10_001;
      await collect();
      expect(scrapes).toBe(2);
    } finally {
      store.close();
    }
  });

  it('shares one in-flight scrape between two concurrent requests', async () => {
    let scrapes = 0;
    const { collect, store } = collectorFor(
      async () => {
        scrapes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return ['# TYPE jobs counter\njobs 1\n'];
      },
      () => 1,
    );
    try {
      await Promise.all([collect(), collect(), collect()]);
      expect(scrapes).toBe(1);
    } finally {
      store.close();
    }
  });

  it('reads the store on every scrape, so a reopened fleet needs no rebuild', async () => {
    // Reopening the fleet closes the store the daemon handed in. A collector
    // that captured it would answer 500 until something rebuilt it.
    const first = StateStore.open(':memory:');
    const second = StateStore.open(':memory:');
    second.setMeta(META_DAEMON_PID, '4242');
    let current = first;
    const collect = createCollector({
      state: new MetricsState(),
      store: () => current,
      config: () => CONFIG,
      transports: () => new Map<string, Transport>(),
      version: '0.1.0',
      now: () => 1,
      isPidAlive: () => true,
      scrapeSeats: async () => [],
    });

    try {
      expect(await collect()).toContain('grove_daemon_running 0');
      first.close();
      current = second;
      expect(await collect()).toContain('grove_daemon_running 1');
    } finally {
      second.close();
    }
  });

  it('degrades to grove own metrics when reading the config throws', async () => {
    const store = StateStore.open(':memory:');
    // The daemon reloads the config under the exporter. A scrape that lands
    // mid-reload must lose the seat re-export, not answer 500.
    const collect = createCollector({
      state: new MetricsState(),
      store: () => store,
      config: () => {
        throw new Error('the config file went away');
      },
      transports: () => new Map<string, Transport>(),
      version: '0.1.0',
      now: () => 1,
      isPidAlive: () => false,
      scrapeSeats: async () => ['# TYPE jobs counter\njobs 1\n'],
    });
    try {
      const text = await collect();
      expect(text).toContain('grove_up 1');
      expect(text).not.toContain('jobs 1');
    } finally {
      store.close();
    }
  });

  it('still answers when every seat scrape fails', async () => {
    const { collect, store } = collectorFor(
      async () => {
        throw new Error('ssh dropped');
      },
      () => 1,
    );
    try {
      const text = await collect();
      expect(text).toContain('grove_up 1');
      expect(text).not.toContain('jobs');
    } finally {
      store.close();
    }
  });
});
