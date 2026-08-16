import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.js';
import { StateStore } from './store.js';

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
      name: 'grove-overload-arm-1',
      createdAt: 1_001,
      retiredAt: null,
    });
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

  it('migrates a milestone 2 database to version 2 without losing a runner', async () => {
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
      expect(SCHEMA_VERSION).toBe(2);
      const [record] = migrated.activeRunners();
      expect(record.name).toBe('grove-overload-arm-1');
      expect(record.systemId).toBeNull();
      expect(migrated.activeGroupRegistrations()).toEqual([]);
    } finally {
      migrated.close();
    }
  });
});
