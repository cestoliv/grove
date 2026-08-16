import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from './migrations.js';
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
