import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.js';
import { META_LAST_FULL_TICK, StateStore } from './store.js';

let store: StateStore;
let clock = 1_000;

function openMemory(): StateStore {
  return StateStore.open(':memory:', {
    now: () => {
      clock += 1;
      return clock;
    },
  });
}

beforeEach(() => {
  clock = 1_000;
  store = openMemory();
});

afterEach(() => {
  store.close();
});

function create(name = 'grove-overload-arm-1', index = 1): number {
  return store.createRunner({
    group: 'overload-arm',
    index,
    host: 'mac',
    forge: 'gh-overload',
    name,
  }).id;
}

describe('StateStore', () => {
  it('reports the schema version it migrated to', () => {
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  it('creates a runner record and reads it back', () => {
    const id = create();
    const record = store.getRunner(id);
    expect(record).toEqual({
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
      name: 'grove-overload-arm-1',
      createdAt: 1_001,
      retiredAt: null,
    });
  });

  it('remembers the stack a seat was created on', () => {
    const record = store.createRunner({
      group: 'ios',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-ios-1',
      stack: 'native',
    });
    expect(record.stack).toBe('native');
    expect(store.getRunner(record.id)?.stack).toBe('native');
    // Every caller from milestone 2 and 3 says nothing, and Docker is what
    // those callers meant.
    expect(store.getRunner(create())?.stack).toBe('docker');
  });

  it('finds an active record by name and stops finding it once retired', () => {
    const id = create();
    expect(store.findActiveByName('grove-overload-arm-1')?.id).toBe(id);
    store.retireRunner(id);
    expect(store.findActiveByName('grove-overload-arm-1')).toBeUndefined();
    expect(store.getRunner(id)?.retiredAt).toBe(1_002);
  });

  it('lists active runners in creation order', () => {
    const first = create('grove-overload-arm-1', 1);
    const second = create('grove-overload-arm-2', 2);
    store.retireRunner(first);
    expect(store.activeRunners().map((record) => record.id)).toEqual([second]);
  });

  it('lets the same name be reused once the old record is retired', () => {
    const first = create();
    store.retireRunner(first);
    const second = create();
    expect(second).not.toBe(first);
    expect(store.findActiveByName('grove-overload-arm-1')?.id).toBe(second);
  });

  it('refuses two active records with the same name', () => {
    create();
    expect(() => create()).toThrow(/UNIQUE/i);
  });

  it('stores the forge runner id when it becomes known', () => {
    const id = create();
    store.setForgeRunnerId(id, '4821');
    expect(store.getRunner(id)?.forgeRunnerId).toBe('4821');
  });

  it('records lifecycle events with a timestamp and an optional reason', () => {
    const id = create();
    store.recordEvent(id, 'created');
    store.recordEvent(id, 'stopped', 'scale down');
    expect(store.eventsFor(id)).toEqual([
      { id: 1, runnerId: id, kind: 'created', ts: 1_002, reason: null },
      { id: 2, runnerId: id, kind: 'stopped', ts: 1_003, reason: 'scale down' },
    ]);
  });

  it('records liveness samples newest first', () => {
    const id = create();
    store.recordLiveness(id, 'online');
    store.recordLiveness(id, 'busy');
    expect(store.livenessFor(id)).toEqual([
      { ts: 1_003, state: 'busy' },
      { ts: 1_002, state: 'online' },
    ]);
  });

  it('refuses an event for a runner that does not exist', () => {
    expect(() => store.recordEvent(999, 'created')).toThrow(/FOREIGN KEY/i);
  });
});

describe('StateStore.open', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'grove-state-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the state directory and survives a reopen', () => {
    const path = join(dir, 'nested', 'grove.db');
    const first = StateStore.open(path);
    const id = first.createRunner({
      group: 'ios',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-ios-1',
    }).id;
    first.close();

    const second = StateStore.open(path);
    expect(second.getRunner(id)?.name).toBe('grove-ios-1');
    expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
    second.close();
  });
});

describe('StateStore, system ids', () => {
  it('starts with no system id and learns one later', () => {
    const id = create();
    expect(store.getRunner(id)?.systemId).toBeNull();
    store.setSystemId(id, 's_aaaaaaaaaaaa');
    expect(store.getRunner(id)?.systemId).toBe('s_aaaaaaaaaaaa');
  });

  it('replaces a system id when a recreated container generates a new one', () => {
    const id = create();
    store.setSystemId(id, 's_aaaaaaaaaaaa');
    store.setSystemId(id, 'r_bbbbbbbbbbbb');
    expect(store.getRunner(id)?.systemId).toBe('r_bbbbbbbbbbbb');
  });
});

describe('StateStore, runner directories', () => {
  it('starts with no directories and keeps the two a create prepared', () => {
    const id = create();
    expect(store.getRunner(id)?.installDir).toBeNull();
    expect(store.getRunner(id)?.workDir).toBeNull();
    store.setRunnerDirs(id, {
      installDir: '/Volumes/ci/grove/overload-arm-1-runner',
      workDir: '/Volumes/ci/grove/overload-arm-1',
    });
    expect(store.getRunner(id)?.installDir).toBe(
      '/Volumes/ci/grove/overload-arm-1-runner',
    );
    expect(store.getRunner(id)?.workDir).toBe(
      '/Volumes/ci/grove/overload-arm-1',
    );
  });

  // A container unpacks nothing on the host, so the column stays empty for it.
  it('takes a null install dir from a stack that installs nothing', () => {
    const id = create();
    store.setRunnerDirs(id, {
      installDir: null,
      workDir: '/Volumes/ci/grove/overload-arm-1',
    });
    expect(store.getRunner(id)?.installDir).toBeNull();
    expect(store.getRunner(id)?.workDir).toBe(
      '/Volumes/ci/grove/overload-arm-1',
    );
  });
});

describe('StateStore, group registrations', () => {
  function register(group = 'chevro-dind', forge = 'gl-chevro') {
    return store.createGroupRegistration({
      group,
      forge,
      forgeRunnerId: '48',
      url: 'https://git.chevro.fr',
      token: ['glrt', 'K1l2M3n4O5p6Q7r8S9t0'].join('-'),
    });
  }

  it('stores the entity id and the token the group registers against', () => {
    const record = register();
    expect(record).toMatchObject({
      group: 'chevro-dind',
      forge: 'gl-chevro',
      forgeRunnerId: '48',
      url: 'https://git.chevro.fr',
      retiredAt: null,
    });
    expect(record.token).toContain('glrt-');
    expect(record.createdAt).toBeGreaterThan(0);
  });

  it('finds the active registration for one group at one forge', () => {
    register();
    expect(
      store.findActiveGroupRegistration('chevro-dind', 'gl-chevro')?.id,
    ).toBe(1);
    expect(
      store.findActiveGroupRegistration('chevro-dind', 'gl-other'),
    ).toBeUndefined();
    expect(
      store.findActiveGroupRegistration('other', 'gl-chevro'),
    ).toBeUndefined();
  });

  it('lists every active registration and drops the retired ones', () => {
    const first = register();
    register('other-group');
    store.retireGroupRegistration(first.id);
    expect(store.activeGroupRegistrations().map((row) => row.group)).toEqual([
      'other-group',
    ]);
    expect(
      store.findActiveGroupRegistration('chevro-dind', 'gl-chevro'),
    ).toBeUndefined();
  });

  it('lets a retired group register again, so a lost entity can be replaced', () => {
    const first = register();
    store.retireGroupRegistration(first.id);
    const second = register();
    expect(second.id).not.toBe(first.id);
    expect(
      store.findActiveGroupRegistration('chevro-dind', 'gl-chevro')?.id,
    ).toBe(second.id);
  });

  it('refuses two active registrations for the same group and forge', () => {
    register();
    expect(() => register()).toThrow();
  });
});

describe('StateStore, on disk', () => {
  let dir: string;

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the state directory and the database to their owner', async () => {
    dir = await mkdtemp(join(tmpdir(), 'grove-state-'));
    const path = join(dir, 'nested', 'grove.db');
    const disk = StateStore.open(path);
    try {
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      disk.close();
    }
  });

  it('tightens an existing database and directory that were left loose', async () => {
    dir = await mkdtemp(join(tmpdir(), 'grove-state-'));
    const nested = join(dir, 'state');
    mkdirSync(nested);
    const path = join(nested, 'grove.db');
    // A milestone 2 database, created before grove set the modes itself.
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]);
    old.exec('PRAGMA user_version = 1');
    old.close();
    chmodSync(nested, 0o755);
    chmodSync(path, 0o644);

    const disk = StateStore.open(path);
    try {
      expect(statSync(nested).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(disk.schemaVersion()).toBe(SCHEMA_VERSION);
    } finally {
      disk.close();
    }
  });

  it('migrates a milestone 2 database forward without losing a runner', async () => {
    dir = await mkdtemp(join(tmpdir(), 'grove-state-'));
    const path = join(dir, 'grove.db');
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]);
    old.exec('PRAGMA user_version = 1');
    old.exec(
      `INSERT INTO runners
         (group_name, runner_index, host, forge, name, created_at)
       VALUES ('overload-arm', 1, 'mac', 'gh-overload', 'grove-overload-arm-1', 1)`,
    );
    old.close();

    const migrated = StateStore.open(path);
    try {
      expect(migrated.schemaVersion()).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(4);
      const [record] = migrated.activeRunners();
      expect(record.name).toBe('grove-overload-arm-1');
      expect(record.systemId).toBeNull();
      expect(record.installDir).toBeNull();
      expect(record.workDir).toBeNull();
      expect(migrated.activeGroupRegistrations()).toEqual([]);
    } finally {
      migrated.close();
    }
  });
});

describe('the daemon state', () => {
  function seat(store: StateStore): number {
    return store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    }).id;
  }

  it('stores and reads a meta key', () => {
    const store = StateStore.open(':memory:');
    expect(store.getMeta(META_LAST_FULL_TICK)).toBeUndefined();
    store.setMeta(META_LAST_FULL_TICK, '1700000000000');
    store.setMeta(META_LAST_FULL_TICK, '1700000060000');
    expect(store.getMeta(META_LAST_FULL_TICK)).toBe('1700000060000');
    store.close();
  });

  it('hands back an empty watch for a seat it has never watched', () => {
    const store = StateStore.open(':memory:');
    const id = seat(store);
    expect(store.watchFor(id)).toEqual({
      runnerId: id,
      busySince: null,
      unregisteredSince: null,
      suspectSince: null,
      suspectReason: null,
    });
    store.close();
  });

  it('upserts a watch', () => {
    const store = StateStore.open(':memory:');
    const id = seat(store);
    store.setWatch(id, {
      busySince: 100,
      unregisteredSince: null,
      suspectSince: 200,
      suspectReason: 'the work dir is quiet',
    });
    store.setWatch(id, {
      busySince: 300,
      unregisteredSince: 400,
      suspectSince: null,
      suspectReason: null,
    });
    expect(store.watchFor(id)).toEqual({
      runnerId: id,
      busySince: 300,
      unregisteredSince: 400,
      suspectSince: null,
      suspectReason: null,
    });
    store.close();
  });

  it('opens a job, closes it, and computes the duration', () => {
    let at = 1000;
    const store = StateStore.open(':memory:', { now: () => at });
    const id = seat(store);
    const started = store.startJob(id);
    expect(started.endedAt).toBeNull();
    expect(store.openJob(id)?.id).toBe(started.id);

    at = 61_000;
    const ended = store.endJob(id, 'unknown');
    expect(ended?.durationMs).toBe(60_000);
    expect(ended?.outcome).toBe('unknown');
    expect(store.openJob(id)).toBeUndefined();
    expect(store.jobsFor(id)).toHaveLength(1);
    store.close();
  });

  it('closes only the newest open job and ignores a seat with none', () => {
    const store = StateStore.open(':memory:');
    const id = seat(store);
    expect(store.endJob(id, 'unknown')).toBeUndefined();
    store.startJob(id, 10);
    store.startJob(id, 20);
    const ended = store.endJob(id, 'unknown', 30);
    expect(ended?.startedAt).toBe(20);
    expect(store.openJob(id)?.startedAt).toBe(10);
    store.close();
  });

  it('counts restarts inside a window and finds the newest one', () => {
    let at = 1000;
    const store = StateStore.open(':memory:', { now: () => at });
    const id = seat(store);
    store.recordEvent(id, 'restarted', 'wedged');
    at = 5000;
    store.recordEvent(id, 'restarted', 'wedged');
    at = 6000;
    store.recordEvent(id, 'started');

    expect(store.countEventsSince(id, 'restarted', 0)).toBe(2);
    expect(store.countEventsSince(id, 'restarted', 2000)).toBe(1);
    expect(store.lastEventAt(id, 'restarted')).toBe(5000);
    expect(store.lastEventAt(id, 'deregistered')).toBeUndefined();
    store.close();
  });

  it('prunes events, liveness and jobs older than the cutoff', () => {
    let at = 1000;
    const store = StateStore.open(':memory:', { now: () => at });
    const id = seat(store);
    store.recordEvent(id, 'started');
    store.recordLiveness(id, 'online');
    store.startJob(id, 1000);
    store.endJob(id, 'unknown', 1500);

    at = 9000;
    store.recordEvent(id, 'stopped');
    store.recordLiveness(id, 'offline');

    expect(store.pruneHistory(5000)).toEqual({
      events: 1,
      liveness: 1,
      jobs: 1,
    });
    expect(store.eventsFor(id).map((event) => event.kind)).toEqual(['stopped']);
    expect(store.livenessFor(id)).toHaveLength(1);
    expect(store.jobsFor(id)).toEqual([]);
    // The record itself is not history, so pruning never touches it.
    expect(store.activeRunners()).toHaveLength(1);
    store.close();
  });

  it('keeps a job that is still open, however old it is', () => {
    const store = StateStore.open(':memory:');
    const id = seat(store);
    store.startJob(id, 1000);

    // An open job is not history yet. The `endJob` a later tick runs would
    // find nothing, and grove would lose a job it is still watching.
    expect(store.pruneHistory(5000).jobs).toBe(0);
    expect(store.openJob(id)?.startedAt).toBe(1000);
    store.close();
  });

  it('clears every suspect', () => {
    const store = StateStore.open(':memory:');
    const id = seat(store);
    store.setWatch(id, {
      busySince: 100,
      unregisteredSince: 200,
      suspectSince: 300,
      suspectReason: 'the work dir is quiet',
    });

    store.clearSuspects();

    // Only the suspicion goes. The busy clock is what the next tick compares
    // against, and it is not a verdict.
    expect(store.watchFor(id)).toEqual({
      runnerId: id,
      busySince: 100,
      unregisteredSince: 200,
      suspectSince: null,
      suspectReason: null,
    });
    store.close();
  });
});
