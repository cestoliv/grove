import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';

export type RunnerEventKind =
  | 'created'
  | 'started'
  | 'stopped'
  | 'restarted'
  | 'deregistered'
  | 'removed';

export type LivenessState = 'online' | 'offline' | 'busy' | 'missing';

export interface RunnerRecord {
  id: number;
  group: string;
  index: number;
  host: string;
  forge: string;
  forgeRunnerId: string | null;
  name: string;
  createdAt: number;
  retiredAt: number | null;
}

export interface RunnerEvent {
  id: number;
  runnerId: number;
  kind: RunnerEventKind;
  ts: number;
  reason: string | null;
}

export interface LivenessSample {
  ts: number;
  state: LivenessState;
}

export interface CreateRunnerInput {
  group: string;
  index: number;
  host: string;
  forge: string;
  name: string;
  forgeRunnerId?: string | null;
}

export interface StateStoreOptions {
  now?: () => number;
}

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRecord(row: Row): RunnerRecord {
  return {
    id: Number(row.id),
    group: String(row.group_name),
    index: Number(row.runner_index),
    host: String(row.host),
    forge: String(row.forge),
    forgeRunnerId: text(row.forge_runner_id),
    name: String(row.name),
    createdAt: Number(row.created_at),
    retiredAt: row.retired_at === null ? null : Number(row.retired_at),
  };
}

export class StateStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  private constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  static open(path: string, options: StateStoreOptions = {}): StateStore {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return new StateStore(db, options.now ?? Date.now);
  }

  schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    return Number(row?.user_version ?? 0);
  }

  createRunner(input: CreateRunnerInput): RunnerRecord {
    const result = this.db
      .prepare(
        `INSERT INTO runners
           (group_name, runner_index, host, forge, forge_runner_id, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.group,
        input.index,
        input.host,
        input.forge,
        input.forgeRunnerId ?? null,
        input.name,
        this.now(),
      );
    const record = this.getRunner(Number(result.lastInsertRowid));
    if (record === undefined) {
      throw new Error(
        `grove.db lost the record it just wrote for ${input.name}`,
      );
    }
    return record;
  }

  getRunner(id: number): RunnerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runners WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  findActiveByName(name: string): RunnerRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM runners WHERE name = ? AND retired_at IS NULL')
      .get(name) as Row | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  activeRunners(): RunnerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runners WHERE retired_at IS NULL ORDER BY id')
      .all() as Row[];
    return rows.map(toRecord);
  }

  setForgeRunnerId(id: number, forgeRunnerId: string): void {
    this.db
      .prepare('UPDATE runners SET forge_runner_id = ? WHERE id = ?')
      .run(forgeRunnerId, id);
  }

  retireRunner(id: number): void {
    this.db
      .prepare(
        'UPDATE runners SET retired_at = ? WHERE id = ? AND retired_at IS NULL',
      )
      .run(this.now(), id);
  }

  recordEvent(runnerId: number, kind: RunnerEventKind, reason?: string): void {
    this.db
      .prepare(
        'INSERT INTO events (runner_id, kind, ts, reason) VALUES (?, ?, ?, ?)',
      )
      .run(runnerId, kind, this.now(), reason ?? null);
  }

  eventsFor(runnerId: number): RunnerEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE runner_id = ? ORDER BY id')
      .all(runnerId) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      runnerId: Number(row.runner_id),
      kind: String(row.kind) as RunnerEventKind,
      ts: Number(row.ts),
      reason: text(row.reason),
    }));
  }

  recordLiveness(runnerId: number, state: LivenessState): void {
    this.db
      .prepare('INSERT INTO liveness (runner_id, ts, state) VALUES (?, ?, ?)')
      .run(runnerId, this.now(), state);
  }

  livenessFor(runnerId: number, limit = 50): LivenessSample[] {
    const rows = this.db
      .prepare(
        'SELECT ts, state FROM liveness WHERE runner_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(runnerId, limit) as Row[];
    return rows.map((row) => ({
      ts: Number(row.ts),
      state: String(row.state) as LivenessState,
    }));
  }

  close(): void {
    this.db.close();
  }
}
