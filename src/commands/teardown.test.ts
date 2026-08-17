import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateLock } from '../lib/daemon/lock.js';
import { FakeForgeClient } from '../lib/forge/index.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
import { EXIT_ABORTED, EXIT_OK, EXIT_UNREACHABLE } from './plan.js';
import { runTeardown } from './teardown.js';

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
  dir = await mkdtemp(join(tmpdir(), 'grove-teardown-'));
  store = StateStore.open(':memory:');
  client = new FakeForgeClient('gh-overload').addRunner({
    name: 'grove-overload-arm-1',
    id: '11',
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
        Status: 'Up 1 hour',
        CreatedAt: 'now',
      })}\n`,
    });
}

function options(
  transport: FakeTransport,
  extra: Record<string, unknown> = {},
) {
  return {
    config: join(dir, 'grove.yaml'),
    env: { GROVE_STATE_DIR: join(dir, 'state') },
    store,
    connect: () => transport,
    resolveToken: async () => 'token',
    createForgeClient: () => client,
    color: false,
    isTty: false,
    stdout: () => undefined,
    stderr: () => undefined,
    ...extra,
  };
}

function managedRecord(): void {
  store.createRunner({
    group: 'overload-arm',
    index: 1,
    host: 'mac',
    forge: 'gh-overload',
    name: 'grove-overload-arm-1',
  });
}

describe('runTeardown', () => {
  it('drains, deregisters, removes and retires a managed runner', async () => {
    managedRecord();
    const transport = mac();
    const code = await runTeardown(options(transport, { yes: true }));

    expect(code).toBe(EXIT_OK);
    expect(transport.commandLines()).toContain(
      'docker stop -t 120 grove-overload-arm-1',
    );
    expect(transport.commandLines()).toContain(
      'docker rm -f grove-overload-arm-1',
    );
    expect(client.deleted.map((entry) => entry.id)).toEqual(['11']);
    expect(store.activeRunners()).toEqual([]);
  });

  it('leaves an unmanaged runner alone and says so', async () => {
    const transport = mac();
    const out: string[] = [];
    const code = await runTeardown(
      options(transport, {
        yes: true,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(
      transport.commandLines().some((line) => line.includes('docker rm')),
    ).toBe(false);
    expect(out.join('\n')).toContain('unmanaged   grove-overload-arm-1');
  });

  it('removes an unmanaged runner with --include-unmanaged', async () => {
    const transport = mac();
    const code = await runTeardown(
      options(transport, { yes: true, includeUnmanaged: true }),
    );

    expect(code).toBe(EXIT_OK);
    expect(transport.commandLines()).toContain(
      'docker rm -f grove-overload-arm-1',
    );
    expect(client.deleted.map((entry) => entry.id)).toEqual(['11']);
  });

  it('asks first and aborts on no', async () => {
    managedRecord();
    const transport = mac();
    const code = await runTeardown(
      options(transport, { isTty: true, input: Readable.from(['n\n']) }),
    );

    expect(code).toBe(EXIT_ABORTED);
    expect(store.activeRunners()).toHaveLength(1);
    expect(client.deleted).toEqual([]);
  });

  it('sends the no-terminal diagnostic to stderr and changes nothing', async () => {
    managedRecord();
    const transport = mac();
    const errors: string[] = [];
    const code = await runTeardown(
      options(transport, { stderr: (text: string) => errors.push(text) }),
    );

    expect(code).toBe(EXIT_ABORTED);
    expect(errors.join('\n')).toContain('--yes');
    expect(store.activeRunners()).toHaveLength(1);
  });

  it('changes nothing with --dry-run', async () => {
    managedRecord();
    const transport = mac();
    const out: string[] = [];
    const code = await runTeardown(
      options(transport, {
        dryRun: true,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('grove changed nothing');
    expect(
      transport.commandLines().some((line) => line.includes('docker stop')),
    ).toBe(false);
    expect(store.activeRunners()).toHaveLength(1);
    expect(client.deleted).toEqual([]);
  });

  it('leaves the runner alone and exits non-zero when the host is unreachable', async () => {
    managedRecord();
    const transport = new FakeTransport('mac').fail(
      'uname',
      'no route to host\n',
      255,
    );
    const out: string[] = [];
    const code = await runTeardown(
      options(transport, {
        yes: true,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    expect(out.join('\n')).toContain(
      'host "mac" is unreachable, so grove leaves this runner and its forge record alone',
    );
    expect(store.activeRunners()).toHaveLength(1);
    expect(client.deleted).toEqual([]);
  });

  it('says so when grove owns nothing', async () => {
    const transport = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('docker ps', { stdout: '' });
    const out: string[] = [];
    const code = await runTeardown(
      options(transport, {
        yes: true,
        createForgeClient: () => new FakeForgeClient('gh-overload'),
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('nothing grove owns is running');
  });

  it('exits 2 when the config does not load', async () => {
    const errors: string[] = [];
    const code = await runTeardown(
      options(mac(), {
        config: join(dir, 'nowhere.yaml'),
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('nowhere.yaml');
  });
});

describe('runTeardown and the state lock', () => {
  it('refuses to run while the daemon holds the lock', async () => {
    managedRecord();
    const held = StateLock.acquire({
      path: join(dir, 'state', 'grove.pid'),
      command: 'daemon',
      pid: 77,
      isPidAlive: () => true,
    });
    const errors: string[] = [];
    const code = await runTeardown(
      options(mac(), {
        isPidAlive: () => true,
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    expect(errors.join('\n')).toContain('pid 77');
    // Nothing was torn down, because nothing ran.
    expect(store.activeRunners()).toHaveLength(1);
    expect(client.deleted).toEqual([]);
    held.release();
  });

  it('releases the lock when it is done', async () => {
    await runTeardown(options(mac(), { isPidAlive: () => false }));
    expect(existsSync(join(dir, 'state', 'grove.pid'))).toBe(false);
  });
});
