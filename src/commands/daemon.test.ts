import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialError } from '../lib/config/index.js';
import { readLockHolder, StateLock } from '../lib/daemon/lock.js';
import {
  EXIT_INVALID_CONFIG,
  EXIT_OK,
  EXIT_UNREACHABLE,
} from '../lib/exit-codes.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
import {
  runDaemonInstall,
  runDaemonRun,
  runDaemonStatus,
  runDaemonTail,
  runDaemonUninstall,
} from './daemon.js';

const CONFIG = `
tick: { fast: 2m, full: 30m }

hosts:
  mac: { type: local, work_root: /srv/grove }

forges:
  gh-overload: { kind: github }

groups:
  - name: overload-arm
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 1 }
`;

// Short enough that a test can watch two passes without waiting. The daemon
// reads the interval from the config, so this is the only lever there is.
const FAST_CONFIG = CONFIG.replace(
  'tick: { fast: 2m, full: 30m }',
  'tick: { fast: 0.05s, full: 0.05s }',
);

let dir: string;
let stateDir: string;
let configPath: string;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-daemon-cmd-'));
  stateDir = join(dir, 'state');
  configPath = join(dir, 'grove.yaml');
  await writeFile(configPath, CONFIG, 'utf8');
  store = StateStore.open(':memory:');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function base(extra: Record<string, unknown> = {}) {
  return {
    config: configPath,
    env: { GROVE_STATE_DIR: stateDir, HOME: dir },
    stateDir,
    stdout: () => undefined,
    stderr: () => undefined,
    ...extra,
  };
}

function summary(kind: string) {
  return {
    kind,
    applied: 0,
    failed: 0,
    skipped: 0,
    restarted: [],
    suspects: [],
    reregistered: [],
    prunedEntries: 0,
    prunedHistory: 0,
    unreachableHosts: [],
    unreachableForges: [],
    durationMs: 1,
  };
}

describe('runDaemonRun', () => {
  it('takes the lock, runs ticks, and releases it', async () => {
    const controller = new AbortController();
    const kinds: string[] = [];

    const code = await runDaemonRun(
      base({
        store,
        connect: () => new FakeTransport('mac'),
        resolveToken: async () => 'token',
        signal: controller.signal,
        pid: 4242,
        isPidAlive: () => false,
        runTick: async (options: { kind: string }) => {
          kinds.push(options.kind);
          controller.abort();
          return summary(options.kind);
        },
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(kinds).toEqual(['full']);
    // Released, so the next apply is not refused by a daemon that has gone.
    await expect(
      readFile(join(stateDir, 'grove.pid'), 'utf8'),
    ).rejects.toThrow();
    const log = await readFile(join(stateDir, 'grove.log'), 'utf8');
    expect(log).toContain('daemon started');
    expect(log).toContain('daemon stopped');
    // The loop is what `grove status` and `grove daemon status` report on, and
    // it is gone, so the pid it published is gone with it.
    expect(store.getMeta('daemon_pid')).toBe('');
  });

  it('stops on SIGTERM and releases the lock', async () => {
    // The supervisor stops the daemon with a signal, so the handlers are
    // wired even when nothing injected a signal.
    const inherited = process.listeners('SIGTERM');
    process.removeAllListeners('SIGTERM');
    try {
      const kinds: string[] = [];
      const code = await runDaemonRun(
        base({
          store,
          connect: () => new FakeTransport('mac'),
          resolveToken: async () => 'token',
          pid: 4243,
          isPidAlive: () => false,
          runTick: async (options: { kind: string }) => {
            kinds.push(options.kind);
            process.emit('SIGTERM');
            return summary(options.kind);
          },
        }),
      );

      expect(code).toBe(EXIT_OK);
      expect(kinds).toEqual(['full']);
      await expect(
        readFile(join(stateDir, 'grove.pid'), 'utf8'),
      ).rejects.toThrow();
      // The handler is gone again, so a long-lived process does not collect
      // one per run.
      expect(process.listeners('SIGTERM')).toEqual([]);
    } finally {
      process.removeAllListeners('SIGTERM');
      for (const listener of inherited) {
        process.on('SIGTERM', listener as NodeJS.SignalsListener);
      }
    }
  });

  it('keeps the last good config when a reload stops parsing', async () => {
    const controller = new AbortController();
    const code = await runDaemonRun(
      base({
        store,
        connect: () => new FakeTransport('mac'),
        // The forge token resolves while `openFleet` runs, which is after the
        // startup read and before the first tick's reload.
        resolveToken: async () => {
          await writeFile(configPath, 'hosts: [nope]\n', 'utf8');
          return 'token';
        },
        signal: controller.signal,
        pid: 4244,
        isPidAlive: () => false,
        runTick: async (options: { kind: string }) => {
          controller.abort();
          return summary(options.kind);
        },
      }),
    );

    expect(code).toBe(EXIT_OK);
    const log = await readFile(join(stateDir, 'grove.log'), 'utf8');
    expect(log).toContain('keeping the last good config');
  });

  it('skips the tick another grove holds the lock for, and says so once', async () => {
    await writeFile(configPath, FAST_CONFIG, 'utf8');
    const held = StateLock.acquire({
      path: join(stateDir, 'grove.pid'),
      command: 'apply',
      pid: 99,
      isPidAlive: () => true,
    });
    const controller = new AbortController();
    const kinds: string[] = [];
    let probes = 0;
    const code = await runDaemonRun(
      base({
        store,
        connect: () => new FakeTransport('mac'),
        resolveToken: async () => 'token',
        signal: controller.signal,
        pid: 4242,
        // Consulted once per skipped tick, for the pid in the lock file. The
        // second pass ends the run, so the log has had two chances to complain
        // and the test can say the daemon complained once.
        isPidAlive: () => {
          probes += 1;
          if (probes >= 2) {
            controller.abort();
          }
          return true;
        },
        runTick: async (options: { kind: string }) => {
          kinds.push(options.kind);
          return summary(options.kind);
        },
      }),
    );

    // The daemon keeps running. An apply that holds the lock costs a tick,
    // not the control loop.
    expect(code).toBe(EXIT_OK);
    expect(kinds).toEqual([]);
    expect(probes).toBe(2);
    const log = await readFile(join(stateDir, 'grove.log'), 'utf8');
    expect(
      log.split('\n').filter((line) => line.includes('tick skipped')),
    ).toHaveLength(1);
    expect(log).toContain('tick skipped: lock held by 99 (apply)');
    // And the apply still holds its own lock.
    expect(readLockHolder(join(stateDir, 'grove.pid'))?.command).toBe('apply');
    held.release();
  });

  it('does not hold the lock between ticks', async () => {
    await writeFile(configPath, FAST_CONFIG, 'utf8');
    const lockPath = join(stateDir, 'grove.pid');
    const controller = new AbortController();
    const during: (string | undefined)[] = [];
    const between: boolean[] = [];
    const pidWhileRunning: (string | undefined)[] = [];

    const code = await runDaemonRun(
      base({
        store,
        connect: () => new FakeTransport('mac'),
        resolveToken: async () => 'token',
        signal: controller.signal,
        pid: 4242,
        isPidAlive: () => false,
        runTick: async (options: { kind: string }) => {
          during.push(readLockHolder(lockPath)?.command);
          if (during.length === 1) {
            // Fires inside the gap the loop sleeps through, which is where an
            // operator's apply has to be able to land.
            setTimeout(() => {
              between.push(existsSync(lockPath));
              pidWhileRunning.push(store.getMeta('daemon_pid'));
            }, 20);
          } else {
            controller.abort();
          }
          return summary(options.kind);
        },
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(during).toEqual(['daemon', 'daemon']);
    expect(between).toEqual([false]);
    // Liveness does not come from the lock, so a status run between two ticks
    // still finds the daemon.
    expect(pidWhileRunning).toEqual(['4242']);
  });

  it('exits with the config code when the config does not parse', async () => {
    await writeFile(configPath, 'hosts: [nope]\n', 'utf8');
    const errors: string[] = [];
    const code = await runDaemonRun(
      base({
        store,
        signal: AbortSignal.abort(),
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(EXIT_INVALID_CONFIG);
    // Nothing was locked, so fixing the config and running apply is not
    // refused by the daemon that just gave up.
    await expect(
      readFile(join(stateDir, 'grove.pid'), 'utf8'),
    ).rejects.toThrow();
    const log = await readFile(join(stateDir, 'grove.log'), 'utf8');
    expect(log).toContain('hosts');
    expect(errors.join('\n')).toContain('hosts');
  });

  it('exits with the config code when a credential does not resolve', async () => {
    const errors: string[] = [];
    const code = await runDaemonRun(
      base({
        store,
        openFleet: async () => {
          throw new CredentialError('no token for gh-overload');
        },
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(EXIT_INVALID_CONFIG);
    expect(errors.join('\n')).toContain('no token for gh-overload');
    await expect(
      readFile(join(stateDir, 'grove.pid'), 'utf8'),
    ).rejects.toThrow();
  });

  it('exits unreachable when opening the fleet fails for another reason', async () => {
    const code = await runDaemonRun(
      base({
        store,
        openFleet: async () => {
          throw new Error('ssh: connect to host mac port 22: no route to host');
        },
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    const log = await readFile(join(stateDir, 'grove.log'), 'utf8');
    expect(log).toContain('daemon could not open the fleet');
  });
});

describe('runDaemonInstall', () => {
  it('writes the unit and reports where everything lives', async () => {
    const transport = new FakeTransport('control').on('id -u', {
      stdout: '1000\n',
    });
    const out: string[] = [];
    const code = await runDaemonInstall(
      base({
        transport,
        platform: 'Linux',
        home: dir,
        execPath: '/usr/local/bin/node',
        script: '/opt/grove/dist/grove.js',
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    const unit = transport.writes.get(
      join(dir, '.config/systemd/user/grove-daemon.service'),
    );
    expect(unit).toContain(`--config" "${configPath}`);
    expect(out.join('\n')).toContain('grove-daemon.service');
    expect(out.join('\n')).toContain(configPath);
    // The path is baked in, so an upgrade needs a reinstall and grove says so.
    expect(out.join('\n')).toContain('Reinstall after upgrading grove');
  });

  it('follows the npm symlink to the script the supervisor can run', async () => {
    // `npm install -g` puts `grove` in a bin directory as a symlink, and the
    // link's own name has no `.js` suffix for `resolveDaemonCommand` to accept.
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'dist', 'grove.js'), '#!/usr/bin/env node\n');
    await mkdir(join(dir, 'bin'), { recursive: true });
    await symlink(join(dir, 'dist', 'grove.js'), join(dir, 'bin', 'grove'));

    const transport = new FakeTransport('control').on('id -u', {
      stdout: '1000\n',
    });
    const code = await runDaemonInstall(
      base({
        transport,
        platform: 'Linux',
        home: dir,
        execPath: '/usr/local/bin/node',
        script: join(dir, 'bin', 'grove'),
      }),
    );

    expect(code).toBe(EXIT_OK);
    const unit = transport.writes.get(
      join(dir, '.config/systemd/user/grove-daemon.service'),
    );
    expect(unit).toContain('/dist/grove.js');
    expect(unit).not.toContain('/bin/grove');
  });

  it('reports an exit code when the script is not built JavaScript', async () => {
    const errors: string[] = [];
    const code = await runDaemonInstall(
      base({
        transport: new FakeTransport('control'),
        platform: 'Linux',
        home: dir,
        execPath: '/usr/local/bin/node',
        script: join(dir, 'src', 'grove.ts'),
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    expect(errors.join('\n')).toContain('built JavaScript');
  });

  it('reports the failure when the control node refuses the unit', async () => {
    const transport = new FakeTransport('control')
      .on('id -u', { stdout: '1000\n' })
      .fail('systemctl', 'Failed to connect to bus: No such file or directory');
    const errors: string[] = [];
    const code = await runDaemonInstall(
      base({
        transport,
        platform: 'Linux',
        home: dir,
        execPath: '/usr/local/bin/node',
        script: '/opt/grove/dist/grove.js',
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    expect(errors.join('\n')).toContain('Failed to connect to bus');
  });

  it('refuses to install a config that does not parse', async () => {
    await writeFile(configPath, 'hosts: [nope]\n', 'utf8');
    const transport = new FakeTransport('control');
    const code = await runDaemonInstall(
      base({ transport, platform: 'Linux', home: dir }),
    );
    expect(code).toBe(EXIT_INVALID_CONFIG);
    expect(transport.writes.size).toBe(0);
  });
});

describe('runDaemonUninstall', () => {
  it('unloads the unit and removes the file', async () => {
    const transport = new FakeTransport('control').on('id -u', {
      stdout: '1000\n',
    });
    const code = await runDaemonUninstall(
      base({ transport, platform: 'Linux', home: dir }),
    );
    expect(code).toBe(EXIT_OK);
    expect(transport.commandLines()).toContain(
      'systemctl --user disable --now grove-daemon.service',
    );
  });

  it('clears the suspects it will never revisit', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    store.setWatch(record.id, {
      busySince: 100,
      unregisteredSince: null,
      suspectSince: 200,
      suspectReason: 'the work dir is quiet',
    });
    const transport = new FakeTransport('control').on('id -u', {
      stdout: '1000\n',
    });

    const code = await runDaemonUninstall(
      base({ store, transport, platform: 'Linux', home: dir }),
    );

    // Nothing watches the fleet any more, so a suspect from the last control
    // loop would sit in `grove status` for as long as the record lives.
    expect(code).toBe(EXIT_OK);
    expect(store.watchFor(record.id).suspectSince).toBeNull();
    expect(store.watchFor(record.id).suspectReason).toBeNull();
    // The busy clock is an observation, not a verdict, so it stays.
    expect(store.watchFor(record.id).busySince).toBe(100);
  });
});

describe('runDaemonTail', () => {
  it('prints the last lines of the log', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'grove.log'), 'one\ntwo\n', 'utf8');
    const out: string[] = [];
    const code = await runDaemonTail(
      base({ lines: 1, stdout: (text: string) => out.push(text) }),
    );
    expect(code).toBe(EXIT_OK);
    expect(out.join('')).toBe('two\n');
  });

  it('says what to run when there is no log yet', async () => {
    const errors: string[] = [];
    const code = await runDaemonTail(
      base({ lines: 10, stderr: (text: string) => errors.push(text) }),
    );
    expect(code).toBe(EXIT_UNREACHABLE);
    expect(errors.join('\n')).toContain('grove daemon install');
  });
});

describe('runDaemonStatus', () => {
  it('reports a running daemon and the last tick times', async () => {
    store.setMeta('last_fast_tick', '1700000000000');
    store.setMeta('last_full_tick', '1699999000000');
    // The daemon's own pid, not the reconciler lock. That lock is taken per
    // tick, so it is absent for most of the time the daemon is running.
    store.setMeta('daemon_pid', '4242');
    const out: string[] = [];
    const code = await runDaemonStatus(
      base({
        store,
        transport: new FakeTransport('control'),
        platform: 'Linux',
        home: dir,
        isPidAlive: () => true,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('pid 4242');
    expect(out.join('\n')).toContain('2023-11-14');
    expect(out.join('\n')).toContain('(installed)');
  });

  it('does not read an apply that holds the lock as the daemon', async () => {
    const held = StateLock.acquire({
      path: join(stateDir, 'grove.pid'),
      command: 'apply',
      pid: 99,
      isPidAlive: () => false,
    });
    const out: string[] = [];
    const code = await runDaemonStatus(
      base({
        store,
        transport: new FakeTransport('control'),
        platform: 'Linux',
        home: dir,
        isPidAlive: () => true,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    expect(out.join('\n')).toContain('not running');
    held.release();
  });

  it('prints when the daemon last started', async () => {
    store.setMeta('daemon_started_at', '1700000000000');
    const out: string[] = [];
    const code = await runDaemonStatus(
      base({
        store,
        transport: new FakeTransport('control'),
        platform: 'Linux',
        home: dir,
        isPidAlive: () => false,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    expect(out.join('\n')).toContain('started   2023-11-14T22:13:20.000Z');
  });

  it('reports a daemon that is not running', async () => {
    const out: string[] = [];
    const code = await runDaemonStatus(
      base({
        store,
        transport: new FakeTransport('control').fail('test -f', '', 1),
        platform: 'Linux',
        home: dir,
        isPidAlive: () => false,
        stdout: (text: string) => out.push(text),
      }),
    );
    expect(code).toBe(EXIT_UNREACHABLE);
    expect(out.join('\n')).toContain('not running');
    expect(out.join('\n')).toContain('(not installed)');
  });

  it('says the install is unknown when the probe cannot run', async () => {
    const out: string[] = [];
    const errors: string[] = [];
    const code = await runDaemonStatus(
      base({
        store,
        transport: new FakeTransport('control').throwOn(
          'test -f',
          'ssh: could not resolve hostname control',
        ),
        platform: 'Linux',
        home: dir,
        isPidAlive: () => false,
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    // A node that will not answer is not a node with nothing installed.
    expect(out.join('\n')).toContain('(unknown)');
    expect(errors.join('\n')).toContain('could not resolve hostname');
  });
});

describe('runDaemonRun, the exporter', () => {
  // A port nothing holds, so the suite never fights whatever is on 9130. The
  // config schema refuses port 0 on purpose, because an ephemeral port in a
  // file nobody could point Prometheus at is always a mistake, so the test
  // asks the kernel for one and writes that number.
  async function metricsConfig(): Promise<string> {
    const probe = createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });
    return `${CONFIG}\nmetrics: { listen: "127.0.0.1:${port}" }\n`;
  }

  // Runs the daemon until its first tick, then stops it, and hands back what
  // it wrote to grove.log and what the exporter answered while it was up.
  async function runUntilFirstTick(
    text: string,
  ): Promise<{ log: string; body?: string; status?: number }> {
    await writeFile(configPath, text, 'utf8');
    const controller = new AbortController();
    let body: string | undefined;
    let status: number | undefined;

    await runDaemonRun(
      base({
        store,
        connect: () => new FakeTransport('mac'),
        resolveToken: async () => 'token',
        signal: controller.signal,
        pid: 4242,
        isPidAlive: () => false,
        runTick: async (options: { kind: string }) => {
          // The exporter is up by now, so this is the one moment a test can
          // scrape it. The address is in the log line grove wrote.
          const line = await readFile(join(stateDir, 'grove.log'), 'utf8');
          const address = /metrics exporter listening on (\S+)/.exec(line)?.[1];
          if (address !== undefined) {
            const response = await fetch(`http://${address}/metrics`);
            status = response.status;
            body = await response.text();
          }
          controller.abort();
          return summary(options.kind);
        },
      }),
    );

    return {
      log: await readFile(join(stateDir, 'grove.log'), 'utf8'),
      ...(body === undefined ? {} : { body }),
      ...(status === undefined ? {} : { status }),
    };
  }

  it('starts nothing when the config sets no metrics block', async () => {
    const result = await runUntilFirstTick(CONFIG);
    expect(result.log).not.toContain('metrics exporter listening');
    expect(result.body).toBeUndefined();
  });

  it('serves grove metrics while the daemon runs', async () => {
    const result = await runUntilFirstTick(await metricsConfig());
    expect(result.log).toContain('metrics exporter listening on 127.0.0.1:');
    expect(result.status).toBe(200);
    expect(result.body).toContain('grove_up 1');
  });

  it('logs a bind failure and keeps the loop running', async () => {
    // The probe keeps the port, so the address the config asks for is already
    // taken and the exporter cannot have it.
    const probe = createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address() as AddressInfo;
    try {
      await writeFile(
        configPath,
        `${CONFIG}\nmetrics: { listen: "127.0.0.1:${port}" }\n`,
        'utf8',
      );
      const controller = new AbortController();

      const code = await runDaemonRun(
        base({
          store,
          connect: () => new FakeTransport('mac'),
          resolveToken: async () => 'token',
          signal: controller.signal,
          pid: 4242,
          isPidAlive: () => false,
          runTick: async (options: { kind: string }) => {
            controller.abort();
            return summary(options.kind);
          },
        }),
      );

      // A control loop that stops converging over a taken port is worse than
      // one with no exporter, so the daemon ran, logged and exited clean.
      expect(code).toBe(EXIT_OK);
      const log = await readFile(join(stateDir, 'grove.log'), 'utf8');
      expect(log).toContain('metrics exporter could not bind');
      expect(log).not.toContain('metrics exporter listening');
    } finally {
      await new Promise<void>((resolve) => {
        probe.close(() => resolve());
      });
    }
  });

  it('logs a taken address once rather than once per tick', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address() as AddressInfo;
    try {
      await writeFile(
        configPath,
        `${FAST_CONFIG}\nmetrics: { listen: "127.0.0.1:${port}" }\n`,
        'utf8',
      );
      const controller = new AbortController();
      let ticks = 0;

      const code = await runDaemonRun(
        base({
          store,
          connect: () => new FakeTransport('mac'),
          resolveToken: async () => 'token',
          signal: controller.signal,
          pid: 4242,
          isPidAlive: () => false,
          runTick: async (options: { kind: string }) => {
            ticks += 1;
            if (ticks >= 2) {
              controller.abort();
            }
            return summary(options.kind);
          },
        }),
      );

      expect(code).toBe(EXIT_OK);
      expect(ticks).toBeGreaterThanOrEqual(2);
      // grove.log is the file an operator reads at 02:00, and a port taken for
      // good would otherwise fill it with one line every fast tick.
      const log = await readFile(join(stateDir, 'grove.log'), 'utf8');
      expect(log.split('metrics exporter could not bind')).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => {
        probe.close(() => resolve());
      });
    }
  });

  it('stops the exporter when the daemon stops', async () => {
    const result = await runUntilFirstTick(await metricsConfig());
    const address = /metrics exporter listening on (\S+)/.exec(result.log)?.[1];
    expect(address).toBeDefined();
    await expect(fetch(`http://${address}/metrics`)).rejects.toThrow();
  });
});
