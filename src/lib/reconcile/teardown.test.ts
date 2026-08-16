import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import type { DockerContainer } from '../stack/index.js';
import type { RunnerRecord } from '../state/index.js';
import type { Action } from './actions.js';
import type { ObservedState } from './observed.js';
import { planTeardown } from './teardown.js';

const SCOPE = { level: 'organization', target: 'Overload-coach' } as const;

function config(): GroveConfig {
  return {
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
        drain_timeout: 30_000,
      },
    ],
  } as GroveConfig;
}

function container(name: string): DockerContainer {
  return {
    name,
    containerId: 'abc',
    state: 'running',
    image: 'x',
    status: 'Up 1 hour',
    createdAt: 'now',
  };
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

function observed(names: string[], reachable = true): ObservedState {
  return {
    hosts: [
      {
        host: 'mac',
        reachable,
        ...(reachable ? {} : { reason: 'ssh timed out' }),
        containers: reachable ? names.map(container) : [],
        workRoots: {},
      },
    ],
    forges: [
      {
        forge: 'gh-overload',
        reachable: true,
        runners: names.map((name, index) => ({
          scope: SCOPE,
          runner: {
            id: String(index + 11),
            name,
            status: 'online' as const,
            busy: false,
            labels: [],
          },
        })),
      },
    ],
  };
}

// The same fleet with the container gone, so the runner is only at the forge.
function forgeOnly(names: string[]): ObservedState {
  const state = observed(names);
  return {
    hosts: state.hosts.map((host) => ({ ...host, containers: [] })),
    forges: state.forges,
  };
}

function kinds(actions: Action[]): string[] {
  return actions.map((action) => action.kind);
}

describe('planTeardown', () => {
  it('removes a managed runner even though the config still wants it', () => {
    const actions = planTeardown(config(), observed(['grove-overload-arm-1']), [
      record('grove-overload-arm-1'),
    ]);
    expect(kinds(actions)).toEqual([
      'stop-container',
      'deregister-runner',
      'remove-container',
      'retire-record',
    ]);
    expect(actions[0]).toMatchObject({ drainTimeoutMs: 30_000 });
  });

  it('leaves an unmanaged runner alone by default', () => {
    const actions = planTeardown(
      config(),
      observed(['grove-overload-arm-1']),
      [],
    );
    expect(kinds(actions)).toEqual(['report-unmanaged']);
    expect(actions[0]).toMatchObject({
      where: 'container on mac, runner at gh-overload',
    });
  });

  it('removes an unmanaged runner when asked', () => {
    const actions = planTeardown(
      config(),
      observed(['grove-overload-arm-1']),
      [],
      {
        includeUnmanaged: true,
      },
    );
    expect(kinds(actions)).toEqual([
      'stop-container',
      'deregister-runner',
      'remove-container',
    ]);
  });

  it('never touches a foreign runner', () => {
    const actions = planTeardown(config(), observed(['someone-else']), [], {
      includeUnmanaged: true,
    });
    expect(actions).toEqual([]);
  });

  it('degrades an unreachable host rather than deleting its forge record', () => {
    const actions = planTeardown(
      config(),
      observed(['grove-overload-arm-1'], false),
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'report-degraded']);
    expect(actions[1]).toMatchObject({
      target: 'grove-overload-arm-1',
      host: 'mac',
      reason:
        'host "mac" is unreachable, so grove leaves this runner and its forge record alone',
    });
  });

  it('degrades a host the observation never covered', () => {
    const state = observed(['grove-overload-arm-1']);
    const actions = planTeardown(
      config(),
      { hosts: [], forges: state.forges },
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['report-degraded']);
    expect(actions[0]).toMatchObject({
      target: 'grove-overload-arm-1',
      reason:
        'host "mac" was not observed on this pass, so grove leaves this runner and its forge record alone',
    });
  });

  it('leaves a runner in place when its forge did not answer', () => {
    const state = observed(['grove-overload-arm-1']);
    const actions = planTeardown(
      config(),
      {
        hosts: state.hosts,
        forges: [
          {
            forge: 'gh-overload',
            reachable: false,
            reason: 'the forge did not answer',
            runners: [],
          },
        ],
      },
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'report-degraded']);
    expect(actions[1]).toMatchObject({
      target: 'grove-overload-arm-1',
      host: 'mac',
      reason:
        'forge "gh-overload" did not answer, so grove leaves this runner in place',
    });
  });

  it('leaves a runner in place when its forge was never observed', () => {
    const state = observed(['grove-overload-arm-1']);
    const actions = planTeardown(config(), { hosts: state.hosts, forges: [] }, [
      record('grove-overload-arm-1'),
    ]);
    expect(kinds(actions)).toEqual(['report-degraded']);
    expect(actions[0]).toMatchObject({
      target: 'grove-overload-arm-1',
      host: 'mac',
      reason:
        'forge "gh-overload" was not observed on this pass, so grove leaves this runner in place',
    });
  });

  it('deregisters a forge-only unmanaged runner without a host', () => {
    const actions = planTeardown(
      config(),
      forgeOnly(['grove-overload-arm-1']),
      [],
      { includeUnmanaged: true },
    );
    expect(kinds(actions)).toEqual(['deregister-runner']);
    expect(actions[0]).not.toHaveProperty('host');
  });

  it('leaves a forge-only unmanaged runner alone when a host did not answer', () => {
    const desired = config();
    desired.hosts = { mac: { type: 'local' }, atlas: { type: 'local' } };
    const state = forgeOnly(['grove-overload-arm-1']);
    state.hosts.push({
      host: 'atlas',
      reachable: false,
      reason: 'ssh timed out',
      containers: [],
      workRoots: {},
    });

    const actions = planTeardown(desired, state, [], {
      includeUnmanaged: true,
    });

    expect(kinds(actions)).toEqual(['report-degraded', 'report-degraded']);
    expect(actions[1]).toMatchObject({
      target: 'grove-overload-arm-1',
      reason:
        'host unknown and at least one host did not answer, so grove leaves runner "grove-overload-arm-1" alone',
    });
  });

  it('leaves a forge-only unmanaged runner alone when a host was never observed', () => {
    const desired = config();
    desired.hosts = { mac: { type: 'local' }, atlas: { type: 'local' } };

    const actions = planTeardown(
      desired,
      forgeOnly(['grove-overload-arm-1']),
      [],
      { includeUnmanaged: true },
    );

    expect(kinds(actions)).toEqual(['report-degraded']);
    expect(actions[0]).toMatchObject({
      target: 'grove-overload-arm-1',
      reason:
        'host unknown and at least one host did not answer, so grove leaves runner "grove-overload-arm-1" alone',
    });
  });

  it('leaves an orphan record alone when its forge did not answer', () => {
    const state = observed([]);
    const actions = planTeardown(
      config(),
      {
        hosts: state.hosts,
        forges: [
          {
            forge: 'gh-overload',
            reachable: false,
            reason: 'the forge did not answer',
            runners: [],
          },
        ],
      },
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'report-degraded']);
    expect(actions[1]).toMatchObject({
      target: 'grove-overload-arm-1',
      host: 'mac',
      reason:
        'forge "gh-overload" did not answer, so grove leaves this runner in place',
    });
  });

  it('reports a record with nothing behind it', () => {
    const actions = planTeardown(config(), observed([]), [
      record('grove-overload-arm-1'),
    ]);
    expect(kinds(actions)).toEqual(['report-orphan-record']);
  });
});

describe('planTeardown, a name that collides across hosts and forges', () => {
  // The record names hostA and forgeA. The same name also runs on hostB and is
  // also listed at forgeB. Those two are the unmanaged cell of the ownership
  // table, and teardown must leave them where they are.
  function collidingConfig(): GroveConfig {
    return {
      tick: { fast: 120_000, full: 1_800_000 },
      hosts: { 'host-a': { type: 'local' }, 'host-b': { type: 'local' } },
      forges: { 'gh-a': { kind: 'github' }, 'gh-b': { kind: 'github' } },
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-a',
          scope: SCOPE,
          placement: { 'host-a': 1 },
          stack: 'docker',
          drain_timeout: 30_000,
        },
      ],
    } as GroveConfig;
  }

  const SCOPE_B = { level: 'organization', target: 'Someone-else' } as const;

  function collidingState(): ObservedState {
    const name = 'grove-overload-arm-1';
    return {
      hosts: [
        {
          host: 'host-b',
          reachable: true,
          containers: [container(name)],
          workRoots: {},
        },
        {
          host: 'host-a',
          reachable: true,
          containers: [container(name)],
          workRoots: {},
        },
      ],
      forges: [
        {
          forge: 'gh-b',
          reachable: true,
          runners: [
            {
              scope: SCOPE_B,
              runner: {
                id: '999',
                name,
                status: 'online' as const,
                busy: false,
                labels: [],
              },
            },
          ],
        },
        {
          forge: 'gh-a',
          reachable: true,
          runners: [
            {
              scope: SCOPE,
              runner: {
                id: '111',
                name,
                status: 'online' as const,
                busy: false,
                labels: [],
              },
            },
          ],
        },
      ],
    };
  }

  function collidingRecord(): RunnerRecord {
    return { ...record('grove-overload-arm-1'), host: 'host-a', forge: 'gh-a' };
  }

  it('destroys only on the host and at the forge its record names', () => {
    const actions = planTeardown(collidingConfig(), collidingState(), [
      collidingRecord(),
    ]);

    const destructive = actions.filter((action) => action.destructive);
    expect(kinds(destructive)).toEqual([
      'stop-container',
      'deregister-runner',
      'remove-container',
      'retire-record',
    ]);
    for (const action of destructive) {
      expect(action).toMatchObject({ host: 'host-a' });
    }
    expect(destructive[1]).toMatchObject({
      forge: 'gh-a',
      scope: SCOPE,
      forgeRunnerId: '111',
    });
    expect(
      actions.some((action) => 'forge' in action && action.forge === 'gh-b'),
    ).toBe(false);
  });

  it('reports the colliding host and forge as unmanaged', () => {
    const actions = planTeardown(collidingConfig(), collidingState(), [
      collidingRecord(),
    ]);

    const unmanaged = actions.filter(
      (action) => action.kind === 'report-unmanaged',
    );
    expect(unmanaged).toHaveLength(1);
    expect(unmanaged[0]).toMatchObject({
      name: 'grove-overload-arm-1',
      host: 'host-b',
      where: 'container on host-b, runner at gh-b',
    });
  });

  it('still destroys nothing at the colliding forge with --include-unmanaged', () => {
    const actions = planTeardown(
      collidingConfig(),
      collidingState(),
      [collidingRecord()],
      { includeUnmanaged: true },
    );

    const deregisters = actions.filter(
      (action) => action.kind === 'deregister-runner',
    );
    expect(deregisters).toHaveLength(2);
    expect(deregisters[0]).toMatchObject({
      host: 'host-a',
      forge: 'gh-a',
      forgeRunnerId: '111',
    });
    expect(deregisters[1]).toMatchObject({
      host: 'host-b',
      forge: 'gh-b',
      forgeRunnerId: '999',
    });
  });
});
