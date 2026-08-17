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

export const META_LAST_FAST_TICK = 'last_fast_tick';
export const META_LAST_FULL_TICK = 'last_full_tick';
export const META_DAEMON_STARTED_AT = 'daemon_started_at';
// The pid of the running control loop. It is what `grove status` and `grove
// daemon status` read to answer "is anything watching this fleet", because the
// reconciler lock is taken per tick and is absent between them. An empty value
// means the loop stopped cleanly; a pid whose process is gone means it did not.
export const META_DAEMON_PID = 'daemon_pid';

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

export interface RunnerWatch {
  runnerId: number;
  busySince: number | null;
  unregisteredSince: number | null;
  suspectSince: number | null;
  suspectReason: string | null;
}

/**
 * One job, derived from a busy transition between two full ticks. The
 * granularity is therefore one full tick, and the outcome is always unknown,
 * because neither forge tells grove how a job ended without a per-job API
 * call the spec does not budget for. A duration accurate to plus or minus one
 * tick is useful. One pretending to be exact is not.
 */
export interface JobRecord {
  id: number;
  runnerId: number;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  outcome: string | null;
}

export interface PrunedHistory {
  events: number;
  liveness: number;
  jobs: number;
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

function toJob(row: Row): JobRecord {
  return {
    id: Number(row.id),
    runnerId: Number(row.runner_id),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    outcome: text(row.outcome),
  };
}

function number(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
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

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as Row | undefined;
    return row === undefined ? undefined : String(row.value);
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // A seat grove has never watched gets an empty watch rather than undefined,
  // so every caller reads the same shape and none of them branches on it.
  watchFor(runnerId: number): RunnerWatch {
    const row = this.db
      .prepare('SELECT * FROM runner_watch WHERE runner_id = ?')
      .get(runnerId) as Row | undefined;
    return {
      runnerId,
      busySince: row === undefined ? null : number(row.busy_since),
      unregisteredSince:
        row === undefined ? null : number(row.unregistered_since),
      suspectSince: row === undefined ? null : number(row.suspect_since),
      suspectReason: row === undefined ? null : text(row.suspect_reason),
    };
  }

  setWatch(runnerId: number, watch: Omit<RunnerWatch, 'runnerId'>): void {
    this.db
      .prepare(
        `INSERT INTO runner_watch
           (runner_id, busy_since, unregistered_since, suspect_since, suspect_reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (runner_id) DO UPDATE SET
           busy_since = excluded.busy_since,
           unregistered_since = excluded.unregistered_since,
           suspect_since = excluded.suspect_since,
           suspect_reason = excluded.suspect_reason`,
      )
      .run(
        runnerId,
        watch.busySince,
        watch.unregisteredSince,
        watch.suspectSince,
        watch.suspectReason,
      );
  }

  /**
   * Forget every suspicion, keeping the observations the verdicts came from.
   * `daemon uninstall` calls it, because nothing watches the fleet afterwards
   * and a suspect nobody will revisit would sit in `grove status` for as long
   * as the record lives.
   */
  clearSuspects(): void {
    this.db
      .prepare(
        'UPDATE runner_watch SET suspect_since = NULL, suspect_reason = NULL',
      )
      .run();
  }

  startJob(runnerId: number, startedAt?: number): JobRecord {
    const result = this.db
      .prepare('INSERT INTO jobs (runner_id, started_at) VALUES (?, ?)')
      .run(runnerId, startedAt ?? this.now());
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as Row | undefined;
    if (row === undefined) {
      throw new Error(`grove.db lost the job it just opened for ${runnerId}`);
    }
    return toJob(row);
  }

  openJob(runnerId: number): JobRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE runner_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(runnerId) as Row | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  // The newest open row and no other. A seat whose earlier job never closed
  // keeps that row open, because inventing an end for it would invent a
  // duration too.
  endJob(
    runnerId: number,
    outcome: string,
    endedAt?: number,
  ): JobRecord | undefined {
    const open = this.openJob(runnerId);
    if (open === undefined) {
      return undefined;
    }
    const ended = endedAt ?? this.now();
    this.db
      .prepare(
        'UPDATE jobs SET ended_at = ?, duration_ms = ?, outcome = ? WHERE id = ?',
      )
      .run(ended, ended - open.startedAt, outcome, open.id);
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(open.id) as Row | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  jobsFor(runnerId: number, limit = 50): JobRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM jobs WHERE runner_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
      )
      .all(runnerId, limit) as Row[];
    return rows.map(toJob);
  }

  countEventsSince(
    runnerId: number,
    kind: RunnerEventKind,
    since: number,
  ): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM events WHERE runner_id = ? AND kind = ? AND ts >= ?',
      )
      .get(runnerId, kind, since) as Row | undefined;
    return Number(row?.n ?? 0);
  }

  lastEventAt(runnerId: number, kind: RunnerEventKind): number | undefined {
    const row = this.db
      .prepare(
        'SELECT MAX(ts) AS ts FROM events WHERE runner_id = ? AND kind = ?',
      )
      .get(runnerId, kind) as Row | undefined;
    return row?.ts === null || row?.ts === undefined
      ? undefined
      : Number(row.ts);
  }

  /**
   * Restarts per seat, over whatever history has not been pruned. The
   * exporter turns it into a counter, and a retention prune is a counter
   * reset, which is a thing Prometheus already understands.
   */
  restartCounts(): Array<{ runnerId: number; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT runner_id, COUNT(*) AS n FROM events
         WHERE kind = 'restarted' GROUP BY runner_id`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      runnerId: Number(row.runner_id),
      count: Number(row.n),
    }));
  }

  /**
   * Jobs per seat and outcome. A job grove is still watching has no outcome,
   * and is counted as `open` rather than dropped, because a seat that has
   * been busy for an hour is exactly what somebody is looking for.
   */
  jobOutcomeCounts(): Array<{
    runnerId: number;
    outcome: string;
    count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT runner_id, COALESCE(outcome, 'open') AS outcome, COUNT(*) AS n
         FROM jobs GROUP BY runner_id, COALESCE(outcome, 'open')`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      runnerId: Number(row.runner_id),
      outcome: String(row.outcome),
      count: Number(row.n),
    }));
  }

  /**
   * Drop history older than the cutoff. Records, registrations and watches
   * stay, because none of them is history: a record is ownership proof, a
   * registration holds a token GitLab shows once, and a watch is what the
   * next tick compares against.
   */
  pruneHistory(before: number): PrunedHistory {
    const events = this.db
      .prepare('DELETE FROM events WHERE ts < ?')
      .run(before);
    const liveness = this.db
      .prepare('DELETE FROM liveness WHERE ts < ?')
      .run(before);
    // An open job is not history. Dropping it would leave the `endJob` a
    // later tick runs with nothing to close, and grove would lose a job it is
    // still watching.
    const jobs = this.db
      .prepare('DELETE FROM jobs WHERE started_at < ? AND ended_at IS NOT NULL')
      .run(before);
    return {
      events: Number(events.changes),
      liveness: Number(liveness.changes),
      jobs: Number(jobs.changes),
    };
  }

  close(): void {
    this.db.close();
  }
}
