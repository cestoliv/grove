import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeForgeClient } from '../lib/forge/index.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
import { EXIT_OK } from './plan.js';
import { runQueue } from './queue.js';

const CONFIG = `
hosts:
  mac: { type: local }

forges:
  gh-acme: { kind: github }

groups:
  - name: acme-arm
    forge: gh-acme
    scope: { level: organization, target: acme }
    placement: { host: mac, count: 1 }
    labels: [arm64]
`;

let dir: string;
let store: StateStore;
let client: FakeForgeClient;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-queue-'));
  store = StateStore.open(':memory:');
  client = new FakeForgeClient('gh-acme');
  await writeFile(join(dir, 'grove.yaml'), CONFIG, 'utf8');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function options(extra: Record<string, unknown> = {}) {
  return {
    config: join(dir, 'grove.yaml'),
    env: { GROVE_STATE_DIR: join(dir, 'state') },
    store,
    // The queue sweep never probes a host, so this transport's exec is
    // never called: it exists only because `openFleet` builds one per host.
    connect: () => new FakeTransport('mac'),
    resolveToken: async () => 'token',
    createForgeClient: () => client,
    color: false,
    stdout: () => undefined,
    stderr: () => undefined,
    ...extra,
  };
}

describe('runQueue', () => {
  it('prints one row per waiting job', async () => {
    client.setQueuedJobs([
      {
        project: 'acme/mobile',
        name: 'build',
        labels: ['arm64'],
        queuedAt: 10,
        url: 'u',
      },
    ]);
    const lines: string[] = [];
    const code = await runQueue(
      options({ stdout: (text: string) => lines.push(text) }),
    );
    const text = lines.join('\n');
    expect(code).toBe(EXIT_OK);
    expect(text).toContain('GROUP');
    expect(text).toContain('acme/mobile');
  });

  it('says so when nothing waits', async () => {
    const lines: string[] = [];
    await runQueue(options({ stdout: (text: string) => lines.push(text) }));
    expect(lines.join('\n')).toContain('No job is waiting.');
  });

  it('prints JSON with --json', async () => {
    client.setQueuedJobs([
      {
        project: 'acme/mobile',
        name: 'build',
        labels: ['arm64'],
        queuedAt: 10,
        url: 'u',
      },
    ]);
    const lines: string[] = [];
    await runQueue(
      options({ json: true, stdout: (text: string) => lines.push(text) }),
    );
    expect(() => JSON.parse(lines.join('\n'))).not.toThrow();
  });
});
