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
import { executeActions } from './execute.js';
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
