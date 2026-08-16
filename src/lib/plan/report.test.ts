import { describe, expect, it } from 'vitest';
import type { GroveConfig, LoadedConfig } from '../config/index.js';
import type { Action, ObservedState } from '../reconcile/index.js';
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

function observedState(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    hosts: [
      {
        host: 'mac',
        reachable: true,
        platform: 'Darwin',
        arch: 'arm64',
        containers: [],
        workRoots: {},
      },
      {
        host: 'atlas',
        reachable: true,
        platform: 'Linux',
        arch: 'amd64',
        containers: [],
        workRoots: {},
      },
    ],
    forges: [],
    ...overrides,
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
  it('reports every host as reachable when every host answered', () => {
    const report = buildPlanReport(buildLoaded(), {
      observed: observedState(),
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

  it('marks an unreachable host and names the reason', () => {
    const observed = observedState();
    observed.hosts[1] = {
      host: 'atlas',
      reachable: false,
      reason: 'ssh: connect to host atlas port 22: No route to host',
      containers: [],
      workRoots: {},
    };
    const report = buildPlanReport(buildLoaded(), { observed });

    expect(report.ok).toBe(false);
    expect(report.unreachable).toEqual(['atlas']);
    expect(report.hosts[1].reachable).toBe(false);
    expect(report.hosts[1].reason).toBe(
      'ssh: connect to host atlas port 22: No route to host',
    );
    expect(report.hosts[1].arch).toBeUndefined();
  });

  it('describes every group grove would manage', () => {
    const report = buildPlanReport(buildLoaded(), {
      observed: observedState(),
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

  it('sums a map placement that spans hosts', () => {
    const loaded = buildLoaded();
    loaded.config.groups[0].placement = { mac: 2, atlas: 1 };
    const report = buildPlanReport(loaded, { observed: observedState() });
    expect(report.groups[0].placement).toEqual([
      { host: 'mac', count: 2 },
      { host: 'atlas', count: 1 },
    ]);
    expect(report.groups[0].total).toBe(3);
  });

  it('carries config warnings, arch warnings and extra warnings', () => {
    const loaded = buildLoaded();
    loaded.warnings = [
      {
        code: 'privileged-docker-socket',
        path: 'groups[1]',
        message: 'group "chevro-dind" runs privileged',
      },
    ];
    const observed = observedState();
    observed.hosts[1].arch = 'arm64';
    const report = buildPlanReport(loaded, {
      observed,
      extraWarnings: [
        { code: 'raw-unused', path: 'groups[0].raw.x', message: 'unused' },
      ],
    });

    expect(report.warnings.map((warning) => warning.code)).toEqual([
      'privileged-docker-socket',
      'arch-mismatch',
      'raw-unused',
    ]);
    expect(report.warnings[1].message).toContain(
      'asks for amd64 on host "atlas", which reports arm64',
    );
  });

  it('raises no arch warning for a host it could not observe', () => {
    const loaded = buildLoaded();
    const observed = observedState();
    observed.hosts[1] = {
      host: 'atlas',
      reachable: false,
      reason: 'down',
      containers: [],
      workRoots: {},
    };
    const report = buildPlanReport(loaded, { observed });
    expect(report.warnings).toEqual([]);
  });

  it('carries the actions and treats a degraded report as not ok', () => {
    const actions: Action[] = [
      {
        kind: 'report-degraded',
        target: 'grove-overload-arm-1',
        reason: 'the work root is not usable',
        host: 'mac',
        destructive: false,
      },
    ];
    const report = buildPlanReport(buildLoaded(), {
      observed: observedState(),
      actions,
    });
    expect(report.actions).toEqual(actions);
    expect(report.degraded).toEqual(['grove-overload-arm-1']);
    expect(report.ok).toBe(false);
  });
});
