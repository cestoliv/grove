import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchFn } from '../lib/forge/index.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
import { runDoctor } from './doctor.js';

const GH_TOKEN = ['ghp', '0123456789abcdefghij'].join('_');

// Every host is local, so the control node transport openFleet builds is the
// fake below rather than a real LocalTransport. Nothing in this file may run
// a command on the machine the suite is on.
const CONFIG = `
hosts:
  box: { type: local, work_root: /srv/grove }

forges:
  gh: { kind: github, auth: { token: "\${GH_TOKEN}" } }

groups:
  - name: dind
    forge: gh
    scope: { level: organization, target: Acme }
    placement: { box: 1 }
`;

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-doctor-cmd-'));
  store = StateStore.open(':memory:');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

// FakeTransport answers with the first stub whose prefix matches, so a broken
// variant seeds the transport with its failing stub and lets the healthy
// defaults land behind it.
function healthy(seed = new FakeTransport('box')): FakeTransport {
  return seed
    .on('uname -sm', { stdout: 'Linux x86_64\n' })
    .on('sh -c printf %s ok', { stdout: 'ok' })
    .on('sh -c printf %s "$HOME"', { stdout: '/home/ci' })
    .on('id -u', { stdout: '1000\n' })
    .on('date +%s', { stdout: String(Math.floor(Date.now() / 1000)) })
    .on('docker version', { stdout: '27.1.1\n' })
    .on('docker system df', { stdout: 'Images\t2GB\t0B (0%)\n' })
    .on('df -Pk', {
      stdout: [
        'Filesystem 1024-blocks Used Available Capacity Mounted on',
        '/dev/sda1 100000000 1000 90000000 10% /',
      ].join('\n'),
    })
    .on('systemctl --user is-system-running', { stdout: 'running\n' })
    .on('sh -c loginctl', { stdout: 'Linger=yes\n' })
    .setFallback({ code: 0, stdout: '', stderr: '' });
}

function dockerDown(): FakeTransport {
  return healthy(
    new FakeTransport('box').fail(
      'docker version',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
      1,
    ),
  );
}

function tightDisk(): FakeTransport {
  return healthy(
    new FakeTransport('box').on('df -Pk', {
      stdout: [
        'Filesystem 1024-blocks Used Available Capacity Mounted on',
        '/dev/sda1 100000000 99000000 5000000 96% /',
      ].join('\n'),
    }),
  );
}

function forgeFetch(status = 200): FetchFn {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/user')) {
      return new Response(JSON.stringify({ login: 'ci-bot' }), {
        status,
        headers: { 'x-oauth-scopes': 'repo, admin:org' },
      });
    }
    return new Response(JSON.stringify({ total_count: 0 }), { status });
  }) as unknown as FetchFn;
}

async function configPath(): Promise<string> {
  const path = join(dir, 'grove.yaml');
  await writeFile(path, CONFIG, 'utf8');
  return path;
}

async function run(overrides: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDoctor({
    config: await configPath(),
    env: { GH_TOKEN, HOME: dir, GROVE_STATE_DIR: dir },
    connect: () => healthy(),
    store,
    stateDir: dir,
    color: false,
    fetchFn: forgeFetch(),
    platform: 'linux',
    home: dir,
    nodeVersion: 'v22.13.0',
    isPidAlive: () => false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('runDoctor', () => {
  it('prints a table and exits 0 when nothing failed', async () => {
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(out).toContain('Control node');
    expect(out).toContain('Host box');
    expect(out).toContain('Forge gh');
    expect(out).toContain('Group dind');
  });

  it('exits 1 and names the fix when a check failed', async () => {
    const { code, out } = await run({ connect: () => dockerDown() });
    expect(code).toBe(1);
    expect(out).toContain('Fixes');
    expect(out).toContain('systemctl start docker');
  });

  it('exits 1 under --strict when anything warned, and 0 without it', async () => {
    const plain = await run({ connect: () => tightDisk() });
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('host.disk');

    const strict = await run({ connect: () => tightDisk(), strict: true });
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('--strict');
  });

  it('prints the report as JSON with --json', async () => {
    const { out } = await run({ json: true });
    const parsed = JSON.parse(out) as {
      checks: Array<{ id: string; status: string }>;
      counts: Record<string, number>;
    };
    expect(parsed.counts.fail).toBe(0);
    expect(parsed.checks.some((check) => check.id === 'host.reachable')).toBe(
      true,
    );
  });

  it('exits 2 on a config that does not parse, and opens nothing', async () => {
    const path = join(dir, 'broken.yaml');
    await writeFile(path, 'hosts: [not a mapping]\n', 'utf8');
    const errors: string[] = [];
    const code = await runDoctor({
      config: path,
      env: {},
      store,
      stderr: (text) => errors.push(text),
      stdout: () => undefined,
    });
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain(path);
  });

  it('reports a broken token rather than failing to open', async () => {
    const { code, out } = await run({
      fetchFn: forgeFetch(401),
    });
    expect(code).toBe(1);
    expect(out).toContain('forge.token');
    expect(out).toContain('expired');
  });
});
