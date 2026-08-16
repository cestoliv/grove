import { describe, expect, it } from 'vitest';
import type { GroveConfig, LoadedConfig } from '../config/index.js';
import type { ObservedState } from '../reconcile/index.js';
import type { RunnerRecord } from '../state/index.js';
import { buildStatusReport, livenessFor } from './report.js';

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
        container: 'running',
        containerStatus: 'Up 3 hours',
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
      container: 'missing',
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
      container: 'exited',
      recordId: undefined,
    });
    expect(report.rows[1]).toMatchObject({ container: 'running', recordId: 1 });
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
      livenessFor({ ...rows[0], container: 'missing', forgeStatus: 'unknown' }),
    ).toBe('missing');
    expect(
      livenessFor({ ...rows[0], container: 'exited', forgeStatus: 'offline' }),
    ).toBe('offline');
  });
});
