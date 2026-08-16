import type { DatabaseSync } from 'node:sqlite';

// One string per version. Never edit a shipped entry, append a new one.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE runners (
    id INTEGER PRIMARY KEY,
    group_name TEXT NOT NULL,
    runner_index INTEGER NOT NULL,
    host TEXT NOT NULL,
    forge TEXT NOT NULL,
    forge_runner_id TEXT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    retired_at INTEGER
  ) STRICT;

  CREATE UNIQUE INDEX runners_active_name
    ON runners (name) WHERE retired_at IS NULL;
  CREATE INDEX runners_group ON runners (group_name, runner_index);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    runner_id INTEGER NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ts INTEGER NOT NULL,
    reason TEXT
  ) STRICT;

  CREATE INDEX events_runner ON events (runner_id, ts);

  CREATE TABLE liveness (
    id INTEGER PRIMARY KEY,
    runner_id INTEGER NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    state TEXT NOT NULL
  ) STRICT;

  CREATE INDEX liveness_runner ON liveness (runner_id, ts);

  -- Job history. The daemon fills this in milestone 5. The table exists now
  -- so the schema does not move under a database that is already collecting
  -- runner lifecycle events.
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    runner_id INTEGER NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    outcome TEXT
  ) STRICT;

  CREATE INDEX jobs_runner ON jobs (runner_id, started_at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  let version = Number(row?.user_version ?? 0);
  while (version < MIGRATIONS.length) {
    db.exec(MIGRATIONS[version]);
    version += 1;
    db.exec(`PRAGMA user_version = ${version}`);
  }
  return version;
}
