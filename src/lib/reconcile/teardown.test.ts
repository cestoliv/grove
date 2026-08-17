import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import type { DockerContainer } from '../stack/index.js';
import type { RunnerRecord } from '../state/index.js';
import type { Action } from './actions.js';
import type { ForgeObservation, ObservedState } from './observed.js';
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
    systemId: null,
    installDir: null,
    workDir: null,
    stack: 'docker',
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

describe('planTeardown, a GitLab group', () => {
  const GITLAB_SCOPE = { level: 'instance' } as const;

  function gitlabConfig(): GroveConfig {
    return {
      tick: { fast: 120_000, full: 1_800_000 },
      hosts: { atlas: { type: 'ssh', host: 'atlas' } },
      forges: { 'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' } },
      groups: [
        {
          name: 'chevro-dind',
          forge: 'gl-chevro',
          scope: GITLAB_SCOPE,
          placement: { atlas: 2 },
          stack: 'docker',
        },
      ],
    } as GroveConfig;
  }

  function gitlabRecord(
    index: number,
    systemId: string | null = null,
  ): RunnerRecord {
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

  function gitlabContainer(name: string): DockerContainer {
    return {
      name,
      containerId: name,
      state: 'running',
      image: 'gitlab/gitlab-runner:latest',
      status: 'Up 3 hours',
      createdAt: 'now',
    };
  }

  function entityForge(
    managers: Array<{ systemId: string; status: string; busy: boolean }> = [],
  ): ForgeObservation {
    return {
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
            labels: ['docker'],
            managers,
          },
          scope: GITLAB_SCOPE,
        },
      ],
    };
  }

  const registration = {
    id: 7,
    group: 'chevro-dind',
    forge: 'gl-chevro',
    forgeRunnerId: '48',
    url: 'https://git.chevro.fr',
    token: ['glrt', 'K1l2M3n4O5p6Q7r8S9t0'].join('-'),
    createdAt: 1,
    retiredAt: null,
  };

  it('stops every container, then deletes the one entity, last', () => {
    const actions = planTeardown(
      gitlabConfig(),
      {
        hosts: [
          {
            host: 'atlas',
            reachable: true,
            containers: [
              gitlabContainer('grove-chevro-dind-1'),
              gitlabContainer('grove-chevro-dind-2'),
            ],
            workRoots: {},
          },
        ],
        forges: [
          entityForge([
            { systemId: 's_1', status: 'online', busy: false },
            { systemId: 's_2', status: 'online', busy: false },
          ]),
        ],
      },
      [gitlabRecord(1, 's_1'), gitlabRecord(2, 's_2')],
      { registrations: [registration] },
    );

    expect(actions.map((action) => action.kind)).toEqual([
      'stop-container',
      'remove-container',
      'retire-record',
      'stop-container',
      'remove-container',
      'retire-record',
      'delete-shared-runner',
    ]);
    expect(actions.at(-1)).toMatchObject({
      forgeRunnerId: '48',
      registrationId: 7,
      group: 'chevro-dind',
    });
  });

  it('never deregisters a single manager', () => {
    const actions = planTeardown(
      gitlabConfig(),
      {
        hosts: [
          {
            host: 'atlas',
            reachable: true,
            containers: [gitlabContainer('grove-chevro-dind-1')],
            workRoots: {},
          },
        ],
        forges: [
          entityForge([{ systemId: 's_1', status: 'online', busy: false }]),
        ],
      },
      [gitlabRecord(1, 's_1')],
    );
    expect(actions.some((action) => action.kind === 'deregister-runner')).toBe(
      false,
    );
  });

  it('keeps the entity when one manager could not be torn down', () => {
    const actions = planTeardown(
      gitlabConfig(),
      {
        hosts: [
          {
            host: 'atlas',
            reachable: true,
            containers: [gitlabContainer('grove-chevro-dind-1')],
            workRoots: {},
          },
          {
            host: 'nuc',
            reachable: false,
            reason: 'ssh timed out',
            containers: [],
            workRoots: {},
          },
        ],
        forges: [entityForge()],
      },
      [gitlabRecord(1), { ...gitlabRecord(2), host: 'nuc' }],
      { registrations: [registration] },
    );

    expect(
      actions.some((action) => action.kind === 'delete-shared-runner'),
    ).toBe(false);
    expect(
      actions.some(
        (action) =>
          action.kind === 'report-degraded' &&
          action.reason.includes('runner entity at gl-chevro stays'),
      ),
    ).toBe(true);
  });

  it('reports an entity with nothing behind it and leaves it alone', () => {
    const actions = planTeardown(
      gitlabConfig(),
      {
        hosts: [
          { host: 'atlas', reachable: true, containers: [], workRoots: {} },
        ],
        forges: [entityForge()],
      },
      [],
    );
    expect(actions).toEqual([
      {
        kind: 'report-unmanaged',
        name: 'grove-chevro-dind',
        where: 'runner entity 48 at gl-chevro',
        destructive: false,
      },
    ]);
  });

  it('removes that entity when the operator opts in', () => {
    const actions = planTeardown(
      gitlabConfig(),
      {
        hosts: [
          { host: 'atlas', reachable: true, containers: [], workRoots: {} },
        ],
        forges: [entityForge()],
      },
      [],
      { includeUnmanaged: true },
    );
    expect(actions.map((action) => action.kind)).toEqual([
      'delete-shared-runner',
    ]);
  });

  it('leaves a row that names another entity alone', () => {
    const actions = planTeardown(
      gitlabConfig(),
      {
        hosts: [
          {
            host: 'atlas',
            reachable: true,
            containers: [gitlabContainer('grove-chevro-dind-1')],
            workRoots: {},
          },
        ],
        forges: [
          entityForge([{ systemId: 's_1', status: 'online', busy: false }]),
        ],
      },
      [gitlabRecord(1, 's_1')],
      { registrations: [{ ...registration, forgeRunnerId: '99' }] },
    );

    const deletion = actions.find(
      (action) => action.kind === 'delete-shared-runner',
    );
    expect(deletion).toMatchObject({ forgeRunnerId: '48' });
    expect(deletion).not.toHaveProperty('registrationId');
  });

  it('deletes an entity no record points at when a row names it', () => {
    const actions = planTeardown(
      gitlabConfig(),
      {
        hosts: [
          { host: 'atlas', reachable: true, containers: [], workRoots: {} },
        ],
        forges: [entityForge()],
      },
      [],
      { registrations: [registration] },
    );

    expect(actions).toEqual([
      {
        kind: 'delete-shared-runner',
        forge: 'gl-chevro',
        scope: GITLAB_SCOPE,
        group: 'chevro-dind',
        name: 'grove-chevro-dind',
        forgeRunnerId: '48',
        registrationId: 7,
        destructive: true,
      },
    ]);
  });

  it('reports an entity no record points at when the row names another', () => {
    const actions = planTeardown(
      gitlabConfig(),
      {
        hosts: [
          { host: 'atlas', reachable: true, containers: [], workRoots: {} },
        ],
        forges: [entityForge()],
      },
      [],
      { registrations: [{ ...registration, forgeRunnerId: '99' }] },
    );

    expect(actions).toEqual([
      {
        kind: 'report-unmanaged',
        name: 'grove-chevro-dind',
        where: 'runner entity 48 at gl-chevro',
        destructive: false,
      },
    ]);
  });

  it('says nothing about a forge that did not answer', () => {
    const actions = planTeardown(
      gitlabConfig(),
      {
        hosts: [
          { host: 'atlas', reachable: true, containers: [], workRoots: {} },
        ],
        forges: [{ ...entityForge(), reachable: false, reason: '502' }],
      },
      [],
    );
    expect(
      actions.some((action) => action.kind === 'delete-shared-runner'),
    ).toBe(false);
  });
});

describe('planTeardown, native seats', () => {
  const unit = {
    name: 'grove-ios-1',
    unit: 'com.cestoliv.grove.ios-1',
    state: 'running' as const,
    pid: 4242,
    detail: 'pid 4242',
  };

  function iosRecord(): RunnerRecord {
    return {
      id: 1,
      group: 'ios',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      forgeRunnerId: '7',
      systemId: null,
      installDir: null,
      workDir: null,
      stack: 'native',
      name: 'grove-ios-1',
      createdAt: 0,
      retiredAt: null,
    };
  }

  // The observed() helper at the top of this file builds containers from a
  // list of names, so a native fleet gets its own builder here.
  function nativeObserved(
    hostOverrides: Record<string, unknown> = {},
    listed = true,
  ): ObservedState {
    return {
      hosts: [
        {
          host: 'mac',
          reachable: true,
          containers: [],
          natives: [unit],
          workRoots: {},
          ...hostOverrides,
        },
      ],
      forges: [
        {
          forge: 'gh-overload',
          reachable: true,
          runners: listed
            ? [
                {
                  runner: {
                    id: '7',
                    name: 'grove-ios-1',
                    status: 'online' as const,
                    busy: false,
                    labels: ['macos'],
                  },
                  scope: SCOPE,
                },
              ]
            : [],
        },
      ],
    } as ObservedState;
  }

  it('drains, deregisters, removes and retires a native seat', () => {
    const actions = planTeardown(config(), nativeObserved(), [iosRecord()]);

    expect(actions).toEqual([
      {
        kind: 'stop-container',
        host: 'mac',
        name: 'grove-ios-1',
        stack: 'native',
        recordId: 1,
        drainTimeoutMs: 120_000,
        destructive: true,
      },
      {
        kind: 'deregister-runner',
        host: 'mac',
        forge: 'gh-overload',
        scope: SCOPE,
        name: 'grove-ios-1',
        forgeRunnerId: '7',
        recordId: 1,
        destructive: true,
      },
      {
        kind: 'remove-container',
        host: 'mac',
        name: 'grove-ios-1',
        stack: 'native',
        recordId: 1,
        destructive: true,
      },
      {
        kind: 'retire-record',
        host: 'mac',
        name: 'grove-ios-1',
        recordId: 1,
        destructive: true,
      },
    ]);
  });

  it('leaves a seat alone when its own supervisor did not answer', () => {
    const actions = planTeardown(
      config(),
      nativeObserved({ nativesError: 'mac: launchctl list failed: exit 1' }),
      [iosRecord()],
    );

    expect(actions.map((action) => action.kind)).toEqual(['report-degraded']);
    expect(actions[0]).toMatchObject({
      target: 'grove-ios-1',
      reason: 'mac: launchctl list failed: exit 1',
    });
  });

  it('removes a native seat on a host that has no Docker', () => {
    const actions = planTeardown(
      config(),
      nativeObserved({ containersError: 'mac: docker ps failed: not found' }),
      [iosRecord()],
    );

    expect(kinds(actions)).toEqual([
      'stop-container',
      'deregister-runner',
      'remove-container',
      'retire-record',
    ]);
  });

  // The record names the supervisor that held the seat, and that is the one
  // whose silence counts. Nothing else on the host can speak for it.
  it('retires a native record whose unit is gone', () => {
    const actions = planTeardown(
      config(),
      nativeObserved({
        natives: [],
        containersError: 'mac: docker ps failed: not found',
      }),
      [iosRecord()],
    );

    expect(kinds(actions)).toEqual(['deregister-runner', 'retire-record']);
  });

  it('leaves a native record with no unit alone when launchctl went blind', () => {
    const actions = planTeardown(
      config(),
      nativeObserved({
        natives: [],
        nativesError: 'mac: launchctl list failed: exit 1',
      }),
      [iosRecord()],
    );

    expect(kinds(actions)).toEqual(['report-degraded']);
    expect(actions[0]).toMatchObject({
      target: 'grove-ios-1',
      reason: 'mac: launchctl list failed: exit 1',
    });
  });

  it('reports a native record with nothing behind it', () => {
    const actions = planTeardown(
      config(),
      nativeObserved({ natives: [] }, false),
      [iosRecord()],
    );

    expect(kinds(actions)).toEqual(['report-orphan-record']);
  });

  it('leaves a native record with nothing behind it alone when launchctl went blind', () => {
    const actions = planTeardown(
      config(),
      nativeObserved(
        { natives: [], nativesError: 'mac: launchctl list failed: exit 1' },
        false,
      ),
      [iosRecord()],
    );

    expect(kinds(actions)).toEqual(['report-degraded']);
    expect(actions[0]).toMatchObject({
      target: 'grove-ios-1',
      host: 'mac',
      reason: 'mac: launchctl list failed: exit 1',
    });
  });

  // A Docker record must not be held back by a supervisor it never used. On a
  // Linux host with no user bus every pass carries a nativesError.
  it('retires a Docker record whose container is gone while launchctl is blind', () => {
    const state = forgeOnly(['grove-overload-arm-1']);
    state.hosts[0] = {
      ...state.hosts[0],
      natives: [],
      nativesError: 'mac: systemctl --user list-units failed: exit 1',
    } as (typeof state.hosts)[0];

    const actions = planTeardown(config(), state, [
      record('grove-overload-arm-1'),
    ]);

    expect(kinds(actions)).toEqual(['deregister-runner', 'retire-record']);
  });

  it('leaves an unmanaged native unit alone by default', () => {
    const actions = planTeardown(config(), nativeObserved({}, false), []);

    expect(actions).toEqual([
      {
        kind: 'report-unmanaged',
        name: 'grove-ios-1',
        where: 'unit on mac',
        host: 'mac',
        destructive: false,
      },
    ]);
  });

  it('removes an unmanaged native unit when the operator asks for it', () => {
    const actions = planTeardown(config(), nativeObserved({}, false), [], {
      includeUnmanaged: true,
    });

    expect(actions).toEqual([
      {
        kind: 'stop-container',
        host: 'mac',
        name: 'grove-ios-1',
        stack: 'native',
        drainTimeoutMs: 120_000,
        destructive: true,
      },
      {
        kind: 'remove-container',
        host: 'mac',
        name: 'grove-ios-1',
        stack: 'native',
        destructive: true,
      },
    ]);
  });

  // A container and a unit of one name on one host are two seats. The record
  // names the supervisor that holds its own, and the other one is not grove's.
  it('tears down the seat its record names and reports the other stack', () => {
    const state = nativeObserved();
    state.hosts[0] = {
      ...state.hosts[0],
      containers: [container('grove-ios-1')],
    };

    const actions = planTeardown(config(), state, [iosRecord()]);

    expect(kinds(actions)).toEqual([
      'stop-container',
      'deregister-runner',
      'remove-container',
      'retire-record',
      'report-unmanaged',
    ]);
    expect(actions[0]).toMatchObject({ stack: 'native' });
    expect(actions[4]).toMatchObject({
      name: 'grove-ios-1',
      where: 'container on mac',
    });
  });

  it('reports a Docker record with nothing behind it while launchctl is blind', () => {
    const state = observed([]);
    state.hosts[0] = {
      ...state.hosts[0],
      natives: [],
      nativesError: 'mac: systemctl --user list-units failed: exit 1',
    } as (typeof state.hosts)[0];

    const actions = planTeardown(config(), state, [
      record('grove-overload-arm-1'),
    ]);

    expect(kinds(actions)).toEqual(['report-orphan-record']);
  });
});
