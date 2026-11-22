import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateLock } from '../lib/daemon/lock.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
import { runForget } from './forget.js';
import {
  EXIT_ABORTED,
  EXIT_INVALID_CONFIG,
  EXIT_OK,
  EXIT_UNREACHABLE,
} from './plan.js';

// eris has left the config. mac is still in it.
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
let transport: FakeTransport;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-forget-'));
  store = StateStore.open(':memory:');
  transport = new FakeTransport('mac');
  await writeFile(join(dir, 'grove.yaml'), CONFIG, 'utf8');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function options(names: string[], extra: Record<string, unknown> = {}) {
  return {
    names,
    config: join(dir, 'grove.yaml'),
    env: { GROVE_STATE_DIR: join(dir, 'state') },
    store,
    connect: () => transport,
    resolveToken: async () => {
      throw new Error('forget must not resolve a token');
    },
    isTty: false,
    stdout: () => undefined,
    stderr: () => undefined,
    ...extra,
  };
}

function record(host: string, group: string): number {
  const created = store.createRunner({
    group,
    index: 1,
    host,
    forge: 'gh-overload',
    name: `grove-${group}-1`,
  });
  store.setWatch(created.id, {
    busySince: null,
    unregisteredSince: 1,
    suspectSince: null,
    suspectReason: null,
  });
  return created.id;
}

describe('runForget', () => {
  it('retires the record of a runner whose host left the config, and its watch', async () => {
    const id = record('eris', 'overload-eris');
    const code = await runForget(
      options(['grove-overload-eris-1'], { yes: true }),
    );

    expect(code).toBe(EXIT_OK);
    expect(store.activeRunners()).toEqual([]);
    expect(store.getRunner(id)?.retiredAt).not.toBeNull();
    expect(store.watchFor(id).unregisteredSince).toBeNull();
    expect(transport.commandLines()).toEqual([]);
  });

  it('refuses a runner whose host is still in the config, and changes nothing', async () => {
    const eris = record('eris', 'overload-eris');
    record('mac', 'overload-arm');
    const errors: string[] = [];
    const code = await runForget(
      options(['grove-overload-eris-1', 'grove-overload-arm-1'], {
        yes: true,
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(EXIT_INVALID_CONFIG);
    expect(errors.join('\n')).toContain('still in grove.yaml');
    expect(store.activeRunners()).toHaveLength(2);
    expect(store.watchFor(eris).unregisteredSince).toBe(1);
  });

  it('retires a name given twice once', async () => {
    record('eris', 'overload-eris');
    const out: string[] = [];
    const code = await runForget(
      options(['grove-overload-eris-1', 'grove-overload-eris-1'], {
        yes: true,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(out.filter((line) => line.includes('retired'))).toHaveLength(1);
  });

  it('refuses a name grove has no active record of', async () => {
    const code = await runForget(options(['grove-nope-1'], { yes: true }));
    expect(code).toBe(EXIT_INVALID_CONFIG);
  });

  it('asks first, and changes nothing without a yes', async () => {
    record('eris', 'overload-eris');
    const code = await runForget(options(['grove-overload-eris-1']));

    expect(code).toBe(EXIT_ABORTED);
    expect(store.activeRunners()).toHaveLength(1);
  });

  it('refuses while another command holds grove.pid', async () => {
    record('eris', 'overload-eris');
    const held = StateLock.acquire({
      path: join(dir, 'state', 'grove.pid'),
      command: 'daemon',
      pid: 77,
      isPidAlive: () => true,
    });
    try {
      const code = await runForget(
        options(['grove-overload-eris-1'], {
          yes: true,
          isPidAlive: () => true,
        }),
      );
      expect(code).toBe(EXIT_UNREACHABLE);
      expect(store.activeRunners()).toHaveLength(1);
    } finally {
      held.release();
    }
  });
});
