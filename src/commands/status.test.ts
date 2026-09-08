import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateLock } from '../lib/daemon/lock.js';
import { FakeForgeClient } from '../lib/forge/index.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport, type Transport } from '../lib/transport/index.js';
import { EXIT_OK, EXIT_UNREACHABLE } from './plan.js';
import { runStatus } from './status.js';

const CONFIG = `
hosts:
  mac: { type: local }

forges:
  gh-overload: { kind: github }

groups:
  - name: overload-arm
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 1 }
`;

let dir: string;
let store: StateStore;
let client: FakeForgeClient;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-status-'));
  store = StateStore.open(':memory:');
  client = new FakeForgeClient('gh-overload').addRunner({
    name: 'grove-overload-arm-1',
    id: '11',
    busy: true,
  });
  await writeFile(join(dir, 'grove.yaml'), CONFIG, 'utf8');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function mac(): FakeTransport {
  return new FakeTransport('mac')
    .on('uname', { stdout: 'Darwin arm64\n' })
    .on('sh -c printf', { stdout: '/Users/olivier' })
    .on('docker ps', {
      stdout: `${JSON.stringify({
        ID: 'abc',
        Names: 'grove-overload-arm-1',
        State: 'running',
        Image: 'ghcr.io/actions/actions-runner:latest',
        Status: 'Up 3 hours',
        CreatedAt: 'now',
      })}\n`,
    });
}

function isLogRead(call: { command: string; args: string[] }): boolean {
  return call.command === 'sh' && call.args[1]?.startsWith('docker logs');
}

// Delays every call whose command line starts with `prefix` by `ms`, real
// time. Used to hold a storage read open past the point the queue sweep
// (which never waits on a timer) has already resolved.
function delayed(transport: Transport, prefix: string, ms: number): Transport {
  return {
    name: transport.name,
    exec: (command, args, opts) => {
      const line = [command, ...args].join(' ');
      if (!line.startsWith(prefix)) {
        return transport.exec(command, args, opts);
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve(transport.exec(command, args, opts)), ms);
      });
    },
    readFile: (path) => transport.readFile(path),
    writeFile: (path, content) => transport.writeFile(path, content),
    close: () => transport.close(),
  };
}

function options(extra: Record<string, unknown> = {}) {
  return {
    config: join(dir, 'grove.yaml'),
    env: { GROVE_STATE_DIR: join(dir, 'state') },
    store,
    connect: () => mac(),
    resolveToken: async () => 'token',
    createForgeClient: () => client,
    color: false,
    stdout: () => undefined,
    stderr: () => undefined,
    ...extra,
  };
}

describe('runStatus', () => {
  it('prints one row per runner', async () => {
    const out: string[] = [];
    const code = await runStatus(
      options({ stdout: (text: string) => out.push(text) }),
    );

    expect(code).toBe(EXIT_OK);
    const text = out.join('\n');
    expect(text).toContain('GROUP');
    expect(text).toContain('grove-overload-arm-1');
    expect(text).toContain('busy');
    expect(text).toContain('unmanaged');
  });

  it('names the job a busy seat is running, from its own log', async () => {
    const out: string[] = [];
    const transport = mac().on('sh -c docker logs', {
      stdout: '2026-09-08 11:02:03Z: Running job: build (macos)\n',
    });
    const code = await runStatus(
      options({
        connect: () => transport,
        json: true,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(out.join('\n')).rows[0].job).toEqual({
      label: 'build (macos)',
      startedAt: Date.parse('2026-09-08T11:02:03Z'),
    });
    // One log read, for the one seat the forge called busy.
    expect(transport.calls.filter(isLogRead)).toHaveLength(1);
  });

  it('reads no log for a seat the forge calls idle', async () => {
    const transport = mac();
    client = new FakeForgeClient('gh-overload').addRunner({
      name: 'grove-overload-arm-1',
      id: '11',
      busy: false,
    });
    await runStatus(options({ connect: () => transport }));
    expect(transport.calls.some(isLogRead)).toBe(false);
  });

  it('prints JSON with --json and nothing else', async () => {
    const out: string[] = [];
    await runStatus(
      options({ json: true, stdout: (text: string) => out.push(text) }),
    );
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.rows[0].runner).toBe('grove-overload-arm-1');
    expect(parsed.rows[0].forgeStatus).toBe('busy');
  });

  it('records a liveness sample for a managed runner', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    await runStatus(options());
    expect(store.livenessFor(record.id)).toEqual([
      { ts: expect.any(Number), state: 'busy' },
    ]);
  });

  it('exits non-zero when a host did not answer', async () => {
    const code = await runStatus(
      options({
        connect: () => new FakeTransport('mac').fail('uname', 'down\n', 255),
      }),
    );
    expect(code).toBe(EXIT_UNREACHABLE);
  });

  it('prints the queue and skips the sweep with queue: false', async () => {
    const lines: string[] = [];
    await runStatus(
      options({ stdout: (text: string) => lines.push(text), queue: false }),
    );
    expect(lines.join('\n')).not.toContain('Queue');
  });
});

describe('runStatus and the daemon', () => {
  it('reads the daemon pid and the last tick times', async () => {
    store.setMeta('daemon_pid', '4242');
    store.setMeta('last_full_tick', '1700000000000');

    const out: string[] = [];
    await runStatus(
      options({
        json: true,
        isPidAlive: () => true,
        stdout: (text: string) => out.push(text),
      }),
    );
    const report = JSON.parse(out.join('\n'));

    expect(report.daemon.pid).toBe(4242);
    expect(report.daemon.command).toBe('daemon');
    expect(report.daemon.alive).toBe(true);
    expect(report.daemon.lastFullTick).toBe(1_700_000_000_000);
  });

  it('does not read an apply that holds the lock as the daemon', async () => {
    // The daemon takes the reconciler lock per tick, so the holder is often
    // somebody else and is absent for most of the time the daemon is running.
    // Liveness comes from the daemon's own pid instead.
    const held = StateLock.acquire({
      path: join(dir, 'state', 'grove.pid'),
      command: 'apply',
      pid: 99,
      isPidAlive: () => false,
    });

    const out: string[] = [];
    await runStatus(
      options({
        json: true,
        isPidAlive: () => true,
        stdout: (text: string) => out.push(text),
      }),
    );
    const report = JSON.parse(out.join('\n'));

    expect(report.daemon.alive).toBe(false);
    expect(report.daemon.pid).toBeUndefined();
    held.release();
  });

  it('lists a seat the supervisor marked as a suspect', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    store.setWatch(record.id, {
      busySince: 1000,
      unregisteredSince: null,
      suspectSince: 2000,
      suspectReason: 'the forge says busy and the work dir is quiet',
    });

    const out: string[] = [];
    await runStatus(
      options({ json: true, stdout: (text: string) => out.push(text) }),
    );
    const report = JSON.parse(out.join('\n'));

    expect(report.suspects).toEqual([
      {
        runner: 'grove-overload-arm-1',
        host: 'mac',
        since: 2000,
        reason: 'the forge says busy and the work dir is quiet',
      },
    ]);
  });
});

describe('runStatus, storage', () => {
  function measurable(): FakeTransport {
    return mac()
      .on('docker system df', { stdout: 'Images\t4GB\t1GB (25%)\n' })
      .on('sh -c set --', { stdout: 'grove-overload-arm-1\t2048\n' });
  }

  it('measures every reachable host and prints the section', async () => {
    const out: string[] = [];
    const code = await runStatus(
      options({
        connect: () => measurable(),
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('Storage');
    // docker counts in decimal units and grove prints binary ones, so its
    // 4GB image store is 3.7 GiB.
    expect(out.join('\n')).toContain('3.7 GiB');
  });

  it('carries the storage through --json', async () => {
    const out: string[] = [];
    await runStatus(
      options({
        connect: () => measurable(),
        json: true,
        stdout: (text: string) => out.push(text),
      }),
    );

    const parsed = JSON.parse(out.join('\n')) as {
      storage: Array<{ host: string; workDirBytes: number }>;
    };
    expect(parsed.storage[0].host).toBe('mac');
    expect(parsed.storage[0].workDirBytes).toBe(2048 * 1024);
  });
});

describe('runStatus in a terminal', () => {
  it('opens on a waiting frame and closes on the finished report', async () => {
    const frames: string[] = [];
    const code = await runStatus(
      options({
        live: true,
        stdout: undefined,
        liveStdout: (text: string) => frames.push(text),
        liveColumns: 200,
        // Nothing should redraw on the spinner's clock during a test.
        liveIntervalMs: 1_000_000,
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(frames[0]).toContain('waiting on host mac');
    expect(frames[0]).not.toContain('Every host and forge answered.');

    const last = frames[frames.length - 1];
    expect(last).not.toContain('waiting on');
    expect(last).toContain('grove-overload-arm-1');
    expect(last).toContain('Every host and forge answered.');
    // Every frame after the first rewinds over the one before it, so the
    // terminal holds one report rather than a stack of them.
    for (const frame of frames.slice(1)) {
      expect(frame.startsWith('\u001B[')).toBe(true);
    }
  });

  it('stays on one final print for --json, terminal or not', async () => {
    const frames: string[] = [];
    const out: string[] = [];
    await runStatus(
      options({
        json: true,
        live: true,
        stdout: (text: string) => out.push(text),
        liveStdout: (text: string) => frames.push(text),
      }),
    );

    expect(frames).toEqual([]);
    expect(JSON.parse(out.join('\n')).rows[0].runner).toBe(
      'grove-overload-arm-1',
    );
  });

  it('draws the Queue section as soon as the sweep lands, without waiting on a slow host', async () => {
    client.setQueuedJobs([
      {
        project: 'acme/mobile',
        name: 'e2e',
        labels: [],
        queuedAt: 1000,
        url: '',
      },
    ]);
    // The work-dir usage script is the slow read status waits on; the queue
    // sweep has no timer in it at all, so it always resolves first.
    const transport = delayed(mac(), 'sh -c set --', 20);
    const frames: string[] = [];
    await runStatus(
      options({
        connect: () => transport,
        live: true,
        stdout: undefined,
        liveStdout: (text: string) => frames.push(text),
        liveColumns: 200,
        liveIntervalMs: 1_000_000,
      }),
    );

    const midFlight = frames.find(
      (frame) => frame.includes('Queue') && frame.includes('waiting on'),
    );
    expect(midFlight).toBeDefined();
    expect(midFlight).toContain('storage on mac');
  });
});
