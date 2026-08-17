import { describe, expect, it } from 'vitest';
import type { GroveConfig, LoadedConfig } from '../config/index.js';
import type { ObservedState } from '../reconcile/index.js';
import type { RunnerRecord } from '../state/index.js';
import { buildStatusReport, hostLivenessFor, livenessFor } from './report.js';

const SCOPE = { level: 'organization', target: 'Overload-coach' } as const;

function loaded(): LoadedConfig {
  const config: GroveConfig = {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { mac: { type: 'local' } },
    forges: { 'gh-overload': { kind: 'github' } },
    groups: [
      {
        name: 'overload-arm',
        forge: 'gh-overload',
        scope: SCOPE,
        placement: { mac: 1 },
        stack: 'docker',
      },
    ],
  } as GroveConfig;
  return { path: '/work/grove.yaml', config, warnings: [] };
}

function record(name: string, id = 1): RunnerRecord {
  return {
    id,
    group: 'overload-arm',
    index: 1,
    host: 'mac',
    forge: 'gh-overload',
    forgeRunnerId: null,
    systemId: null,
    installDir: null,
    workDir: null,
    stack: 'docker',
    name,
    createdAt: 0,
    retiredAt: null,
  };
}

function observed(): ObservedState {
  return {
    hosts: [
      {
        host: 'mac',
        reachable: true,
        containers: [
          {
            name: 'grove-overload-arm-1',
            containerId: 'abc',
            state: 'running',
            image: 'ghcr.io/actions/actions-runner:latest',
            status: 'Up 3 hours',
            createdAt: 'now',
          },
        ],
        workRoots: {},
      },
    ],
    forges: [
      {
        forge: 'gh-overload',
        reachable: true,
        runners: [
          {
            scope: SCOPE,
            runner: {
              id: '11',
              name: 'grove-overload-arm-1',
              status: 'online',
              busy: true,
              labels: ['arm64'],
            },
          },
        ],
      },
    ],
  };
}

describe('buildStatusReport', () => {
  it('joins the container, the forge runner and the record into one row', () => {
    const report = buildStatusReport(loaded(), observed(), [
      record('grove-overload-arm-1'),
    ]);
    expect(report.rows).toEqual([
      {
        group: 'overload-arm',
        host: 'mac',
        runner: 'grove-overload-arm-1',
        stack: 'docker',
        process: 'running',
        detail: 'Up 3 hours',
        forge: 'gh-overload',
        forgeStatus: 'busy',
        ownership: 'managed',
        recordId: 1,
      },
    ]);
    expect(report.ok).toBe(true);
  });

  it('shows a record with no container as missing', () => {
    const state = observed();
    state.hosts[0].containers = [];
    state.forges[0].runners = [];
    const report = buildStatusReport(loaded(), state, [
      record('grove-overload-arm-1'),
    ]);
    expect(report.rows[0]).toMatchObject({
      process: 'missing',
      forgeStatus: 'unknown',
      ownership: 'record-only',
    });
  });

  it('lists an unmanaged runner without a record', () => {
    const report = buildStatusReport(loaded(), observed(), []);
    expect(report.rows[0]).toMatchObject({
      ownership: 'unmanaged',
      recordId: undefined,
    });
  });

  it('gives two same-named runners on different hosts a row each', () => {
    const state = observed();
    state.hosts.push({
      host: 'atlas',
      reachable: true,
      containers: [
        {
          name: 'grove-overload-arm-1',
          containerId: 'def',
          state: 'exited',
          image: 'ghcr.io/actions/actions-runner:latest',
          status: 'Exited (0) 1 hour ago',
          createdAt: 'now',
        },
      ],
      workRoots: {},
    });

    const report = buildStatusReport(loaded(), state, [
      record('grove-overload-arm-1'),
    ]);

    expect(report.rows).toHaveLength(2);
    expect(report.rows.map((row) => [row.host, row.ownership])).toEqual([
      ['atlas', 'unmanaged'],
      ['mac', 'managed'],
    ]);
    expect(report.rows[0]).toMatchObject({
      process: 'exited',
      recordId: undefined,
    });
    expect(report.rows[1]).toMatchObject({ process: 'running', recordId: 1 });
  });

  it('reports unreachable hosts and forges and is not ok', () => {
    const state = observed();
    state.hosts[0] = {
      host: 'mac',
      reachable: false,
      reason: 'down',
      containers: [],
      workRoots: {},
    };
    state.forges[0] = {
      forge: 'gh-overload',
      reachable: false,
      reason: 'rate limited',
      runners: [],
    };
    const report = buildStatusReport(loaded(), state, []);
    expect(report.unreachableHosts).toEqual(['mac']);
    expect(report.unreachableForges).toEqual(['gh-overload']);
    expect(report.ok).toBe(false);
  });
});

describe('livenessFor', () => {
  it('maps a row to the sample grove stores', () => {
    const rows = buildStatusReport(loaded(), observed(), [
      record('grove-overload-arm-1'),
    ]).rows;
    expect(livenessFor(rows[0])).toBe('busy');
    expect(livenessFor({ ...rows[0], forgeStatus: 'online' })).toBe('online');
    expect(
      livenessFor({ ...rows[0], process: 'missing', forgeStatus: 'unknown' }),
    ).toBe('missing');
    expect(
      livenessFor({ ...rows[0], process: 'exited', forgeStatus: 'offline' }),
    ).toBe('offline');
  });
});

describe('buildStatusReport, a GitLab group', () => {
  const GITLAB_SCOPE = { level: 'instance' } as const;

  const loaded = {
    path: '/tmp/grove.yaml',
    warnings: [],
    config: {
      tick: { fast: 120_000, full: 1_800_000 },
      hosts: { atlas: { type: 'ssh', host: 'atlas' } },
      forges: { 'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' } },
      groups: [
        {
          name: 'chevro-dind',
          forge: 'gl-chevro',
          scope: GITLAB_SCOPE,
          placement: { atlas: 3 },
          stack: 'docker',
          tags: ['docker', 'dind'],
        },
      ],
    },
  } as unknown as LoadedConfig;

  function gitlabRecord(index: number, systemId: string | null): RunnerRecord {
    return {
      id: index,
      group: 'chevro-dind',
      index,
      host: 'atlas',
      forge: 'gl-chevro',
      forgeRunnerId: '48',
      systemId,
      installDir: null,
      workDir: null,
      stack: 'docker',
      name: `grove-chevro-dind-${index}`,
      createdAt: 0,
      retiredAt: null,
    };
  }

  const observed: ObservedState = {
    hosts: [{ host: 'atlas', reachable: true, containers: [], workRoots: {} }],
    forges: [
      {
        forge: 'gl-chevro',
        reachable: true,
        shared: true,
        runners: [
          {
            runner: {
              id: '48',
              name: 'grove-chevro-dind',
              status: 'online',
              busy: false,
              labels: ['docker', 'dind'],
              managers: [
                {
                  systemId: 's_aaaaaaaaaaaa',
                  status: 'online',
                  busy: true,
                  contactedAt: '2026-08-16T10:00:00Z',
                },
                { systemId: 'r_bbbbbbbbbbbb', status: 'stale', busy: false },
              ],
            },
            scope: GITLAB_SCOPE,
          },
        ],
      },
    ],
  };

  it('carries the manager that belongs to each runner', () => {
    const report = buildStatusReport(loaded, observed, [
      gitlabRecord(1, 's_aaaaaaaaaaaa'),
      gitlabRecord(2, 'r_bbbbbbbbbbbb'),
    ]);

    expect(
      report.rows.map((row) => [row.runner, row.systemId, row.managerStatus]),
    ).toEqual([
      ['grove-chevro-dind-1', 's_aaaaaaaaaaaa', 'online'],
      ['grove-chevro-dind-2', 'r_bbbbbbbbbbbb', 'stale'],
    ]);
    expect(report.rows[0].forgeStatus).toBe('busy');
    expect(report.rows[0].contactedAt).toBe('2026-08-16T10:00:00Z');
    expect(report.rows[1].forgeStatus).toBe('offline');
  });

  it('leaves the manager fields out when grove has no system id yet', () => {
    const report = buildStatusReport(loaded, observed, [gitlabRecord(1, null)]);
    expect(report.rows[0].systemId).toBeUndefined();
    expect(report.rows[0].managerStatus).toBeUndefined();
  });

  it('names the entity, its tags and how many managers answer', () => {
    const report = buildStatusReport(loaded, observed, [
      gitlabRecord(1, 's_aaaaaaaaaaaa'),
    ]);
    expect(report.sharedRunners).toEqual([
      {
        forge: 'gl-chevro',
        group: 'chevro-dind',
        entityId: '48',
        description: 'grove-chevro-dind',
        tags: ['docker', 'dind'],
        managers: 2,
        expected: 3,
      },
    ]);
  });

  it('has no shared runner section for a fleet with none', () => {
    const githubReport = buildStatusReport(
      loaded,
      { hosts: [], forges: [] },
      [],
    );
    expect(githubReport.sharedRunners).toEqual([]);
  });
});

describe('buildStatusReport, native seats', () => {
  const unit = {
    name: 'grove-ios-1',
    unit: 'com.cestoliv.grove.ios-1',
    state: 'running' as const,
    pid: 4242,
    detail: 'pid 4242',
  };

  // The loaded() helper at the top of this file declares one Docker group, so
  // a native fleet gets its own.
  function nativeLoaded(): LoadedConfig {
    const config: GroveConfig = {
      tick: { fast: 120_000, full: 1_800_000 },
      hosts: { mac: { type: 'local' } },
      forges: { 'gh-overload': { kind: 'github' } },
      groups: [
        {
          name: 'ios',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'native',
        },
      ],
    } as GroveConfig;
    return { path: '/work/grove.yaml', config, warnings: [] };
  }

  it('names the stack, the process state and what the host said', () => {
    const report = buildStatusReport(
      nativeLoaded(),
      {
        hosts: [
          {
            host: 'mac',
            reachable: true,
            containers: [],
            natives: [unit],
            workRoots: {},
          },
        ],
        forges: [{ forge: 'gh-overload', reachable: true, runners: [] }],
      },
      [],
    );

    expect(report.rows[0]).toMatchObject({
      group: 'ios',
      runner: 'grove-ios-1',
      stack: 'native',
      process: 'running',
      detail: 'pid 4242',
      ownership: 'unmanaged',
    });
  });

  it('calls a Docker seat docker, and a record with nothing behind it missing', () => {
    const report = buildStatusReport(
      loaded(),
      {
        hosts: [
          { host: 'mac', reachable: true, containers: [], workRoots: {} },
        ],
        forges: [{ forge: 'gh-overload', reachable: true, runners: [] }],
      },
      [
        {
          id: 1,
          group: 'overload-arm',
          index: 1,
          host: 'mac',
          forge: 'gh-overload',
          forgeRunnerId: null,
          systemId: null,
          installDir: null,
          workDir: null,
          stack: 'docker',
          name: 'grove-overload-arm-1',
          createdAt: 0,
          retiredAt: null,
        },
      ],
    );

    expect(report.rows[0]).toMatchObject({
      stack: 'docker',
      process: 'missing',
      detail: '',
    });
  });
});

describe('hostLivenessFor', () => {
  // The fast tick calls no forge, so every row it builds reads `unknown` at
  // the forge and livenessFor would call a running seat offline.
  it('reads the host and nothing else', () => {
    const row = {
      group: 'ios',
      host: 'mac',
      runner: 'grove-ios-1',
      stack: 'docker' as const,
      process: 'running',
      detail: 'Up 2 hours',
      forge: 'gh-overload',
      forgeStatus: 'unknown' as const,
      ownership: 'managed' as const,
    };
    expect(hostLivenessFor(row)).toBe('online');
    expect(hostLivenessFor({ ...row, process: 'exited' })).toBe('offline');
    expect(hostLivenessFor({ ...row, process: 'missing' })).toBe('missing');
    // Even when the forge did answer, this reads only the host.
    expect(hostLivenessFor({ ...row, forgeStatus: 'busy' })).toBe('online');
  });
});

describe('the daemon and the suspects', () => {
  it('carries what the caller read out of the store and the lockfile', () => {
    const built = buildStatusReport(loaded(), observed(), [], {
      suspects: [
        {
          runner: 'grove-ios-1',
          host: 'mac',
          since: 1_700_000_000_000,
          reason: 'the forge says busy and the work dir reads as unknown',
        },
      ],
      daemon: {
        lockPath: '/state/grove.pid',
        pid: 4242,
        command: 'daemon',
        alive: true,
        lastFastTick: 1_700_000_000_000,
      },
    });

    expect(built.suspects).toHaveLength(1);
    expect(built.daemon?.pid).toBe(4242);
  });

  it('defaults to no suspects and no daemon', () => {
    const built = buildStatusReport(loaded(), observed(), []);
    expect(built.suspects).toEqual([]);
    expect(built.daemon).toBeUndefined();
  });
});

describe('buildStatusReport, storage', () => {
  it('carries what the caller measured', () => {
    const report = buildStatusReport(loaded(), observed(), [], {
      storage: [
        {
          host: 'mac',
          docker: {
            imagesBytes: 4_000_000_000,
            imagesReclaimableBytes: 1_000_000_000,
            containersBytes: 0,
            volumesBytes: 0,
            buildCacheBytes: 0,
          },
          workDirBytes: 2048,
          workDirs: [{ name: 'grove-overload-arm-1', bytes: 2048 }],
        },
      ],
    });

    expect(report.storage).toHaveLength(1);
    expect(report.storage[0].host).toBe('mac');
  });

  it('is an empty list when the caller measured nothing', () => {
    expect(buildStatusReport(loaded(), observed(), []).storage).toEqual([]);
  });
});
