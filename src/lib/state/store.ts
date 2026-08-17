import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StackKind } from '../config/index.js';
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
  // Learned from the host once the container has started once. Null until
  // then, and null for every stack that has no manager concept.
  systemId: string | null;
  // Where the seat keeps its files, written when it is created. A native seat
  // has both, a container has only the work dir, and a record written before
  // milestone 4 has neither. A teardown reads them when the group they came
  // from has left the config.
  installDir: string | null;
  workDir: string | null;
  // The supervisor this seat was created on. The config can name another one
  // tomorrow, and the seat that is running today is still on this one.
  stack: StackKind;
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
  // Absent means Docker, which is what every caller before milestone 4 meant.
  stack?: StackKind;
}

export interface GroupRegistrationRecord {
  id: number;
  group: string;
  forge: string;
  forgeRunnerId: string;
  url: string;
  token: string;
  createdAt: number;
  retiredAt: number | null;
}

export interface RunnerDirsInput {
  installDir: string | null;
  workDir: string | null;
}

export interface CreateGroupRegistrationInput {
  group: string;
  forge: string;
  forgeRunnerId: string;
  url: string;
  token: string;
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
    systemId: text(row.system_id),
    installDir: text(row.install_dir),
    workDir: text(row.work_dir),
    stack: String(row.stack) === 'native' ? 'native' : 'docker',
    name: String(row.name),
    createdAt: Number(row.created_at),
    retiredAt: row.retired_at === null ? null : Number(row.retired_at),
  };
}

function toRegistration(row: Row): GroupRegistrationRecord {
  return {
    id: Number(row.id),
    group: String(row.group_name),
    forge: String(row.forge),
    forgeRunnerId: String(row.forge_runner_id),
    url: String(row.url),
    token: String(row.token),
    createdAt: Number(row.created_at),
    retiredAt: row.retired_at === null ? null : Number(row.retired_at),
  };
}

// The database holds a GitLab runner authentication token, so it is no more
// readable than an SSH private key. The directory mode is the durable part,
// because SQLite recreates the -wal and -shm files as it pleases.
function restrict(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // A directory somebody else owns keeps its own mode, and grove still runs.
  }
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
      restrict(path);
    }
    const db = new DatabaseSync(path);
    if (path !== ':memory:') {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Same reason as the directory above.
      }
    }
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
           (group_name, runner_index, host, forge, forge_runner_id, stack, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.group,
        input.index,
        input.host,
        input.forge,
        input.forgeRunnerId ?? null,
        input.stack ?? 'docker',
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

  // Both columns move together, because a record that knows one directory and
  // not the other tells a later teardown half a story.
  setRunnerDirs(id: number, dirs: RunnerDirsInput): void {
    this.db
      .prepare('UPDATE runners SET install_dir = ?, work_dir = ? WHERE id = ?')
      .run(dirs.installDir, dirs.workDir, id);
  }

  setSystemId(id: number, systemId: string): void {
    this.db
      .prepare('UPDATE runners SET system_id = ? WHERE id = ?')
      .run(systemId, id);
  }

  retireRunner(id: number): void {
    this.db
      .prepare(
        'UPDATE runners SET retired_at = ? WHERE id = ? AND retired_at IS NULL',
      )
      .run(this.now(), id);
  }

  createGroupRegistration(
    input: CreateGroupRegistrationInput,
  ): GroupRegistrationRecord {
    const result = this.db
      .prepare(
        `INSERT INTO group_registrations
           (group_name, forge, forge_runner_id, url, token, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.group,
        input.forge,
        input.forgeRunnerId,
        input.url,
        input.token,
        this.now(),
      );
    const row = this.db
      .prepare('SELECT * FROM group_registrations WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as Row | undefined;
    if (row === undefined) {
      throw new Error(
        `grove.db lost the registration it just wrote for ${input.group}`,
      );
    }
    return toRegistration(row);
  }

  findActiveGroupRegistration(
    group: string,
    forge: string,
  ): GroupRegistrationRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM group_registrations
         WHERE group_name = ? AND forge = ? AND retired_at IS NULL`,
      )
      .get(group, forge) as Row | undefined;
    return row === undefined ? undefined : toRegistration(row);
  }

  activeGroupRegistrations(): GroupRegistrationRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM group_registrations WHERE retired_at IS NULL ORDER BY id',
      )
      .all() as Row[];
    return rows.map(toRegistration);
  }

  retireGroupRegistration(id: number): void {
    this.db
      .prepare(
        `UPDATE group_registrations SET retired_at = ?
         WHERE id = ? AND retired_at IS NULL`,
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
