import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openFleet } from '../../commands/context.js';
import { FakeForgeClient } from '../forge/index.js';
import type { Action } from '../reconcile/index.js';
import { StateStore } from '../state/index.js';
import { FakeTransport } from '../transport/index.js';
import { DaemonLog } from './log.js';
import {
  fleetSignature,
  refreshFleet,
  runTick,
  selectTickWork,
} from './tick.js';

const CONFIG = `
tick: { fast: 2m, full: 30m }

hosts:
  mac: { type: local, work_root: /srv/grove }

forges:
  gh-overload: { kind: github }

groups:
  - name: overload-arm
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 1 }
`;

// A group with a forge signal, which is what a restart needs.
const STUCK_CONFIG = CONFIG.replace(
  '    placement: { host: mac, count: 1 }',
  '    placement: { host: mac, count: 1 }\n    max_job_duration: 5m',
);

const ADDED_HOST = CONFIG.replace(
  '  mac: { type: local, work_root: /srv/grove }',
  '  mac: { type: local, work_root: /srv/grove }\n  atlas: { type: ssh, host: atlas }',
);

let dir: string;
let store: StateStore;
let client: FakeForgeClient;
let log: DaemonLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-tick-'));
  store = StateStore.open(':memory:');
  client = new FakeForgeClient('gh-overload');
  log = DaemonLog.open(join(dir, 'grove.log'));
});

afterEach(async () => {
  log.close();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function logLines(): Promise<string[]> {
  const text = await readFile(join(dir, 'grove.log'), 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

function psLine(name: string, state: string): string {
  return `${JSON.stringify({
    ID: 'abc',
    Names: name,
    State: state,
    Image: 'runner',
    Status: 'Up 1 hour',
    CreatedAt: 'now',
  })}\n`;
}

function mac(ps = ''): FakeTransport {
  return new FakeTransport('mac')
    .on('uname', { stdout: 'Darwin arm64\n' })
    .on('sh -c printf', { stdout: '/Users/olivier' })
    .on('docker ps', { stdout: ps })
    .on('docker run', { stdout: 'c0ffee\n' })
    .on('launchctl list', { stdout: '' });
}

async function open(
  transport: FakeTransport,
  useStore: StateStore = store,
  text: string = CONFIG,
) {
  const path = join(dir, 'grove.yaml');
  await writeFile(path, text, 'utf8');
  return openFleet({
    config: path,
    env: { GROVE_STATE_DIR: join(dir, 'state') },
    store: useStore,
    connect: () => transport,
    resolveToken: async () => 'token',
    createForgeClient: () => client,
  });
}

describe('runTick, fast', () => {
  it('calls no forge and starts a stopped seat', async () => {
    store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    const transport = mac(psLine('grove-overload-arm-1', 'exited'));
    const fleet = await open(transport);

    const summary = await runTick({
      fleet,
      kind: 'fast',
      log,
      now: () => 1000,
    });
    await fleet.close();

    expect(client.scopesListed).toEqual([]);
    expect(summary.applied).toBe(1);
    expect(transport.commandLines()).toContain(
      'docker start grove-overload-arm-1',
    );
  });

  it('creates nothing, because a registration token is a forge call', async () => {
    const transport = mac();
    const fleet = await open(transport);

    const summary = await runTick({
      fleet,
      kind: 'fast',
      log,
      now: () => 1000,
    });
    await fleet.close();

    expect(summary.applied).toBe(0);
    expect(client.registrations).toEqual([]);
    expect(store.activeRunners()).toEqual([]);
  });

  it('samples liveness from the host, not from a forge it never asked', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    const fleet = await open(mac(psLine('grove-overload-arm-1', 'running')));
    await runTick({ fleet, kind: 'fast', log, now: () => 1000 });
    await fleet.close();

    expect(store.livenessFor(record.id)[0].state).toBe('online');
  });

  it('writes the fast tick time down', async () => {
    const fleet = await open(mac());
    await runTick({ fleet, kind: 'fast', log, now: () => 1000 });
    await fleet.close();
    expect(store.getMeta('last_fast_tick')).toBe('1000');
    expect(store.getMeta('last_full_tick')).toBeUndefined();
  });
});

describe('runTick, full', () => {
  it('creates the missing runner and records it', async () => {
    const transport = mac();
    const fleet = await open(transport);

    const summary = await runTick({
      fleet,
      kind: 'full',
      log,
      now: () => 1000,
    });
    await fleet.close();

    expect(summary.applied).toBe(1);
    expect(client.registrations).toHaveLength(1);
    expect(store.activeRunners().map((record) => record.name)).toEqual([
      'grove-overload-arm-1',
    ]);
  });

  it('scales a group down without asking anybody', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 2,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-2',
    });
    client.addRunner({ id: '2', name: 'grove-overload-arm-2' });
    const transport = mac(
      `${psLine('grove-overload-arm-1', 'running')}${psLine('grove-overload-arm-2', 'running')}`,
    );
    const fleet = await open(transport);

    await runTick({ fleet, kind: 'full', log, now: () => 1000 });
    await fleet.close();

    expect(store.getRunner(record.id)?.retiredAt).not.toBeNull();
    expect(client.deleted.map((entry) => entry.id)).toEqual(['2']);
  });

  it('writes both tick times, because a full tick replaces the fast one', async () => {
    const fleet = await open(mac());
    await runTick({ fleet, kind: 'full', log, now: () => 2000 });
    await fleet.close();
    expect(store.getMeta('last_fast_tick')).toBe('2000');
    expect(store.getMeta('last_full_tick')).toBe('2000');
  });

  it('prunes history older than the retention', async () => {
    // Its own store, stamped at the epoch, so the ninety day cutoff below is
    // a real cutoff rather than a date in the 1970s nothing falls behind.
    const aged = StateStore.open(':memory:', { now: () => 0 });
    const record = aged.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    aged.recordEvent(record.id, 'started');
    const fleet = await open(
      mac(psLine('grove-overload-arm-1', 'running')),
      aged,
    );

    const ninetyOneDays = 91 * 24 * 60 * 60 * 1000;
    const summary = await runTick({
      fleet,
      kind: 'full',
      log,
      now: () => ninetyOneDays,
    });
    await fleet.close();

    expect(summary.prunedHistory).toBeGreaterThan(0);
    expect(aged.eventsFor(record.id)).toEqual([]);
    aged.close();
  });

  it('keeps going when a host does not answer', async () => {
    // No healthy `uname` entry at all, so the probe fails the way an
    // unreachable host fails rather than answering and then failing.
    const transport = new FakeTransport('mac').fail(
      'uname',
      'ssh: connect timed out',
    );
    const fleet = await open(transport);

    const summary = await runTick({
      fleet,
      kind: 'full',
      log,
      now: () => 1000,
    });
    await fleet.close();

    expect(summary.unreachableHosts).toEqual(['mac']);
    expect(summary.failed).toBe(0);
  });
});

describe('runTick liveness', () => {
  it('records nothing for a seat on a host that did not answer', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    const fleet = await open(
      new FakeTransport('mac').fail('uname', 'ssh: connect timed out'),
    );

    await runTick({ fleet, kind: 'full', log, now: () => 1000 });
    await fleet.close();

    // Silence is not `missing`, so the tick has nothing to write down.
    expect(store.livenessFor(record.id)).toEqual([]);
  });

  it('reads the host alone on a full tick whose forge did not answer', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    client.failOn('listRunners', 'github says 502');
    const fleet = await open(mac(psLine('grove-overload-arm-1', 'running')));

    const summary = await runTick({
      fleet,
      kind: 'full',
      log,
      now: () => 1000,
    });
    await fleet.close();

    expect(summary.unreachableForges).toEqual(['gh-overload']);
    // livenessFor would read the container as offline over a forge outage.
    expect(store.livenessFor(record.id)[0].state).toBe('online');
  });
});

describe('runTick, restarts', () => {
  it('does not count a restart the executor failed', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    // Busy since the epoch, so the forge signal is well past max_job_duration.
    store.setWatch(record.id, {
      busySince: 0,
      unregisteredSince: null,
      suspectSince: null,
      suspectReason: null,
    });
    client.addRunner({ id: '1', name: 'grove-overload-arm-1', busy: true });
    const transport = mac(psLine('grove-overload-arm-1', 'running'))
      // The activity probe, which is the host half of the stuck signal.
      .on('sh -c set --', { stdout: 'grove-overload-arm-1\tquiet\n' })
      .fail('docker stop', 'no such container');
    const fleet = await open(transport, store, STUCK_CONFIG);

    const summary = await runTick({
      fleet,
      kind: 'full',
      log,
      now: () => 3_600_000,
    });
    await fleet.close();

    expect(summary.failed).toBe(1);
    expect(
      (await logLines()).filter((line) => line.includes('restart ')),
    ).toHaveLength(1);
    // Planned, attempted, and not done. A summary that said otherwise would
    // tell the operator grove fixed a seat it did not fix.
    expect(summary.restarted).toEqual([]);
  });

  it('warns once when a host answers the activity probe for nobody', async () => {
    const record = store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    store.setWatch(record.id, {
      busySince: 0,
      unregisteredSince: null,
      suspectSince: null,
      suspectReason: null,
    });
    client.addRunner({ id: '1', name: 'grove-overload-arm-1', busy: true });
    // The probe ran and said nothing about any seat, which leaves every one of
    // them unknown. Safe, but silently safe, so the tick says so.
    const transport = mac(psLine('grove-overload-arm-1', 'running')).on(
      'sh -c set --',
      { stdout: '' },
    );
    const fleet = await open(transport, store, STUCK_CONFIG);

    await runTick({ fleet, kind: 'full', log, now: () => 3_600_000 });
    await fleet.close();

    expect(
      (await logLines()).filter((line) =>
        line.includes('activity unmeasurable on mac'),
      ),
    ).toHaveLength(1);
  });
});

describe('runTick reachability logging', () => {
  it('says a host is down once, and says when it comes back', async () => {
    const down = new FakeTransport('mac').fail(
      'uname',
      'ssh: connect timed out',
    );
    const first = await open(down);
    await runTick({ fleet: first, kind: 'full', log, now: () => 1000 });
    await runTick({ fleet: first, kind: 'full', log, now: () => 2000 });
    await first.close();

    expect(
      (await logLines()).filter((line) => line.includes('host did not answer')),
    ).toHaveLength(1);

    // The same store, so the meta set carries across the reopen the way it
    // carries across a daemon restart.
    const back = await open(mac());
    await runTick({ fleet: back, kind: 'full', log, now: () => 3000 });
    await back.close();

    expect(
      (await logLines()).filter((line) => line.includes('host answered again')),
    ).toHaveLength(1);
  });

  it('does not call a forge recovered on a fast tick that never asked', async () => {
    client.failOn('listRunners', 'github says 502');
    const fleet = await open(mac());
    await runTick({ fleet, kind: 'full', log, now: () => 1000 });
    await runTick({ fleet, kind: 'fast', log, now: () => 2000 });
    await fleet.close();

    const lines = await logLines();
    expect(
      lines.filter((line) => line.includes('forge did not answer')),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.includes('forge answered again')),
    ).toHaveLength(0);
  });
});

describe('fleetSignature', () => {
  it('ignores a group edit and notices a host edit', async () => {
    const path = join(dir, 'grove.yaml');
    await writeFile(path, CONFIG, 'utf8');
    const fleet = await open(mac());
    const first = fleetSignature(fleet.loaded.config);
    const grouped = {
      ...fleet.loaded.config,
      groups: [{ ...fleet.loaded.config.groups[0], labels: ['arm64'] }],
    };
    const hosted = {
      ...fleet.loaded.config,
      hosts: { mac: { type: 'local' as const, work_root: '/elsewhere' } },
    };
    await fleet.close();

    expect(fleetSignature(grouped)).toBe(first);
    expect(fleetSignature(hosted)).not.toBe(first);
  });

  it('notices a fast tick edit, because the SSH window follows it', async () => {
    const fleet = await open(mac());
    const config = fleet.loaded.config;
    await fleet.close();

    expect(
      fleetSignature({ ...config, tick: { ...config.tick, fast: 60_000 } }),
    ).not.toBe(fleetSignature(config));
    // The full interval reopens nothing, because no connection is held open
    // across it.
    expect(
      fleetSignature({
        ...config,
        tick: { ...config.tick, full: 60 * 60_000 },
      }),
    ).toBe(fleetSignature(config));
  });
});

describe('refreshFleet', () => {
  it('reads the edited config without reopening a connection', async () => {
    const path = join(dir, 'grove.yaml');
    const fleet = await open(mac());
    await writeFile(path, CONFIG.replace('count: 1', 'count: 3'), 'utf8');

    const result = await refreshFleet(fleet, {
      config: path,
      env: { GROVE_STATE_DIR: join(dir, 'state') },
    });
    expect(result.reopened).toBe(false);
    expect(result.fleet).toBe(fleet);
    expect(
      Object.values(result.fleet.loaded.config.groups[0].placement),
    ).toEqual([3]);
    await fleet.close();
  });

  it('keeps the last good config when the file stops parsing', async () => {
    const path = join(dir, 'grove.yaml');
    const fleet = await open(mac());
    await writeFile(path, 'hosts: [not a mapping]\n', 'utf8');

    const result = await refreshFleet(fleet, {
      config: path,
      env: { GROVE_STATE_DIR: join(dir, 'state') },
    });
    expect(result.error).toBeDefined();
    expect(result.fleet).toBe(fleet);
    expect(result.fleet.loaded.config.groups).toHaveLength(1);
    await fleet.close();
  });

  it('reopens when a host is added', async () => {
    const path = join(dir, 'grove.yaml');
    const fleet = await open(mac());
    await writeFile(path, ADDED_HOST, 'utf8');

    const result = await refreshFleet(fleet, {
      config: path,
      env: { GROVE_STATE_DIR: join(dir, 'state') },
      store,
      connect: () => mac(),
      resolveToken: async () => 'token',
      createForgeClient: () => client,
    });
    expect(result.reopened).toBe(true);
    expect(result.fleet).not.toBe(fleet);
    expect([...result.fleet.transports.keys()].sort()).toEqual([
      'atlas',
      'mac',
    ]);
    await result.fleet.close();
  });

  it('keeps the old fleet when the reopen throws', async () => {
    const path = join(dir, 'grove.yaml');
    const fleet = await open(mac());
    await writeFile(path, ADDED_HOST, 'utf8');

    const result = await refreshFleet(fleet, {
      config: path,
      env: { GROVE_STATE_DIR: join(dir, 'state') },
      openFleet: async () => {
        throw new Error('the credential command exited 1');
      },
    });

    expect(result.error).toBe('the credential command exited 1');
    expect(result.reopened).toBe(false);
    // Working connections rather than none, and the config grove converged on
    // last tick rather than one it cannot open.
    expect(result.fleet).toBe(fleet);
    expect(Object.keys(result.fleet.loaded.config.hosts)).toEqual(['mac']);
    await fleet.close();
  });

  it('opens the new fleet before it closes the old one', async () => {
    const path = join(dir, 'grove.yaml');
    const fleet = await open(mac());
    await writeFile(path, ADDED_HOST, 'utf8');

    const order: string[] = [];
    const close = fleet.close.bind(fleet);
    fleet.close = async () => {
      order.push('closed the old');
      await close();
    };

    const result = await refreshFleet(fleet, {
      config: path,
      env: { GROVE_STATE_DIR: join(dir, 'state') },
      store,
      connect: () => mac(),
      resolveToken: async () => 'token',
      createForgeClient: () => client,
      openFleet: async (options) => {
        // A failure to open must leave the daemon with the connections it
        // has, so the old context is still open at this point.
        expect(order).toEqual([]);
        const next = await openFleet(options);
        order.push('opened the new');
        return next;
      },
    });

    expect(order).toEqual(['opened the new', 'closed the old']);
    await result.fleet.close();
  });
});

describe('selectTickWork', () => {
  const create: Action = {
    kind: 'create-runner',
    host: 'mac',
    forge: 'gh-overload',
    group: 'overload-arm',
    index: 1,
    name: 'grove-overload-arm-1',
    // An ordinary create is not destructive. Only a renewal is, so a filter
    // on `destructive` would let this one through.
    destructive: false,
  };
  const start: Action = {
    kind: 'start-container',
    host: 'mac',
    name: 'grove-overload-arm-1',
    destructive: false,
  };
  const report: Action = {
    kind: 'report-suspect',
    host: 'mac',
    name: 'grove-overload-arm-1',
    reason: 'stuck',
    destructive: false,
  };

  it('lets a fast tick execute nothing but start-container', () => {
    // Minting a registration token is a forge call, and a fast tick makes
    // none. The planner refuses the create too, but this is the local
    // invariant, so a later planner change fails closed.
    expect(selectTickWork('fast', [create, start, report], [])).toEqual([
      start,
    ]);
  });

  it('lets a full tick execute every action that is not a report', () => {
    const supervision: Action[] = [
      {
        kind: 'restart-runner',
        host: 'mac',
        name: 'grove-overload-arm-1',
        recordId: 1,
        reason: 'stuck',
        destructive: true,
      },
    ];
    expect(
      selectTickWork('full', [create, start, report], supervision),
    ).toEqual([create, start, ...supervision]);
  });
});
