import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { META_DAEMON_PID, StateStore } from '../state/index.js';
import { FakeTransport } from '../transport/index.js';
import {
  type ControlCheckContext,
  meetsNodeVersion,
  runControlChecks,
} from './control.js';

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-control-'));
  store = StateStore.open(':memory:');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function configWith(overrides: Partial<GroveConfig> = {}): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { atlas: { type: 'ssh', host: 'atlas' } },
    forges: { gh: { kind: 'github', auth: { source: 'token', token: 'x' } } },
    groups: [
      {
        name: 'a',
        forge: 'gh',
        scope: { level: 'organization', target: 'Acme' },
        placement: { atlas: 1 },
        stack: 'docker',
      },
    ],
    ...overrides,
  } as unknown as GroveConfig;
}

function contextFor(
  overrides: Partial<ControlCheckContext> = {},
): ControlCheckContext {
  return {
    config: configWith(),
    configPath: join(dir, 'grove.yaml'),
    transport: new FakeTransport('control')
      .on('ssh -V', { stderr: 'OpenSSH_9.6p1\n' })
      .on('sh -c command -v', { stdout: '/usr/local/bin/gh\n' })
      .on('test -f', { code: 1 }),
    platform: 'Linux',
    home: dir,
    stateDir: dir,
    store,
    nodeVersion: 'v22.13.0',
    isPidAlive: () => true,
    access: async () => undefined,
    stat: async () => ({ mode: 0o100600 }),
    ...overrides,
  };
}

function pick(
  reports: Awaited<ReturnType<typeof runControlChecks>>,
  id: string,
) {
  return reports.filter((report) => report.id === id);
}

describe('meetsNodeVersion', () => {
  it('accepts the floor and anything above it', () => {
    expect(meetsNodeVersion('v22.13.0', '22.13.0')).toBe(true);
    expect(meetsNodeVersion('v22.14.2', '22.13.0')).toBe(true);
    expect(meetsNodeVersion('v24.0.0', '22.13.0')).toBe(true);
  });

  it('refuses anything below it', () => {
    expect(meetsNodeVersion('v22.12.0', '22.13.0')).toBe(false);
    expect(meetsNodeVersion('v20.19.0', '22.13.0')).toBe(false);
  });

  it('refuses a version it cannot read', () => {
    expect(meetsNodeVersion('unknown', '22.13.0')).toBe(false);
  });
});

describe('runControlChecks', () => {
  it('passes a control node that has everything', async () => {
    const reports = await runControlChecks(contextFor());
    expect(reports.every((report) => report.target.kind === 'control')).toBe(
      true,
    );
    expect(reports.some((report) => report.status === 'fail')).toBe(false);
    expect(pick(reports, 'control.node')[0].status).toBe('ok');
  });

  it('fails a Node below the floor the package requires', async () => {
    const reports = await runControlChecks(
      contextFor({ nodeVersion: 'v20.19.0' }),
    );
    const report = pick(reports, 'control.node')[0];
    expect(report.status).toBe('fail');
    expect(report.fix).toContain('22.13');
  });

  it('fails a state directory grove cannot write', async () => {
    const reports = await runControlChecks(
      contextFor({
        access: async () => {
          throw new Error('EACCES: permission denied');
        },
      }),
    );
    const report = pick(reports, 'control.state-dir')[0];
    expect(report.status).toBe('fail');
    expect(report.fix).toContain('GROVE_STATE_DIR');
  });

  it('warns about a database other users can read', async () => {
    const reports = await runControlChecks(
      contextFor({ stat: async () => ({ mode: 0o100644 }) }),
    );
    const report = pick(reports, 'control.database-mode')[0];
    expect(report.status).toBe('warn');
    expect(report.fix).toContain('chmod 600');
  });

  it('skips the database mode when there is no database yet', async () => {
    const reports = await runControlChecks(
      contextFor({
        stat: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      }),
    );
    expect(pick(reports, 'control.database-mode')[0].status).toBe('skip');
  });

  it('fails when an ssh host is declared and there is no ssh binary', async () => {
    const reports = await runControlChecks(
      contextFor({
        transport: new FakeTransport('control')
          .fail('ssh -V', 'sh: ssh: command not found', 127)
          .on('sh -c command -v', { stdout: '/usr/local/bin/gh\n' })
          .on('test -f', { code: 1 }),
      }),
    );
    const report = pick(reports, 'control.ssh')[0];
    expect(report.status).toBe('fail');
    expect(report.fix).toContain('openssh');
  });

  it('skips ssh when every host is local', async () => {
    const reports = await runControlChecks(
      contextFor({
        config: configWith({
          hosts: { mac: { type: 'local' } },
        } as Partial<GroveConfig>),
      }),
    );
    expect(pick(reports, 'control.ssh')[0].status).toBe('skip');
  });

  it('fails when a forge delegates to a CLI that is not installed', async () => {
    const reports = await runControlChecks(
      contextFor({
        config: configWith({
          forges: { gh: { kind: 'github' } },
        } as unknown as Partial<GroveConfig>),
        transport: new FakeTransport('control')
          .on('ssh -V', { stderr: 'OpenSSH_9.6p1\n' })
          .fail('sh -c command -v gh', '', 1)
          .on('test -f', { code: 1 }),
      }),
    );
    const report = pick(reports, 'control.cli-delegation')[0];
    expect(report.status).toBe('fail');
    expect(report.summary).toContain('gh');
    expect(report.fix).toContain('gh auth login');
  });

  it('skips the CLI check when every forge carries an auth block', async () => {
    const reports = await runControlChecks(contextFor());
    expect(pick(reports, 'control.cli-delegation')[0].status).toBe('skip');
  });

  it('warns when the daemon is not installed', async () => {
    const reports = await runControlChecks(contextFor());
    const report = pick(reports, 'control.daemon')[0];
    expect(report.status).toBe('warn');
    expect(report.fix).toContain('grove daemon install');
  });

  it('passes when the daemon is installed and its pid is alive', async () => {
    store.setMeta(META_DAEMON_PID, '4242');
    const reports = await runControlChecks(
      contextFor({
        transport: new FakeTransport('control')
          .on('ssh -V', { stderr: 'OpenSSH_9.6p1\n' })
          .on('sh -c command -v', { stdout: '/usr/local/bin/gh\n' })
          .on('test -f', { code: 0 }),
      }),
    );
    const report = pick(reports, 'control.daemon')[0];
    expect(report.status).toBe('ok');
    expect(report.summary).toContain('4242');
  });

  it('warns when the exporter binds something other than loopback', async () => {
    const reports = await runControlChecks(
      contextFor({
        config: configWith({
          metrics: { listen: '0.0.0.0:9130', scrapeCacheMs: 10_000 },
        } as Partial<GroveConfig>),
      }),
    );
    const report = pick(reports, 'control.metrics-listen')[0];
    expect(report.status).toBe('warn');
    expect(report.fix).toContain('127.0.0.1');
  });

  it('skips the exporter check when no exporter is configured', async () => {
    expect(
      pick(await runControlChecks(contextFor()), 'control.metrics-listen')[0]
        .status,
    ).toBe('skip');
  });
});
