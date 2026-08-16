import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeForgeClient } from '../lib/forge/index.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
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

function options(extra: Record<string, unknown> = {}) {
  return {
    config: join(dir, 'grove.yaml'),
    env: {},
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
});
