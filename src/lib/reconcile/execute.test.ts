import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import {
  FakeForgeClient,
  type RegistrationRequest,
  type RunnerRegistration,
} from '../forge/index.js';
import { DockerStack } from '../stack/index.js';
import { StateStore } from '../state/index.js';
import {
  type ExecOptions,
  type ExecResult,
  FakeTransport,
  type Transport,
} from '../transport/index.js';
import type { Action } from './actions.js';
import { executeActions, persistSystemIds } from './execute.js';
import type { HostObservation } from './observed.js';

const SCOPE = { level: 'organization', target: 'Overload-coach' } as const;

let store: StateStore;

beforeEach(() => {
  store = StateStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

function config(): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { mac: { type: 'local', work_root: '/Volumes/ci/grove' } },
    forges: { 'gh-overload': { kind: 'github' } },
    groups: [
      {
        name: 'overload-arm',
        forge: 'gh-overload',
        scope: SCOPE,
        placement: { mac: 2 },
        stack: 'docker',
        labels: ['arm64'],
      },
    ],
  } as GroveConfig;
}

function observation(): HostObservation {
  return {
    host: 'mac',
    reachable: true,
    platform: 'Darwin',
    home: '/Users/olivier',
    containers: [],
    workRoots: {},
  };
}

function context(transport: FakeTransport, client: FakeForgeClient) {
  return {
    config: config(),
    hosts: new Map([['mac', observation()]]),
    stacks: new Map([['mac', new DockerStack({ transport, host: 'mac' })]]),
    forgeClients: new Map([['gh-overload', client]]),
    store,
    log: () => undefined,
  };
}

const createAction: Action = {
  kind: 'create-runner',
  host: 'mac',
  forge: 'gh-overload',
  group: 'overload-arm',
  index: 1,
  name: 'grove-overload-arm-1',
  destructive: false,
};

// A forge that hands back a runner id at registration time, the way GitLab
// does, so a test can watch the id reach the record.
class RunnerIdForgeClient extends FakeForgeClient {
  override async createRegistration(
    request: RegistrationRequest,
  ): Promise<RunnerRegistration> {
    const registration = await super.createRegistration(request);
    return { ...registration, runnerId: '77' };
  }
}

// Counts exec calls in flight, in total and per host, so a test can prove
// two hosts overlap and that one host never overlaps with itself. Counters,
// not wall clock comparisons, so nothing here can go flaky.
class ConcurrencyProbe {
  peak = 0;
  private inFlight = 0;
  private readonly running = new Map<string, number>();
  private readonly peaks = new Map<string, number>();
  private readonly order = new Map<string, string[]>();

  enter(host: string): void {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    const here = (this.running.get(host) ?? 0) + 1;
    this.running.set(host, here);
    this.peaks.set(host, Math.max(this.peaks.get(host) ?? 0, here));
    this.order.set(host, [...this.orderFor(host), 'enter']);
  }

  leave(host: string): void {
    this.inFlight -= 1;
    this.running.set(host, (this.running.get(host) ?? 1) - 1);
    this.order.set(host, [...this.orderFor(host), 'leave']);
  }

  peakFor(host: string): number {
    return this.peaks.get(host) ?? 0;
  }

  orderFor(host: string): string[] {
    return this.order.get(host) ?? [];
  }
}

// Long enough that a call cannot finish inside the microtask drain that
// starts the other host, so a serial executor shows up as a peak of 1.
const EXEC_DELAY_MS = 30;

// Holds every exec open across a timer and reports it to the probe, then
// delegates to the fake underneath so the assertions on recorded commands
// still work.
class DelayingTransport implements Transport {
  readonly name: string;
  private readonly inner: FakeTransport;
  private readonly probe: ConcurrencyProbe;

  constructor(inner: FakeTransport, probe: ConcurrencyProbe) {
    this.inner = inner;
    this.probe = probe;
    this.name = inner.name;
  }

  async exec(
    command: string,
    args: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.probe.enter(this.name);
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, EXEC_DELAY_MS);
      });
      return await this.inner.exec(command, args, options);
    } finally {
      this.probe.leave(this.name);
    }
  }

  readFile(path: string): Promise<string> {
    return this.inner.readFile(path);
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.inner.writeFile(path, content);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

describe('executeActions, creating a runner', () => {
  it('mints a registration, writes a record, prepares dirs and runs docker', async () => {
    const transport = new FakeTransport('mac').on('docker run', {
      stdout: 'c0ffee\n',
    });
    const client = new FakeForgeClient('gh-overload');
    const result = await executeActions(
      [createAction],
      context(transport, client),
    );

    expect(result.failed).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(client.registrations[0]).toMatchObject({
      name: 'grove-overload-arm-1',
      labels: ['arm64'],
      scope: SCOPE,
    });

    const record = store.findActiveByName('grove-overload-arm-1');
    expect(record).toMatchObject({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      // A container unpacks nothing on the host, so only the work dir is
      // worth remembering.
      installDir: null,
      workDir: '/Volumes/ci/grove/overload-arm-1',
      stack: 'docker',
    });
    expect(store.eventsFor(record?.id ?? 0).map((event) => event.kind)).toEqual(
      ['created', 'started'],
    );

    const lines = transport.commandLines();
    expect(lines[0]).toContain('rm -rf');
    expect(lines[1]).toContain('docker run');
    expect(lines[1]).toContain('--name grove-overload-arm-1');
    expect(lines[1]).toContain(
      '--volume /Volumes/ci/grove/overload-arm-1:/Volumes/ci/grove/overload-arm-1',
    );
  });

  it('reuses an existing record when only the container went missing', async () => {
    const existing = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    const transport = new FakeTransport('mac').on('docker run', {
      stdout: 'id\n',
    });
    await executeActions(
      [{ ...createAction, recordId: existing.id }],
      context(transport, new FakeForgeClient('gh-overload')),
    );

    expect(store.activeRunners()).toHaveLength(1);
    expect(store.activeRunners()[0].id).toBe(existing.id);
  });

  it('stores the forge runner id on the record it reuses', async () => {
    const existing = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    expect(existing.forgeRunnerId).toBeNull();

    const transport = new FakeTransport('mac').on('docker run', {
      stdout: 'id\n',
    });
    const result = await executeActions(
      [{ ...createAction, recordId: existing.id }],
      context(transport, new RunnerIdForgeClient('gh-overload')),
    );

    expect(result.failed).toEqual([]);
    expect(store.getRunner(existing.id)?.forgeRunnerId).toBe('77');
  });

  it('builds the image first when the group names a Dockerfile', async () => {
    const transport = new FakeTransport('mac').on('docker run', {
      stdout: 'id\n',
    });
    const withBuild = context(transport, new FakeForgeClient('gh-overload'));
    withBuild.config.groups[0].build = '/srv/runners/Dockerfile';
    await executeActions([createAction], withBuild);

    expect(transport.commandLines()[0]).toContain(
      'docker build --tag grove-overload-arm:',
    );
  });
});

describe('executeActions, removing a runner', () => {
  it('drains, deregisters, removes and retires', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 2,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-2',
    });
    const transport = new FakeTransport('mac');
    const client = new FakeForgeClient('gh-overload').addRunner({
      name: 'grove-overload-arm-2',
      id: '12',
    });
    const actions: Action[] = [
      {
        kind: 'stop-container',
        host: 'mac',
        name: 'grove-overload-arm-2',
        recordId: record.id,
        drainTimeoutMs: 90_000,
        destructive: true,
      },
      {
        kind: 'deregister-runner',
        host: 'mac',
        forge: 'gh-overload',
        scope: SCOPE,
        name: 'grove-overload-arm-2',
        forgeRunnerId: '12',
        recordId: record.id,
        destructive: true,
      },
      {
        kind: 'remove-container',
        host: 'mac',
        name: 'grove-overload-arm-2',
        recordId: record.id,
        destructive: true,
      },
      {
        kind: 'retire-record',
        host: 'mac',
        name: 'grove-overload-arm-2',
        recordId: record.id,
        destructive: true,
      },
    ];

    const result = await executeActions(actions, context(transport, client));

    expect(result.failed).toEqual([]);
    expect(transport.commandLines()).toEqual([
      'docker stop -t 90 grove-overload-arm-2',
      'docker rm -f grove-overload-arm-2',
    ]);
    expect(client.deleted.map((entry) => entry.id)).toEqual(['12']);
    expect(store.findActiveByName('grove-overload-arm-2')).toBeUndefined();
    expect(store.eventsFor(record.id).map((event) => event.kind)).toEqual([
      'stopped',
      'deregistered',
      'removed',
    ]);
  });

  it('skips the drain when force is set', async () => {
    const transport = new FakeTransport('mac');
    await executeActions(
      [
        {
          kind: 'stop-container',
          host: 'mac',
          name: 'grove-overload-arm-2',
          drainTimeoutMs: 90_000,
          destructive: true,
        },
      ],
      {
        ...context(transport, new FakeForgeClient('gh-overload')),
        force: true,
      },
    );
    expect(transport.commandLines()[0]).toBe(
      'docker stop -t 0 grove-overload-arm-2',
    );
  });
});

describe('executeActions, failures and reports', () => {
  it('poisons only the runner that failed', async () => {
    const transport = new FakeTransport('mac')
      .fail('docker stop -t 90 grove-overload-arm-2', 'boom\n')
      .on('docker run', { stdout: 'id\n' });
    const actions: Action[] = [
      {
        kind: 'stop-container',
        host: 'mac',
        name: 'grove-overload-arm-2',
        drainTimeoutMs: 90_000,
        destructive: true,
      },
      {
        kind: 'remove-container',
        host: 'mac',
        name: 'grove-overload-arm-2',
        destructive: true,
      },
      createAction,
    ];

    const result = await executeActions(
      actions,
      context(transport, new FakeForgeClient('gh-overload')),
    );

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/boom/);
    expect(result.skipped.map((action) => action.kind)).toEqual([
      'remove-container',
    ]);
    expect(result.applied.map((action) => action.kind)).toEqual([
      'create-runner',
    ]);
  });

  it('fails the action when the record it should reuse is gone', async () => {
    const transport = new FakeTransport('mac').on('docker run', {
      stdout: 'id\n',
    });
    const result = await executeActions(
      [{ ...createAction, recordId: 404 }],
      context(transport, new FakeForgeClient('gh-overload')),
    );

    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toBe('record 404 no longer exists');
    // Nothing was started that grove would then have no record of.
    expect(
      transport.commandLines().some((line) => line.startsWith('docker run')),
    ).toBe(false);
  });

  it('does nothing for a report and returns it in neither list', async () => {
    const transport = new FakeTransport('mac');
    const result = await executeActions(
      [
        {
          kind: 'report-unmanaged',
          name: 'grove-x-1',
          where: 'container on mac',
          host: 'mac',
          destructive: false,
        },
      ],
      context(transport, new FakeForgeClient('gh-overload')),
    );
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  it('runs two hosts at the same time and one host in order', async () => {
    const probe = new ConcurrencyProbe();
    const mac = new FakeTransport('mac').on('docker run', { stdout: 'id\n' });
    const atlas = new FakeTransport('atlas').on('docker run', {
      stdout: 'id\n',
    });
    const slowMac = new DelayingTransport(mac, probe);
    const slowAtlas = new DelayingTransport(atlas, probe);
    const base = context(mac, new FakeForgeClient('gh-overload'));
    const options = {
      ...base,
      hosts: new Map([
        ['mac', observation()],
        ['atlas', { ...observation(), host: 'atlas' }],
      ]),
      stacks: new Map([
        ['mac', new DockerStack({ transport: slowMac, host: 'mac' })],
        ['atlas', new DockerStack({ transport: slowAtlas, host: 'atlas' })],
      ]),
    };
    options.config.hosts.atlas = { type: 'ssh', host: 'atlas' };
    options.config.groups[0].placement = { mac: 2, atlas: 1 };

    const result = await executeActions(
      [
        createAction,
        { ...createAction, index: 3, name: 'grove-overload-arm-3' },
        {
          ...createAction,
          host: 'atlas',
          index: 2,
          name: 'grove-overload-arm-2',
        },
      ],
      options,
    );

    expect(result.failed).toEqual([]);
    expect(
      mac.commandLines().some((line) => line.includes('grove-overload-arm-1')),
    ).toBe(true);
    expect(
      atlas
        .commandLines()
        .some((line) => line.includes('grove-overload-arm-2')),
    ).toBe(true);

    // Two hosts were mid-call at the same moment, so the hosts really do run
    // side by side.
    expect(probe.peak).toBe(2);
    // Neither host ever had two calls of its own in flight, so one daemon
    // never sees a second command before the first came back.
    expect(probe.peakFor('mac')).toBe(1);
    expect(probe.peakFor('atlas')).toBe(1);
    // The second runner on mac only started after the first one finished.
    expect(probe.orderFor('mac')).toEqual([
      'enter',
      'leave',
      'enter',
      'leave',
      'enter',
      'leave',
      'enter',
      'leave',
    ]);
  });
});

describe('executeActions, a shared registration', () => {
  const GITLAB_SCOPE = { level: 'instance' } as const;

  function gitlabConfig(): GroveConfig {
    return {
      tick: { fast: 120_000, full: 1_800_000 },
      hosts: {
        atlas: { type: 'ssh', host: 'atlas', work_root: '/PROD/local/grove' },
      },
      forges: { 'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' } },
      groups: [
        {
          name: 'chevro-dind',
          forge: 'gl-chevro',
          scope: GITLAB_SCOPE,
          placement: { atlas: 2 },
          stack: 'docker',
          tags: ['docker', 'dind'],
          concurrent: 4,
        },
      ],
    } as GroveConfig;
  }

  function gitlabContext(transport: FakeTransport, client: FakeForgeClient) {
    return {
      config: gitlabConfig(),
      hosts: new Map([
        [
          'atlas',
          {
            host: 'atlas',
            reachable: true,
            platform: 'Linux',
            home: '/root',
            containers: [],
            workRoots: {},
          } as HostObservation,
        ],
      ]),
      stacks: new Map([
        ['atlas', new DockerStack({ transport, host: 'atlas' })],
      ]),
      forgeClients: new Map([['gl-chevro', client]]),
      store,
      log: () => undefined,
    };
  }

  function sharedClient(): FakeForgeClient {
    return new FakeForgeClient('gl-chevro', {
      kind: 'gitlab',
      sharedRegistration: true,
    });
  }

  function createSeat(index: number): Action {
    return {
      kind: 'create-runner',
      host: 'atlas',
      forge: 'gl-chevro',
      group: 'chevro-dind',
      index,
      name: `grove-chevro-dind-${index}`,
      destructive: false,
    };
  }

  it('mints one entity for the whole group and reuses it for every seat', async () => {
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    const client = sharedClient();
    const result = await executeActions(
      [createSeat(1), createSeat(2)],
      gitlabContext(transport, client),
    );

    expect(result.failed).toEqual([]);
    expect(client.registrations).toHaveLength(1);
    expect(client.registrations[0].name).toBe('grove-chevro-dind');
    expect(client.registrations[0].tags).toEqual(['docker', 'dind']);
    expect(store.activeGroupRegistrations()).toHaveLength(1);
    expect(store.activeRunners().map((record) => record.forgeRunnerId)).toEqual(
      ['101', '101'],
    );
  });

  it('stores the token once and never logs it', async () => {
    const lines: string[] = [];
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    const client = sharedClient();
    await executeActions([createSeat(1)], {
      ...gitlabContext(transport, client),
      log: (line: string) => lines.push(line),
    });

    const [registration] = store.activeGroupRegistrations();
    expect(registration.token).toBe('fake-registration-token-1');
    expect(lines.join('\n')).not.toContain(registration.token);
  });

  it('prepares a config directory and runs a gitlab-runner container', async () => {
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    await executeActions(
      [createSeat(1)],
      gitlabContext(transport, sharedClient()),
    );

    const lines = transport.commandLines();
    expect(
      lines.some((line) =>
        line.includes("chmod 0700 '/PROD/local/grove/chevro-dind-1-config'"),
      ),
    ).toBe(true);
    const run = lines.find((line) => line.startsWith('docker run'));
    expect(run).toContain(
      '--volume /PROD/local/grove/chevro-dind-1-config:/etc/gitlab-runner',
    );
    expect(run).toContain('gitlab-runner register');
    expect(run).toContain("printf '%s\\n' 'concurrent = 4'");
  });

  it('calls nothing at the forge for a second seat added later', async () => {
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    const client = sharedClient();
    await executeActions([createSeat(1)], gitlabContext(transport, client));
    await executeActions([createSeat(2)], gitlabContext(transport, client));
    expect(client.registrations).toHaveLength(1);
  });

  it('mints again when the planner says the entity is gone', async () => {
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    const client = sharedClient();
    await executeActions([createSeat(1)], gitlabContext(transport, client));
    const [before] = store.activeGroupRegistrations();
    await executeActions(
      [
        {
          ...createSeat(2),
          renewRegistration: before.forgeRunnerId,
          destructive: true,
        } as Action,
      ],
      gitlabContext(transport, client),
    );

    expect(client.registrations).toHaveLength(2);
    expect(store.activeGroupRegistrations()).toHaveLength(1);
    expect(store.activeGroupRegistrations()[0].forgeRunnerId).toBe('102');
  });

  it('keeps a row another process minted between plan and apply', async () => {
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    const client = sharedClient();
    await executeActions([createSeat(1)], gitlabContext(transport, client));
    const [before] = store.activeGroupRegistrations();

    // The planner judged id 48 gone. The row now holds a different id, so
    // this apply is about to destroy a token it never read.
    await executeActions(
      [
        {
          ...createSeat(2),
          renewRegistration: '48',
          destructive: true,
        } as Action,
      ],
      gitlabContext(transport, client),
    );

    expect(client.registrations).toHaveLength(1);
    const active = store.activeGroupRegistrations();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(before.id);
    expect(active[0].forgeRunnerId).toBe(before.forgeRunnerId);
  });

  it('deletes the entity and retires the row that held its token', async () => {
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    const client = sharedClient();
    await executeActions([createSeat(1)], gitlabContext(transport, client));
    const [registration] = store.activeGroupRegistrations();

    const result = await executeActions(
      [
        {
          kind: 'delete-shared-runner',
          host: 'atlas',
          forge: 'gl-chevro',
          scope: GITLAB_SCOPE,
          group: 'chevro-dind',
          name: 'grove-chevro-dind',
          forgeRunnerId: registration.forgeRunnerId,
          registrationId: registration.id,
          destructive: true,
        } as Action,
      ],
      gitlabContext(transport, client),
    );

    expect(result.failed).toEqual([]);
    expect(client.deleted).toEqual([
      { scope: GITLAB_SCOPE, id: registration.forgeRunnerId },
    ]);
    expect(store.activeGroupRegistrations()).toEqual([]);
  });

  it('takes the entity back down when the row cannot be stored', async () => {
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    const client = sharedClient();
    // Every call reaches the real store except the one insert, so the failure
    // lands exactly where the entity already exists and the row does not.
    const failingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'createGroupRegistration') {
          return () => {
            throw new Error('the state database is read only');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as StateStore;

    const result = await executeActions([createSeat(1), createSeat(2)], {
      ...gitlabContext(transport, client),
      store: failingStore,
    });

    // The forge saw one create and one delete, so grove left nothing behind.
    expect(client.registrations).toHaveLength(1);
    expect(client.deleted).toEqual([{ scope: GITLAB_SCOPE, id: '101' }]);
    expect(store.activeGroupRegistrations()).toEqual([]);
    // No seat may start against a token no row holds.
    expect(result.applied).toEqual([]);
    expect(result.failed.map((failure) => failure.error)).toEqual([
      'the state database is read only',
      'the state database is read only',
    ]);
  });

  it('mints once for a group whose seats sit on two hosts', async () => {
    const atlas = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    const mac = new FakeTransport('mac').on('docker run', {
      stdout: 'cafe\n',
    });
    const client = sharedClient();
    const base = gitlabContext(atlas, client);
    const spread = {
      ...base,
      config: {
        ...base.config,
        hosts: {
          ...base.config.hosts,
          mac: { type: 'local', work_root: '/Volumes/ci/grove' },
        },
        groups: [{ ...base.config.groups[0], placement: { atlas: 1, mac: 1 } }],
      } as GroveConfig,
      hosts: new Map([
        ...base.hosts,
        [
          'mac',
          {
            host: 'mac',
            reachable: true,
            platform: 'Darwin',
            home: '/Users/olivier',
            containers: [],
            workRoots: {},
          } as HostObservation,
        ],
      ]),
      stacks: new Map([
        ...base.stacks,
        ['mac', new DockerStack({ transport: mac, host: 'mac' })],
      ]),
    };

    const result = await executeActions(
      [createSeat(1), { ...createSeat(2), host: 'mac' } as Action],
      spread,
    );

    expect(result.failed).toEqual([]);
    // The two hosts ran in two parallel buckets and still share one entity.
    expect(client.registrations).toHaveLength(1);
    expect(store.activeGroupRegistrations()).toHaveLength(1);
    expect(
      store
        .activeRunners()
        .map((record) => [record.host, record.forgeRunnerId]),
    ).toEqual([
      ['atlas', '101'],
      ['mac', '101'],
    ]);
  });

  it('deletes an entity whose action carries no host', async () => {
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef\n',
    });
    const client = sharedClient();
    await executeActions([createSeat(1)], gitlabContext(transport, client));
    const [registration] = store.activeGroupRegistrations();

    const result = await executeActions(
      [
        {
          kind: 'delete-shared-runner',
          forge: 'gl-chevro',
          scope: GITLAB_SCOPE,
          group: 'chevro-dind',
          name: 'grove-chevro-dind',
          forgeRunnerId: registration.forgeRunnerId,
          registrationId: registration.id,
          destructive: true,
        } as Action,
      ],
      gitlabContext(transport, client),
    );

    expect(result.failed).toEqual([]);
    expect(client.deleted).toEqual([
      { scope: GITLAB_SCOPE, id: registration.forgeRunnerId },
    ]);
    expect(store.activeGroupRegistrations()).toEqual([]);
  });
});

describe('persistSystemIds', () => {
  it('writes what a host reported onto the record it belongs to', () => {
    const record = store.createRunner({
      group: 'chevro-dind',
      index: 1,
      host: 'atlas',
      forge: 'gl-chevro',
      name: 'grove-chevro-dind-1',
    });
    const learned = persistSystemIds(
      {
        hosts: [
          {
            host: 'atlas',
            reachable: true,
            containers: [],
            workRoots: {},
            systemIds: { 'grove-chevro-dind-1': 's_aaaaaaaaaaaa' },
          },
        ],
        forges: [],
      },
      store.activeRunners(),
      store,
    );

    expect(learned).toBe(1);
    expect(store.getRunner(record.id)?.systemId).toBe('s_aaaaaaaaaaaa');
  });

  it('writes nothing when the id has not changed', () => {
    const record = store.createRunner({
      group: 'chevro-dind',
      index: 1,
      host: 'atlas',
      forge: 'gl-chevro',
      name: 'grove-chevro-dind-1',
    });
    store.setSystemId(record.id, 's_aaaaaaaaaaaa');
    const observed = {
      hosts: [
        {
          host: 'atlas',
          reachable: true,
          containers: [],
          workRoots: {},
          systemIds: { 'grove-chevro-dind-1': 's_aaaaaaaaaaaa' },
        },
      ],
      forges: [],
    };
    expect(persistSystemIds(observed, store.activeRunners(), store)).toBe(0);
  });

  it('keys a record by host and name, not by name alone', () => {
    const atlas = store.createRunner({
      group: 'chevro-dind',
      index: 1,
      host: 'atlas',
      forge: 'gl-chevro',
      name: 'grove-chevro-dind-1',
    });
    const mac = store.createRunner({
      group: 'chevro-dind',
      index: 2,
      host: 'mac',
      forge: 'gl-chevro',
      name: 'grove-chevro-dind-2',
    });
    // `runners_active_name` stops two active rows sharing a name, so the
    // colliding pair is built here rather than stored. The function takes
    // whatever records it is handed, and must not drop one of them.
    const records = [atlas, { ...mac, name: atlas.name }];
    const learned = persistSystemIds(
      {
        hosts: [
          {
            host: 'atlas',
            reachable: true,
            containers: [],
            workRoots: {},
            systemIds: { 'grove-chevro-dind-1': 's_aaaaaaaaaaaa' },
          },
          {
            host: 'mac',
            reachable: true,
            containers: [],
            workRoots: {},
            systemIds: { 'grove-chevro-dind-1': 'r_bbbbbbbbbbbb' },
          },
        ],
        forges: [],
      },
      records,
      store,
    );

    expect(learned).toBe(2);
    expect(store.getRunner(atlas.id)?.systemId).toBe('s_aaaaaaaaaaaa');
    expect(store.getRunner(mac.id)?.systemId).toBe('r_bbbbbbbbbbbb');
  });

  it('refuses a name that belongs to a record on another host', () => {
    store.createRunner({
      group: 'chevro-dind',
      index: 1,
      host: 'atlas',
      forge: 'gl-chevro',
      name: 'grove-chevro-dind-1',
    });
    const learned = persistSystemIds(
      {
        hosts: [
          {
            host: 'mac',
            reachable: true,
            containers: [],
            workRoots: {},
            systemIds: { 'grove-chevro-dind-1': 's_aaaaaaaaaaaa' },
          },
        ],
        forges: [],
      },
      store.activeRunners(),
      store,
    );
    expect(learned).toBe(0);
  });
});

describe('executeActions, a native seat', () => {
  function nativeConfig(overrides: Record<string, unknown> = {}): GroveConfig {
    return {
      tick: { fast: 120_000, full: 1_800_000 },
      hosts: { mac: { type: 'local', work_root: '/Volumes/ci/grove' } },
      forges: { 'gh-overload': { kind: 'github' } },
      groups: [
        {
          name: 'ios',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'native',
          labels: ['macos'],
          ...overrides,
        },
      ],
    } as unknown as GroveConfig;
  }

  function nativeObservation(): HostObservation {
    return {
      host: 'mac',
      reachable: true,
      platform: 'Darwin',
      arch: 'arm64',
      home: '/Users/olivier',
      uid: '501',
      containers: [],
      natives: [],
      workRoots: {},
    };
  }

  function nativeContext(
    transport: FakeTransport,
    client: FakeForgeClient,
    extra: Record<string, unknown> = {},
  ) {
    return {
      config: nativeConfig(),
      hosts: new Map([['mac', nativeObservation()]]),
      stacks: new Map([['mac', new DockerStack({ transport, host: 'mac' })]]),
      transports: new Map<string, Transport>([['mac', transport]]),
      forgeClients: new Map([['gh-overload', client]]),
      store,
      resolveRunnerVersion: async () => '2.328.0',
      nativePollIntervalMs: 1,
      log: () => undefined,
      ...extra,
    };
  }

  const nativeCreate: Action = {
    kind: 'create-runner',
    host: 'mac',
    forge: 'gh-overload',
    group: 'ios',
    index: 1,
    name: 'grove-ios-1',
    stack: 'native',
    destructive: false,
  };

  it('installs the runner, records it, then loads the launchd agent', async () => {
    const transport = new FakeTransport('mac');
    const client = new FakeForgeClient('gh-overload');
    const result = await executeActions(
      [nativeCreate],
      nativeContext(transport, client),
    );

    expect(result.failed).toEqual([]);
    const lines = transport.commandLines();
    expect(lines[0]).toContain('sh -c rm -rf');
    expect(lines[1]).toContain(
      'curl -fsSL -o /Volumes/ci/grove/ios-1-runner/actions-runner.tar.gz',
    );
    expect(lines[2]).toContain('tar xzf');
    expect(lines[4]).toContain('/Volumes/ci/grove/ios-1-runner/config.sh');
    expect(lines).toContain(
      'launchctl bootstrap gui/501 /Users/olivier/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
    );
    expect(client.registrations).toHaveLength(1);
    const record = store.findActiveByName('grove-ios-1');
    expect(record?.host).toBe('mac');
    // Both directories, because a teardown after the group left the config has
    // nowhere else to read them from.
    expect(record?.installDir).toBe('/Volumes/ci/grove/ios-1-runner');
    expect(record?.workDir).toBe('/Volumes/ci/grove/ios-1');
    // The record names the supervisor that holds this seat, so a config that
    // switches stack later still knows where the running seat is.
    expect(record?.stack).toBe('native');
  });

  it('writes the record before config.sh runs at the forge', async () => {
    const transport = new FakeTransport('mac').fail(
      '/Volumes/ci/grove/ios-1-runner/config.sh',
      'Http response code: NotFound\n',
      1,
    );
    const result = await executeActions(
      [nativeCreate],
      nativeContext(transport, new FakeForgeClient('gh-overload')),
    );

    expect(result.failed).toHaveLength(1);
    // The row survives the failure on purpose. A runner config.sh half
    // registered is a runner grove has to be able to find again.
    expect(store.findActiveByName('grove-ios-1')).toBeDefined();
    expect(store.findActiveByName('grove-ios-1')?.installDir).toBe(
      '/Volumes/ci/grove/ios-1-runner',
    );
  });

  it('uses the pinned version and asks GitHub nothing', async () => {
    const transport = new FakeTransport('mac');
    const result = await executeActions([nativeCreate], {
      ...nativeContext(transport, new FakeForgeClient('gh-overload')),
      config: nativeConfig({ raw: { runner_version: '2.327.1' } }),
      resolveRunnerVersion: async () => {
        throw new Error('grove asked GitHub for a version it was given');
      },
    });

    expect(result.failed).toEqual([]);
    expect(transport.commandLines()[1]).toContain(
      'actions-runner-osx-arm64-2.327.1.tar.gz',
    );
  });

  it('refuses to place a seat on a host whose home it never read', async () => {
    const transport = new FakeTransport('mac');
    const result = await executeActions([nativeCreate], {
      ...nativeContext(transport, new FakeForgeClient('gh-overload')),
      hosts: new Map([
        ['mac', { ...nativeObservation(), home: undefined } as HostObservation],
      ]),
    });

    expect(result.failed[0].error).toMatch(/\$HOME on host "mac"/);
    expect(transport.calls).toEqual([]);
  });

  it('wipes the work dir and not the install dir on a clean start', async () => {
    const transport = new FakeTransport('mac');
    await executeActions(
      [
        {
          kind: 'start-container',
          host: 'mac',
          name: 'grove-ios-1',
          stack: 'native',
          destructive: false,
        },
      ],
      {
        ...nativeContext(transport, new FakeForgeClient('gh-overload')),
        clean: true,
      },
    );

    expect(transport.calls[0].args[1]).toContain(
      "rm -rf '/Volumes/ci/grove/ios-1'",
    );
    expect(transport.calls[0].args[1]).not.toContain(
      "rm -rf '/Volumes/ci/grove/ios-1-runner'",
    );
    expect(transport.commandLines()).toContain(
      'launchctl kickstart -k gui/501/com.cestoliv.grove.ios-1',
    );
  });

  it('drains through the supervisor, under --force too, and kills nothing', async () => {
    const drain: Action = {
      kind: 'stop-container',
      host: 'mac',
      name: 'grove-ios-1',
      stack: 'native',
      drainTimeoutMs: 20,
      destructive: true,
    };
    // launchd has let the job go, which is the answer the poll waits for.
    const listing = { stdout: 'PID\tStatus\tLabel\n' };
    const expected = [
      'launchctl bootout gui/501/com.cestoliv.grove.ios-1',
      'launchctl list',
    ];

    const patient = new FakeTransport('mac').on('launchctl list', listing);
    const drained = await executeActions(
      [drain],
      nativeContext(patient, new FakeForgeClient('gh-overload')),
    );
    expect(drained.failed).toEqual([]);
    expect(patient.commandLines()).toEqual(expected);

    // grove never kills a pid launchctl named. That pid is the entry point,
    // not the listener, so launchd's own escalation is what must do it.
    const forced = new FakeTransport('mac').on('launchctl list', listing);
    const forcedResult = await executeActions([drain], {
      ...nativeContext(forced, new FakeForgeClient('gh-overload')),
      force: true,
    });
    expect(forcedResult.failed).toEqual([]);
    expect(forced.commandLines()).toEqual(expected);
  });

  it('removes the agent and the install dir', async () => {
    const transport = new FakeTransport('mac');
    await executeActions(
      [
        {
          kind: 'remove-container',
          host: 'mac',
          name: 'grove-ios-1',
          stack: 'native',
          destructive: true,
        },
      ],
      nativeContext(transport, new FakeForgeClient('gh-overload')),
    );

    expect(transport.commandLines()).toEqual([
      'launchctl bootout gui/501/com.cestoliv.grove.ios-1',
      'rm -f /Users/olivier/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
      'rm -rf /Volumes/ci/grove/ios-1-runner',
    ]);
  });

  it('removes a seat whose group left the config, from the dirs it recorded', async () => {
    const existing = store.createRunner({
      group: 'ios',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-ios-1',
    });
    store.setRunnerDirs(existing.id, {
      installDir: '/Volumes/ci/grove/ios-1-runner',
      workDir: '/Volumes/ci/grove/ios-1',
    });
    const transport = new FakeTransport('mac');
    const result = await executeActions(
      [
        {
          kind: 'remove-container',
          host: 'mac',
          name: 'grove-ios-1',
          stack: 'native',
          recordId: existing.id,
          destructive: true,
        },
      ],
      {
        ...nativeContext(transport, new FakeForgeClient('gh-overload')),
        config: { ...nativeConfig(), groups: [] } as GroveConfig,
      },
    );

    expect(result.failed).toEqual([]);
    expect(transport.commandLines()).toEqual([
      'launchctl bootout gui/501/com.cestoliv.grove.ios-1',
      'rm -f /Users/olivier/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
      'rm -rf /Volumes/ci/grove/ios-1-runner',
    ]);
  });

  it('reads the dirs off a record the teardown has already retired', async () => {
    const existing = store.createRunner({
      group: 'ios',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-ios-1',
    });
    store.setRunnerDirs(existing.id, {
      installDir: '/Volumes/ci/grove/ios-1-runner',
      workDir: '/Volumes/ci/grove/ios-1',
    });
    store.retireRunner(existing.id);
    const transport = new FakeTransport('mac');
    const result = await executeActions(
      [
        {
          kind: 'remove-container',
          host: 'mac',
          name: 'grove-ios-1',
          stack: 'native',
          recordId: existing.id,
          destructive: true,
        },
      ],
      {
        ...nativeContext(transport, new FakeForgeClient('gh-overload')),
        config: { ...nativeConfig(), groups: [] } as GroveConfig,
      },
    );

    expect(result.failed).toEqual([]);
    expect(transport.commandLines()).toContain(
      'rm -rf /Volumes/ci/grove/ios-1-runner',
    );
  });

  it('says so when the group is gone and no record holds the directories', async () => {
    const transport = new FakeTransport('mac');
    const result = await executeActions(
      [
        {
          kind: 'remove-container',
          host: 'mac',
          name: 'grove-ios-1',
          stack: 'native',
          destructive: true,
        },
      ],
      {
        ...nativeContext(transport, new FakeForgeClient('gh-overload')),
        config: { ...nativeConfig(), groups: [] } as GroveConfig,
      },
    );

    expect(result.failed[0].error).toMatch(
      /no longer in the config.+no record holds the directories/,
    );
    expect(transport.calls).toEqual([]);
  });

  it('refuses a $HOME that is not an absolute path, naming the host', async () => {
    const transport = new FakeTransport('mac');
    const result = await executeActions([nativeCreate], {
      ...nativeContext(transport, new FakeForgeClient('gh-overload')),
      hosts: new Map([['mac', { ...nativeObservation(), home: 'Users/o' }]]),
    });
    expect(result.failed[0].error).toMatch(
      /\$HOME on host "mac" is "Users\/o", which is not an absolute path/,
    );
    expect(transport.calls).toEqual([]);
  });

  it('says so when the host has left the config', async () => {
    const transport = new FakeTransport('mac');
    const result = await executeActions(
      [
        {
          kind: 'remove-container',
          host: 'mac',
          name: 'grove-ios-1',
          stack: 'native',
          destructive: true,
        },
      ],
      {
        ...nativeContext(transport, new FakeForgeClient('gh-overload')),
        config: { ...nativeConfig(), hosts: {} } as GroveConfig,
      },
    );
    expect(result.failed[0].error).toMatch(
      /host "mac" is no longer in the config/,
    );
    expect(transport.calls).toEqual([]);
  });

  it('says so when no transport was opened for the host', async () => {
    const transport = new FakeTransport('mac');
    const result = await executeActions([nativeCreate], {
      ...nativeContext(transport, new FakeForgeClient('gh-overload')),
      transports: new Map<string, Transport>(),
    });
    expect(result.failed[0].error).toMatch(/no transport was opened/);
  });

  it('drives a native seat through the supervisor, keeping the install dir', async () => {
    const recordId = store.createRunner({
      group: 'ios',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-ios-1',
      stack: 'native',
    }).id;
    const transport = new FakeTransport('mac');

    const result = await executeActions(
      [
        {
          kind: 'restart-runner',
          host: 'mac',
          name: 'grove-ios-1',
          stack: 'native',
          recordId,
          reason: 'wedged',
          destructive: true,
        },
      ],
      nativeContext(transport, new FakeForgeClient('gh-overload')),
    );

    expect(result.failed).toEqual([]);
    const lines = transport.commandLines();
    expect(lines.some((line) => line.startsWith('launchctl bootout'))).toBe(
      true,
    );
    expect(lines.some((line) => line.startsWith('launchctl kickstart'))).toBe(
      true,
    );
    const prepare = lines.find((line) => line.includes('mkdir -p')) ?? '';
    // The work dir goes, the unpacked runner and its credentials stay. The
    // mkdir names the install dir, so only the rm is asserted on.
    expect(prepare).toContain("rm -rf '/Volumes/ci/grove/ios-1' &&");
    expect(prepare).not.toContain("rm -rf '/Volumes/ci/grove/ios-1-runner'");
    expect(store.eventsFor(recordId).map((event) => event.kind)).toEqual([
      'restarted',
    ]);
  });
});

describe('restart-runner', () => {
  function record(): number {
    return store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    }).id;
  }

  it('stops with no drain, wipes the work dir and starts again', async () => {
    const recordId = record();
    const transport = new FakeTransport('mac');
    const client = new FakeForgeClient('gh-overload');

    const result = await executeActions(
      [
        {
          kind: 'restart-runner',
          host: 'mac',
          name: 'grove-overload-arm-1',
          recordId,
          reason: 'busy for 118m with a quiet work dir',
          destructive: true,
        },
      ],
      context(transport, client),
    );

    expect(result.failed).toEqual([]);
    const lines = transport.commandLines();
    expect(lines).toContain('docker stop -t 0 grove-overload-arm-1');
    expect(
      lines.some((line) =>
        line.includes("rm -rf '/Volumes/ci/grove/overload-arm-1'"),
      ),
    ).toBe(true);
    expect(lines).toContain('docker start grove-overload-arm-1');
    // The order matters. A start before the wipe would run against the state
    // the restart is trying to throw away.
    expect(lines.indexOf('docker stop -t 0 grove-overload-arm-1')).toBeLessThan(
      lines.indexOf('docker start grove-overload-arm-1'),
    );

    expect(
      store.eventsFor(recordId).map((event) => [event.kind, event.reason]),
    ).toEqual([['restarted', 'busy for 118m with a quiet work dir']]);
  });

  it('never calls the forge, because the seat keeps the registration it holds', async () => {
    const recordId = record();
    const client = new FakeForgeClient('gh-overload');

    await executeActions(
      [
        {
          kind: 'restart-runner',
          host: 'mac',
          name: 'grove-overload-arm-1',
          recordId,
          reason: 'wedged',
          destructive: true,
        },
      ],
      context(new FakeTransport('mac'), client),
    );

    expect(client.registrations).toEqual([]);
    expect(client.deleted).toEqual([]);
  });

  it('fails without stopping anything when the host has left the config', async () => {
    const recordId = record();
    const transport = new FakeTransport('mac');

    const result = await executeActions(
      [
        {
          kind: 'restart-runner',
          host: 'mac',
          name: 'grove-overload-arm-1',
          recordId,
          reason: 'wedged',
          destructive: true,
        },
      ],
      {
        ...context(transport, new FakeForgeClient('gh-overload')),
        config: { ...config(), hosts: {} } as GroveConfig,
      },
    );

    expect(result.failed[0].error).toMatch(
      /host "mac" is no longer in the config/,
    );
    // The directories are derived before the stop, so a seat grove cannot
    // place is left running rather than taken down and stranded.
    expect(transport.calls).toEqual([]);
    expect(store.eventsFor(recordId)).toEqual([]);
  });
});
