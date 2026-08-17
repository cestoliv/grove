import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openFleet } from '../../commands/context.js';
import { CredentialError } from '../config/index.js';
import { EXIT_OK, EXIT_UNREACHABLE } from '../exit-codes.js';
import type { FetchFn } from '../forge/index.js';
import { StateStore } from '../state/index.js';
import { FakeTransport } from '../transport/index.js';
import { doctorExitCode, runChecks } from './run.js';

const GH_TOKEN = ['ghp', '0123456789abcdefghij'].join('_');

const CONFIG = `
hosts:
  mac: { type: local, work_root: /srv/grove }
  atlas: { type: ssh, host: atlas, work_root: /srv/grove }

forges:
  gh: { kind: github }

groups:
  - name: arm
    forge: gh
    scope: { level: organization, target: Acme }
    placement: { host: mac, count: 1 }
  - name: dind
    forge: gh
    scope: { level: organization, target: Acme }
    placement: { atlas: 1 }
`;

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-doctor-'));
  store = StateStore.open(':memory:');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function healthy(name: string): FakeTransport {
  return new FakeTransport(name)
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
    .on('sh -c command -v', { stdout: '/usr/local/bin/gh\n' })
    .on('ssh -V', { stderr: 'OpenSSH_9.6p1\n' })
    .setFallback({ code: 0, stdout: '', stderr: '' });
}

function githubFetch(): FetchFn {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/user')) {
      return new Response(JSON.stringify({ login: 'ci-bot' }), {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, admin:org' },
      });
    }
    return new Response(JSON.stringify({ total_count: 0 }), { status: 200 });
  }) as unknown as FetchFn;
}

async function fleetFor(transports: Record<string, FakeTransport>) {
  const path = join(dir, 'grove.yaml');
  await writeFile(path, CONFIG, 'utf8');
  return openFleet({
    config: path,
    connect: (name) => transports[name],
    store,
    forges: false,
  });
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    fetchFn: githubFetch(),
    resolveToken: async () => GH_TOKEN,
    platform: 'linux',
    home: dir,
    stateDir: dir,
    nodeVersion: 'v22.13.0',
    isPidAlive: () => false,
    access: async () => undefined,
    stat: async () => ({ mode: 0o100600 }),
    ...overrides,
  };
}

describe('runChecks', () => {
  it('checks every family and orders them control, host, forge, group', async () => {
    const transports = { mac: healthy('mac'), atlas: healthy('atlas') };
    const fleet = await fleetFor(transports);
    try {
      const report = await runChecks({ fleet, ...base() });
      const kinds = [
        ...new Set(report.checks.map((check) => check.target.kind)),
      ];
      expect(kinds).toEqual(['control', 'host', 'forge', 'group']);
      expect(report.configPath).toBe(fleet.loaded.path);
      expect(report.counts.fail).toBe(0);
      expect(report.ok).toBe(true);
    } finally {
      await fleet.close();
    }
  });

  it('checks the hosts in parallel and one host serially', async () => {
    const transports = { mac: healthy('mac'), atlas: healthy('atlas') };
    const fleet = await fleetFor(transports);
    try {
      await runChecks({ fleet, ...base() });
      // One probe per host, whatever the number of checks that wanted it.
      for (const transport of Object.values(transports)) {
        expect(
          transport.commandLines().filter((line) => line === 'uname -sm'),
        ).toHaveLength(1);
      }
    } finally {
      await fleet.close();
    }
  });

  it('keeps checking when one host is down, and reports the fleet as not ok', async () => {
    const transports = {
      mac: healthy('mac'),
      atlas: new FakeTransport('atlas').fail(
        'uname -sm',
        'ssh: connect refused',
      ),
    };
    const fleet = await fleetFor(transports);
    try {
      const report = await runChecks({ fleet, ...base() });
      const atlas = report.checks.filter(
        (check) =>
          check.target.kind === 'host' && check.target.name === 'atlas',
      );
      expect(atlas[0].status).toBe('fail');
      expect(report.ok).toBe(false);
      expect(
        report.checks.some(
          (check) => check.target.name === 'mac' && check.status === 'ok',
        ),
      ).toBe(true);
    } finally {
      await fleet.close();
    }
  });

  it('turns a credential grove cannot resolve into a finding on that forge', async () => {
    const transports = { mac: healthy('mac'), atlas: healthy('atlas') };
    const fleet = await fleetFor(transports);
    try {
      const report = await runChecks({
        fleet,
        ...base({
          resolveToken: async () => {
            throw new CredentialError(
              'forge "gh": `gh auth token` printed nothing.',
            );
          },
        }),
      });
      const credential = report.checks.find(
        (check) => check.id === 'forge.credential',
      );
      expect(credential?.status).toBe('fail');
      expect(credential?.summary).toContain('printed nothing');
      expect(report.ok).toBe(false);
    } finally {
      await fleet.close();
    }
  });

  it('limits the run to the families and the hosts the caller named', async () => {
    const transports = { mac: healthy('mac'), atlas: healthy('atlas') };
    const fleet = await fleetFor(transports);
    try {
      const report = await runChecks({
        fleet,
        ...base({ families: ['host'], hosts: ['mac'] }),
      });
      expect([
        ...new Set(report.checks.map((check) => check.target.name)),
      ]).toEqual(['mac']);
      expect(transports.atlas.calls).toHaveLength(0);
      expect(report.hostFacts.map((fact) => fact.host)).toEqual(['mac']);
    } finally {
      await fleet.close();
    }
  });

  it('counts every status and carries the facts the host pass learned', async () => {
    const transports = { mac: healthy('mac'), atlas: healthy('atlas') };
    const fleet = await fleetFor(transports);
    try {
      const report = await runChecks({ fleet, ...base() });
      const total =
        report.counts.ok +
        report.counts.warn +
        report.counts.fail +
        report.counts.skip;
      expect(total).toBe(report.checks.length);
      expect(
        report.hostFacts.find((fact) => fact.host === 'mac')?.platform,
      ).toBe('Linux');
    } finally {
      await fleet.close();
    }
  });
});

describe('doctorExitCode', () => {
  const report = (fail: number, warn: number) =>
    ({
      configPath: '/x',
      checks: [],
      counts: { ok: 0, warn, fail, skip: 0 },
      ok: fail === 0,
      hostFacts: [],
    }) as Parameters<typeof doctorExitCode>[0];

  it('exits 0 when nothing failed', () => {
    expect(doctorExitCode(report(0, 3))).toBe(EXIT_OK);
  });

  it('exits 1 on a failure', () => {
    expect(doctorExitCode(report(1, 0))).toBe(EXIT_UNREACHABLE);
  });

  it('exits 1 on a warning under --strict', () => {
    expect(doctorExitCode(report(0, 1), true)).toBe(EXIT_UNREACHABLE);
    expect(doctorExitCode(report(0, 0), true)).toBe(EXIT_OK);
  });
});
