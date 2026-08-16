import { describe, expect, it } from 'vitest';
import type { GroveConfig, LoadedConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import { buildPlanReport, formatScope } from './report.js';

function buildLoaded(): LoadedConfig {
  const config: GroveConfig = {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: {
      mac: { type: 'local', work_root: '/Volumes/ci/grove' },
      atlas: { type: 'ssh', host: 'atlas', work_root: '/PROD/local/grove' },
    },
    forges: {
      'gh-overload': { kind: 'github' },
      'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' },
    },
    groups: [
      {
        name: 'overload-arm',
        forge: 'gh-overload',
        scope: { level: 'organization', target: 'Overload-coach' },
        placement: { mac: 2 },
        stack: 'docker',
        arch: 'arm64',
      },
      {
        name: 'chevro-dind',
        forge: 'gl-chevro',
        scope: { level: 'instance' },
        placement: { atlas: 3 },
        stack: 'docker',
        arch: 'amd64',
      },
    ],
  };
  return { path: '/work/grove.yaml', config, warnings: [] };
}

function fakeConnect(transports: Record<string, FakeTransport>) {
  return (name: string) => {
    const transport = transports[name];
    if (transport === undefined) {
      throw new Error(`test has no transport for ${name}`);
    }
    return transport;
  };
}

describe('formatScope', () => {
  it('renders a level with a target', () => {
    expect(
      formatScope({ level: 'organization', target: 'Overload-coach' }),
    ).toBe('organization Overload-coach');
  });

  it('renders a level with no target', () => {
    expect(formatScope({ level: 'instance' })).toBe('instance');
  });
});

describe('buildPlanReport', () => {
  it('reports every host as reachable when every probe succeeds', async () => {
    const transports = {
      mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
      atlas: new FakeTransport('atlas').on('uname', {
        stdout: 'Linux x86_64\n',
      }),
    };
    const report = await buildPlanReport(buildLoaded(), {
      connect: fakeConnect(transports),
    });

    expect(report.configPath).toBe('/work/grove.yaml');
    expect(report.ok).toBe(true);
    expect(report.unreachable).toEqual([]);
    expect(report.hosts).toEqual([
      {
        name: 'mac',
        type: 'local',
        target: 'this machine',
        reachable: true,
        reason: undefined,
        arch: 'arm64',
      },
      {
        name: 'atlas',
        type: 'ssh',
        target: 'atlas',
        reachable: true,
        reason: undefined,
        arch: 'amd64',
      },
    ]);
  });

  it('marks an unreachable host and names the reason', async () => {
    const transports = {
      mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
      atlas: new FakeTransport('atlas').fail(
        'uname',
        'ssh: connect to host atlas port 22: No route to host',
        255,
      ),
    };
    const report = await buildPlanReport(buildLoaded(), {
      connect: fakeConnect(transports),
    });

    expect(report.ok).toBe(false);
    expect(report.unreachable).toEqual(['atlas']);
    expect(report.hosts[1].reachable).toBe(false);
    expect(report.hosts[1].reason).toBe(
      'ssh: connect to host atlas port 22: No route to host',
    );
    expect(report.hosts[1].arch).toBeUndefined();
  });

  it('describes every group grove would manage', async () => {
    const transports = {
      mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
      atlas: new FakeTransport('atlas').on('uname', {
        stdout: 'Linux x86_64\n',
      }),
    };
    const report = await buildPlanReport(buildLoaded(), {
      connect: fakeConnect(transports),
    });

    expect(report.groups).toEqual([
      {
        name: 'overload-arm',
        forge: 'gh-overload',
        forgeKind: 'github',
        scope: 'organization Overload-coach',
        stack: 'docker',
        arch: 'arm64',
        placement: [{ host: 'mac', count: 2 }],
        total: 2,
      },
      {
        name: 'chevro-dind',
        forge: 'gl-chevro',
        forgeKind: 'gitlab',
        scope: 'instance',
        stack: 'docker',
        arch: 'amd64',
        placement: [{ host: 'atlas', count: 3 }],
        total: 3,
      },
    ]);
  });

  it('sums a map placement that spans hosts', async () => {
    const loaded = buildLoaded();
    loaded.config.groups[0].placement = { mac: 2, atlas: 1 };
    const transports = {
      mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
      atlas: new FakeTransport('atlas').on('uname', {
        stdout: 'Linux aarch64\n',
      }),
    };
    const report = await buildPlanReport(loaded, {
      connect: fakeConnect(transports),
    });
    expect(report.groups[0].placement).toEqual([
      { host: 'mac', count: 2 },
      { host: 'atlas', count: 1 },
    ]);
    expect(report.groups[0].total).toBe(3);
  });

  it('carries the config warnings through and adds the arch mismatch warning', async () => {
    const loaded = buildLoaded();
    loaded.warnings = [
      {
        code: 'privileged-docker-socket',
        path: 'groups[1]',
        message: 'group "chevro-dind" runs privileged',
      },
    ];
    const transports = {
      mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
      atlas: new FakeTransport('atlas').on('uname', {
        stdout: 'Linux aarch64\n',
      }),
    };
    const report = await buildPlanReport(loaded, {
      connect: fakeConnect(transports),
    });

    expect(report.warnings.map((warning) => warning.code)).toEqual([
      'privileged-docker-socket',
      'arch-mismatch',
    ]);
    expect(report.warnings[1].message).toContain(
      'asks for amd64 on host "atlas", which reports arm64',
    );
  });

  it('raises no arch warning for a host it could not probe', async () => {
    const transports = {
      mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
      atlas: new FakeTransport('atlas').fail('uname', 'No route to host', 255),
    };
    const report = await buildPlanReport(buildLoaded(), {
      connect: fakeConnect(transports),
    });
    expect(report.warnings).toEqual([]);
  });

  it('closes every transport it opened', async () => {
    const transports = {
      mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
      atlas: new FakeTransport('atlas').fail('uname', 'No route to host', 255),
    };
    await buildPlanReport(buildLoaded(), { connect: fakeConnect(transports) });
    expect(transports.mac.closed).toBe(true);
    expect(transports.atlas.closed).toBe(true);
  });

  it('passes the probe timeout through', async () => {
    const transports = {
      mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
      atlas: new FakeTransport('atlas').on('uname', {
        stdout: 'Linux x86_64\n',
      }),
    };
    await buildPlanReport(buildLoaded(), {
      connect: fakeConnect(transports),
      probeTimeoutMs: 3000,
    });
    expect(transports.mac.calls[0].options?.timeoutMs).toBe(3000);
  });
});
