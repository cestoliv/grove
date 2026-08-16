import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import type { DockerContainer } from '../stack/index.js';
import type { GroupRegistrationRecord, RunnerRecord } from '../state/index.js';
import type { Action } from './actions.js';
import type {
  ForgeObservation,
  HostObservation,
  ObservedState,
} from './observed.js';
import { reconcile } from './planner.js';

const SCOPE = { level: 'organization', target: 'Overload-coach' } as const;

function config(overrides: Partial<GroveConfig> = {}): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { mac: { type: 'local' }, atlas: { type: 'ssh', host: 'atlas' } },
    forges: { 'gh-overload': { kind: 'github' } },
    groups: [
      {
        name: 'overload-arm',
        forge: 'gh-overload',
        scope: SCOPE,
        placement: { mac: 2 },
        stack: 'docker',
      },
    ],
    ...overrides,
  } as GroveConfig;
}

function host(overrides: Partial<HostObservation> = {}): HostObservation {
  return {
    host: 'mac',
    reachable: true,
    containers: [],
    workRoots: {},
    ...overrides,
  };
}

function forge(overrides: Partial<ForgeObservation> = {}): ForgeObservation {
  return { forge: 'gh-overload', reachable: true, runners: [], ...overrides };
}

function observed(overrides: Partial<ObservedState> = {}): ObservedState {
  return { hosts: [host()], forges: [forge()], ...overrides };
}

function container(
  name: string,
  state: DockerContainer['state'] = 'running',
): DockerContainer {
  return {
    name,
    containerId: name,
    state,
    image: 'ghcr.io/actions/actions-runner:latest',
    status: state === 'running' ? 'Up 1 hour' : 'Exited (0) 1 hour ago',
    createdAt: 'now',
  };
}

function record(
  name: string,
  overrides: Partial<RunnerRecord> = {},
): RunnerRecord {
  const index = Number(name.slice(name.lastIndexOf('-') + 1));
  return {
    id: index,
    group: 'overload-arm',
    index,
    host: 'mac',
    forge: 'gh-overload',
    forgeRunnerId: null,
    systemId: null,
    name,
    createdAt: 0,
    retiredAt: null,
    ...overrides,
  };
}

function kinds(actions: Action[]): string[] {
  return actions.map((action) => action.kind);
}

describe('reconcile, an empty fleet', () => {
  it('creates every runner the config asks for', () => {
    const actions = reconcile(config(), observed(), []);
    expect(kinds(actions)).toEqual(['create-runner', 'create-runner']);
    expect(actions.map((action) => 'name' in action && action.name)).toEqual([
      'grove-overload-arm-1',
      'grove-overload-arm-2',
    ]);
  });

  it('numbers indexes across hosts for a map placement', () => {
    const desired = config({
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 2, atlas: 1 },
          stack: 'docker',
        },
      ],
    } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({ hosts: [host(), host({ host: 'atlas' })] }),
      [],
    );
    expect(
      actions.map((action) => [
        'host' in action ? action.host : undefined,
        'name' in action ? action.name : undefined,
      ]),
    ).toEqual([
      ['mac', 'grove-overload-arm-1'],
      ['mac', 'grove-overload-arm-2'],
      ['atlas', 'grove-overload-arm-3'],
    ]);
  });

  it('puts two groups on one host without interfering', () => {
    const desired = config({
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'docker',
        },
        {
          name: 'api',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'docker',
        },
      ],
    } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [host({ containers: [container('grove-overload-arm-1')] })],
      }),
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['create-runner']);
    expect(actions[0]).toMatchObject({ name: 'grove-api-1', group: 'api' });
  });
});

describe('reconcile, a converged fleet', () => {
  it('does nothing when every container runs and every record matches', () => {
    const actions = reconcile(
      config(),
      observed({
        hosts: [
          host({
            containers: [
              container('grove-overload-arm-1'),
              container('grove-overload-arm-2'),
            ],
          }),
        ],
      }),
      [record('grove-overload-arm-1'), record('grove-overload-arm-2')],
    );
    expect(actions).toEqual([]);
  });

  it('starts a container that exited', () => {
    const actions = reconcile(
      config({
        groups: [
          {
            name: 'overload-arm',
            forge: 'gh-overload',
            scope: SCOPE,
            placement: { mac: 1 },
            stack: 'docker',
          },
        ],
      } as Partial<GroveConfig>),
      observed({
        hosts: [
          host({ containers: [container('grove-overload-arm-1', 'exited')] }),
        ],
      }),
      [record('grove-overload-arm-1')],
    );
    expect(actions).toEqual([
      {
        kind: 'start-container',
        host: 'mac',
        name: 'grove-overload-arm-1',
        recordId: 1,
        destructive: false,
      },
    ]);
  });

  it('recreates a runner whose container is gone but whose record stands', () => {
    const actions = reconcile(
      config({
        groups: [
          {
            name: 'overload-arm',
            forge: 'gh-overload',
            scope: SCOPE,
            placement: { mac: 1 },
            stack: 'docker',
          },
        ],
      } as Partial<GroveConfig>),
      observed(),
      [record('grove-overload-arm-1')],
    );
    expect(actions).toEqual([
      {
        kind: 'create-runner',
        host: 'mac',
        forge: 'gh-overload',
        group: 'overload-arm',
        index: 1,
        name: 'grove-overload-arm-1',
        recordId: 1,
        destructive: false,
      },
    ]);
  });
});

describe('reconcile, scale down', () => {
  it('drains, deregisters, removes and retires, in that order', () => {
    const desired = config({
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'docker',
          drain_timeout: 90_000,
        },
      ],
    } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [
          host({
            containers: [
              container('grove-overload-arm-1'),
              container('grove-overload-arm-2'),
            ],
          }),
        ],
        forges: [
          forge({
            runners: [
              {
                scope: SCOPE,
                runner: {
                  id: '12',
                  name: 'grove-overload-arm-2',
                  status: 'online',
                  busy: false,
                  labels: [],
                },
              },
            ],
          }),
        ],
      }),
      [record('grove-overload-arm-1'), record('grove-overload-arm-2')],
    );
    expect(kinds(actions)).toEqual([
      'stop-container',
      'deregister-runner',
      'remove-container',
      'retire-record',
    ]);
    expect(actions[0]).toMatchObject({
      name: 'grove-overload-arm-2',
      drainTimeoutMs: 90_000,
    });
    expect(actions[1]).toMatchObject({ forgeRunnerId: '12', scope: SCOPE });
    expect(actions.every((action) => action.destructive)).toBe(true);
  });

  it('reports an orphan record when nothing is left behind it', () => {
    const desired = config({ groups: [] } as Partial<GroveConfig>);
    const actions = reconcile(desired, observed(), [
      record('grove-overload-arm-1'),
    ]);
    expect(kinds(actions)).toEqual(['report-orphan-record', 'retire-record']);
  });
});

describe('reconcile, an unreachable host', () => {
  it('degrades the host and leaves its runners alone', () => {
    const desired = config({
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1, atlas: 1 },
          stack: 'docker',
        },
      ],
    } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [
          host(),
          host({
            host: 'atlas',
            reachable: false,
            reason: 'ssh: no route to host',
          }),
        ],
      }),
      [],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'create-runner']);
    expect(actions[0]).toMatchObject({ target: 'atlas' });
    expect(actions[1]).toMatchObject({ host: 'mac' });
  });

  it('never deletes a forge record for a host it cannot see', () => {
    const desired = config({ groups: [] } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [host({ reachable: false, reason: 'ssh timed out' })],
        forges: [
          forge({
            runners: [
              {
                scope: SCOPE,
                runner: {
                  id: '11',
                  name: 'grove-overload-arm-1',
                  status: 'offline',
                  busy: false,
                  labels: [],
                },
              },
            ],
          }),
        ],
      }),
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'report-degraded']);
    expect(actions[1]).toMatchObject({
      target: 'grove-overload-arm-1',
      reason: expect.stringContaining('unreachable'),
    });
  });

  it('leaves a runner in place when its forge did not answer', () => {
    const desired = config({ groups: [] } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [host({ containers: [container('grove-overload-arm-1')] })],
        forges: [
          forge({ reachable: false, reason: 'API rate limit exceeded' }),
        ],
      }),
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'report-degraded']);
    expect(actions[1]).toMatchObject({ target: 'grove-overload-arm-1' });
  });
});

describe('reconcile, ownership', () => {
  it('reports a container whose name matches but has no record', () => {
    const desired = config({ groups: [] } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [host({ containers: [container('grove-overload-arm-1')] })],
      }),
      [],
    );
    expect(actions).toEqual([
      {
        kind: 'report-unmanaged',
        name: 'grove-overload-arm-1',
        where: 'container on mac',
        host: 'mac',
        destructive: false,
      },
    ]);
  });

  it('refuses to adopt an unmanaged container that occupies a desired name', () => {
    const desired = config({
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'docker',
        },
      ],
    } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [
          host({ containers: [container('grove-overload-arm-1', 'exited')] }),
        ],
      }),
      [],
    );
    expect(kinds(actions)).toEqual(['report-unmanaged']);
  });

  it('says nothing about a foreign runner', () => {
    const desired = config({ groups: [] } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        forges: [
          forge({
            runners: [
              {
                scope: SCOPE,
                runner: {
                  id: '99',
                  name: 'macbook-of-someone',
                  status: 'online',
                  busy: false,
                  labels: [],
                },
              },
            ],
          }),
        ],
      }),
      [],
    );
    expect(actions).toEqual([]);
  });
});

describe('reconcile, guards and unsupported stacks', () => {
  it('refuses to start a runner whose work root fell back to the boot disk', () => {
    const desired = config({
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'docker',
        },
      ],
    } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [
          host({
            workRoots: {
              'overload-arm': {
                guarded: true,
                ok: false,
                mountPoint: '/Volumes/ci',
                reason: '/Volumes/ci sits on the same device as /',
              },
            },
          }),
        ],
      }),
      [],
    );
    expect(kinds(actions)).toEqual(['report-degraded']);
    expect(actions[0]).toMatchObject({ target: 'grove-overload-arm-1' });
  });

  it('skips a native group without failing the run', () => {
    const desired = config({
      forges: {
        'gh-overload': { kind: 'github' },
        'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' },
      },
      groups: [
        {
          name: 'ios',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'native',
        },
      ],
    } as Partial<GroveConfig>);
    const actions = reconcile(desired, observed(), []);
    expect(kinds(actions)).toEqual(['report-unsupported']);
    expect(actions[0]).toMatchObject({ group: 'ios' });
  });
});

describe('reconcile, a seat that moved between hosts', () => {
  const moved = config({
    groups: [
      {
        name: 'overload-arm',
        forge: 'gh-overload',
        scope: SCOPE,
        placement: { mac: 1, atlas: 1 },
        stack: 'docker',
      },
    ],
  } as Partial<GroveConfig>);

  it('removes the runner left on the old host and waits to create the new one', () => {
    const actions = reconcile(
      moved,
      observed({
        hosts: [
          host({
            containers: [
              container('grove-overload-arm-1'),
              container('grove-overload-arm-2'),
            ],
          }),
          host({ host: 'atlas' }),
        ],
        forges: [
          forge({
            runners: [
              {
                scope: SCOPE,
                runner: {
                  id: '12',
                  name: 'grove-overload-arm-2',
                  status: 'online',
                  busy: false,
                  labels: [],
                },
              },
            ],
          }),
        ],
      }),
      [record('grove-overload-arm-1'), record('grove-overload-arm-2')],
    );
    expect(kinds(actions)).toEqual([
      'stop-container',
      'deregister-runner',
      'remove-container',
      'retire-record',
    ]);
    expect(
      actions.map((action) => [
        'host' in action ? action.host : undefined,
        'name' in action ? action.name : undefined,
      ]),
    ).toEqual([
      ['mac', 'grove-overload-arm-2'],
      ['mac', 'grove-overload-arm-2'],
      ['mac', 'grove-overload-arm-2'],
      ['mac', 'grove-overload-arm-2'],
    ]);
  });

  it('creates on the new host once the old record is retired', () => {
    const actions = reconcile(
      moved,
      observed({
        hosts: [
          host({ containers: [container('grove-overload-arm-1')] }),
          host({ host: 'atlas' }),
        ],
      }),
      [
        record('grove-overload-arm-1'),
        record('grove-overload-arm-2', { retiredAt: 5 }),
      ],
    );
    expect(kinds(actions)).toEqual(['create-runner']);
    expect(actions[0]).toMatchObject({
      host: 'atlas',
      name: 'grove-overload-arm-2',
      index: 2,
    });
  });
});

describe('reconcile, a forge nothing observed', () => {
  it('leaves a record alone rather than reading silence as an empty forge', () => {
    const actions = reconcile(
      config({ groups: [] } as Partial<GroveConfig>),
      observed({
        hosts: [host({ containers: [container('grove-overload-arm-1')] })],
        forges: [],
      }),
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'report-degraded']);
    expect(actions[0]).toMatchObject({
      target: 'gh-overload',
      reason: expect.stringContaining('was not observed'),
    });
    expect(actions[1]).toMatchObject({
      target: 'grove-overload-arm-1',
      reason: expect.stringContaining('was not observed'),
    });
  });

  it('creates nothing for a group whose forge nothing observed', () => {
    const actions = reconcile(config(), observed({ forges: [] }), []);
    expect(kinds(actions)).toEqual(['report-degraded', 'report-degraded']);
    expect(actions[1]).toMatchObject({ target: 'overload-arm' });
  });

  it('creates nothing for a group whose forge did not answer', () => {
    const actions = reconcile(
      config(),
      observed({
        forges: [
          forge({ reachable: false, reason: 'API rate limit exceeded' }),
        ],
      }),
      [],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'report-degraded']);
    expect(actions[1]).toMatchObject({
      target: 'overload-arm',
      reason: expect.stringContaining('did not answer'),
    });
  });
});

describe('reconcile, a name that collides across forges', () => {
  it('never deregisters at a forge the record does not name', () => {
    const desired = config({
      forges: { 'gh-a': { kind: 'github' }, 'gh-b': { kind: 'github' } },
      groups: [],
    } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [host({ containers: [container('grove-overload-arm-1')] })],
        forges: [
          forge({ forge: 'gh-a' }),
          forge({
            forge: 'gh-b',
            runners: [
              {
                scope: SCOPE,
                runner: {
                  id: '77',
                  name: 'grove-overload-arm-1',
                  status: 'online',
                  busy: false,
                  labels: [],
                },
              },
            ],
          }),
        ],
      }),
      [record('grove-overload-arm-1', { forge: 'gh-a' })],
    );
    expect(kinds(actions)).toEqual([
      'stop-container',
      'remove-container',
      'retire-record',
      'report-unmanaged',
    ]);
    expect(
      actions.some((action) => 'forge' in action && action.forge === 'gh-b'),
    ).toBe(false);
    // The colliding runner at gh-b is its own entry, so grove names it rather
    // than folding it into the record it does not belong to.
    expect(actions[3]).toMatchObject({
      name: 'grove-overload-arm-1',
      where: 'runner at gh-b',
    });
  });
});

describe('reconcile, the order of a removal batch', () => {
  it('drains the highest index first', () => {
    const desired = config({
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'docker',
        },
      ],
    } as Partial<GroveConfig>);
    const actions = reconcile(
      desired,
      observed({
        hosts: [
          host({
            containers: [
              container('grove-overload-arm-1'),
              container('grove-overload-arm-2'),
              container('grove-overload-arm-3'),
            ],
          }),
        ],
      }),
      [
        record('grove-overload-arm-1'),
        record('grove-overload-arm-2'),
        record('grove-overload-arm-3'),
      ],
    );
    expect(
      actions.map((action) => ('name' in action ? action.name : '')),
    ).toEqual([
      'grove-overload-arm-3',
      'grove-overload-arm-3',
      'grove-overload-arm-3',
      'grove-overload-arm-2',
      'grove-overload-arm-2',
      'grove-overload-arm-2',
    ]);
    expect(kinds(actions.slice(0, 3))).toEqual([
      'stop-container',
      'remove-container',
      'retire-record',
    ]);
  });
});

describe('reconcile, a start that needs no forge call', () => {
  const oneSeat = config({
    groups: [
      {
        name: 'overload-arm',
        forge: 'gh-overload',
        scope: SCOPE,
        placement: { mac: 1 },
        stack: 'docker',
      },
    ],
  } as Partial<GroveConfig>);

  it('starts an exited container while the forge is unreachable', () => {
    const actions = reconcile(
      oneSeat,
      observed({
        hosts: [
          host({ containers: [container('grove-overload-arm-1', 'exited')] }),
        ],
        forges: [
          forge({ reachable: false, reason: 'API rate limit exceeded' }),
        ],
      }),
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'start-container']);
    expect(actions[0]).toMatchObject({ target: 'gh-overload' });
    expect(actions[1]).toMatchObject({
      host: 'mac',
      name: 'grove-overload-arm-1',
      recordId: 1,
    });
  });

  it('starts an exited container while the forge went unobserved', () => {
    const actions = reconcile(
      oneSeat,
      observed({
        hosts: [
          host({ containers: [container('grove-overload-arm-1', 'exited')] }),
        ],
        forges: [],
      }),
      [record('grove-overload-arm-1')],
    );
    expect(kinds(actions)).toEqual(['report-degraded', 'start-container']);
    expect(actions[0]).toMatchObject({
      target: 'gh-overload',
      reason: expect.stringContaining('was not observed'),
    });
    expect(actions[1]).toMatchObject({ name: 'grove-overload-arm-1' });
  });
});

describe('reconcile, a GitLab group', () => {
  const GITLAB_SCOPE = { level: 'instance' } as const;

  function gitlabConfig(count = 3): GroveConfig {
    return config({
      forges: {
        'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' },
      },
      groups: [
        {
          name: 'chevro-dind',
          forge: 'gl-chevro',
          scope: GITLAB_SCOPE,
          placement: { atlas: count },
          stack: 'docker',
          tags: ['docker'],
        },
      ],
    } as Partial<GroveConfig>);
  }

  // The group is gone from the config, which is what makes its seats
  // surplus and its entity unwanted.
  function emptyGitlabConfig(): GroveConfig {
    return config({
      forges: {
        'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' },
      },
      groups: [],
    } as Partial<GroveConfig>);
  }

  function gitlabRecord(
    index: number,
    systemId: string | null = null,
    host = 'atlas',
  ) {
    return record(`grove-chevro-dind-${index}`, {
      id: index,
      group: 'chevro-dind',
      index,
      host,
      forge: 'gl-chevro',
      forgeRunnerId: '48',
      systemId,
    });
  }

  function registration(
    overrides: Partial<GroupRegistrationRecord> = {},
  ): GroupRegistrationRecord {
    return {
      id: 7,
      group: 'chevro-dind',
      forge: 'gl-chevro',
      forgeRunnerId: '48',
      url: 'https://git.chevro.fr',
      token: ['glrt', 'K1l2M3n4O5p6Q7r8S9t0'].join('-'),
      createdAt: 1,
      retiredAt: null,
      ...overrides,
    };
  }

  function entityForge(
    managers: Array<{ systemId: string; status: string; busy: boolean }> = [],
    overrides: Partial<ForgeObservation> = {},
  ): ForgeObservation {
    return forge({
      forge: 'gl-chevro',
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
      ...overrides,
    });
  }

  function atlas(containers: DockerContainer[] = []): HostObservation {
    return host({ host: 'atlas', containers });
  }

  it('creates a seat for every count, and never reports the group as skipped', () => {
    const actions = reconcile(
      gitlabConfig(),
      {
        hosts: [atlas()],
        forges: [forge({ forge: 'gl-chevro', shared: true })],
      },
      [],
    );
    expect(kinds(actions)).toEqual([
      'create-runner',
      'create-runner',
      'create-runner',
    ]);
    expect(
      actions.every((action) => action.kind !== 'report-unsupported'),
    ).toBe(true);
  });

  it('leaves the entity alone when one of three managers scales down', () => {
    const actions = reconcile(
      gitlabConfig(2),
      {
        hosts: [
          atlas([
            container('grove-chevro-dind-1'),
            container('grove-chevro-dind-2'),
            container('grove-chevro-dind-3'),
          ]),
        ],
        forges: [
          entityForge([
            { systemId: 's_1', status: 'online', busy: false },
            { systemId: 's_2', status: 'online', busy: false },
            { systemId: 's_3', status: 'online', busy: false },
          ]),
        ],
      },
      [gitlabRecord(1, 's_1'), gitlabRecord(2, 's_2'), gitlabRecord(3, 's_3')],
    );

    expect(kinds(actions)).toEqual([
      'stop-container',
      'remove-container',
      'retire-record',
    ]);
    expect(actions.some((action) => action.kind === 'deregister-runner')).toBe(
      false,
    );
    expect(
      actions.some((action) => action.kind === 'delete-shared-runner'),
    ).toBe(false);
  });

  it('deletes the entity when the last manager goes', () => {
    const actions = reconcile(
      emptyGitlabConfig(),
      {
        hosts: [atlas([container('grove-chevro-dind-1')])],
        forges: [
          entityForge([{ systemId: 's_1', status: 'online', busy: false }]),
        ],
      },
      [gitlabRecord(1, 's_1')],
    );

    const deletion = actions.find(
      (action) => action.kind === 'delete-shared-runner',
    );
    expect(deletion).toMatchObject({
      forge: 'gl-chevro',
      group: 'chevro-dind',
      name: 'grove-chevro-dind',
      forgeRunnerId: '48',
      host: 'atlas',
      destructive: true,
    });
    expect(kinds(actions).at(-1)).toBe('delete-shared-runner');
  });

  it('deletes the entity in the bucket of the highest-index seat', () => {
    const actions = reconcile(
      emptyGitlabConfig(),
      {
        hosts: [
          host({ containers: [container('grove-chevro-dind-1')] }),
          atlas([container('grove-chevro-dind-2')]),
        ],
        forges: [entityForge()],
      },
      [gitlabRecord(1, null, 'mac'), gitlabRecord(2)],
    );

    expect(kinds(actions)).toEqual([
      'stop-container',
      'remove-container',
      'retire-record',
      'stop-container',
      'remove-container',
      'retire-record',
      'delete-shared-runner',
    ]);
    // Seat 2 sits on atlas and holds the highest index, so the delete queues
    // behind that host's own removals.
    expect(actions.at(-1)).toMatchObject({
      kind: 'delete-shared-runner',
      host: 'atlas',
    });
  });

  it('retires the stored registration row along with the entity', () => {
    const actions = reconcile(
      emptyGitlabConfig(),
      {
        hosts: [atlas([container('grove-chevro-dind-1')])],
        forges: [entityForge()],
      },
      [gitlabRecord(1)],
      { registrations: [registration()] },
    );
    expect(
      actions.find((action) => action.kind === 'delete-shared-runner'),
    ).toMatchObject({ registrationId: 7 });
  });

  it('keeps the entity when the host holding a seat did not answer', () => {
    const actions = reconcile(
      emptyGitlabConfig(),
      {
        hosts: [{ ...atlas(), reachable: false, reason: 'ssh timed out' }],
        forges: [entityForge()],
      },
      [gitlabRecord(1)],
    );
    expect(
      actions.some((action) => action.kind === 'delete-shared-runner'),
    ).toBe(false);
    expect(kinds(actions)).toContain('report-degraded');
  });

  it('renews a registration whose entity the forge no longer lists', () => {
    const actions = reconcile(
      gitlabConfig(1),
      {
        hosts: [atlas()],
        forges: [forge({ forge: 'gl-chevro', shared: true, runners: [] })],
      },
      [],
      { registrations: [registration()] },
    );
    expect(actions[0]).toMatchObject({
      kind: 'create-runner',
      // The id the planner judged gone, so apply retires that row and no
      // other.
      renewRegistration: '48',
      destructive: true,
    });
  });

  it('renews against the id of the row it read, not the one it will mint', () => {
    const actions = reconcile(
      gitlabConfig(1),
      {
        hosts: [atlas()],
        forges: [forge({ forge: 'gl-chevro', shared: true, runners: [] })],
      },
      [],
      { registrations: [registration({ forgeRunnerId: '77' })] },
    );
    expect(actions[0]).toMatchObject({ renewRegistration: '77' });
  });

  it('reuses a registration whose entity is still there', () => {
    const actions = reconcile(
      gitlabConfig(1),
      { hosts: [atlas()], forges: [entityForge()] },
      [],
      { registrations: [registration()] },
    );
    expect(kinds(actions)).toEqual(['create-runner']);
    expect(actions[0]).not.toHaveProperty('renewRegistration');
  });

  it('never reports an entity it owns as unmanaged', () => {
    const actions = reconcile(
      gitlabConfig(1),
      { hosts: [atlas()], forges: [entityForge()] },
      [],
      { registrations: [registration()] },
    );
    // No record points at the entity yet, and the registration row is what
    // says grove minted it, so the seat below reuses it rather than minting
    // a second one.
    expect(kinds(actions)).toEqual(['create-runner']);
    expect(actions[0]).toMatchObject({
      kind: 'create-runner',
      name: 'grove-chevro-dind-1',
    });
    expect(actions[0]).not.toHaveProperty('renewRegistration');
    expect(actions.some((action) => action.kind === 'report-unmanaged')).toBe(
      false,
    );
  });

  it('reports an entity grove named that no record claims', () => {
    const actions = reconcile(
      emptyGitlabConfig(),
      { hosts: [atlas()], forges: [entityForge()] },
      [],
    );
    expect(
      actions.find((action) => action.kind === 'report-unmanaged'),
    ).toMatchObject({
      name: 'grove-chevro-dind',
      where: 'runner entity 48 at gl-chevro',
    });
  });

  it('deletes an unclaimed entity a live registration proves grove minted', () => {
    const actions = reconcile(
      emptyGitlabConfig(),
      { hosts: [atlas()], forges: [entityForge()] },
      [],
      { registrations: [registration()] },
    );
    expect(kinds(actions)).toEqual(['delete-shared-runner']);
    expect(actions[0]).toMatchObject({
      forge: 'gl-chevro',
      group: 'chevro-dind',
      name: 'grove-chevro-dind',
      forgeRunnerId: '48',
      registrationId: 7,
    });
  });

  it('reports an unclaimed entity whose registration names another id', () => {
    const actions = reconcile(
      emptyGitlabConfig(),
      { hosts: [atlas()], forges: [entityForge()] },
      [],
      { registrations: [registration({ forgeRunnerId: '99' })] },
    );
    expect(
      actions.some((action) => action.kind === 'delete-shared-runner'),
    ).toBe(false);
    expect(kinds(actions)).toContain('report-unmanaged');
  });

  it('reports an unclaimed entity whose registration is already retired', () => {
    const actions = reconcile(
      emptyGitlabConfig(),
      { hosts: [atlas()], forges: [entityForge()] },
      [],
      { registrations: [registration({ retiredAt: 5 })] },
    );
    expect(
      actions.some((action) => action.kind === 'delete-shared-runner'),
    ).toBe(false);
    expect(kinds(actions)).toContain('report-unmanaged');
  });
});
