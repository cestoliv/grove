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
  `
  -- GitLab hands back the glrt- authentication token once and never again,
  -- and every later manager in the group registers against that same token.
  -- It is the one piece of state grove cannot derive from the host or the
  -- forge, which is why it is stored rather than observed.
  CREATE TABLE group_registrations (
    id INTEGER PRIMARY KEY,
    group_name TEXT NOT NULL,
    forge TEXT NOT NULL,
    forge_runner_id TEXT NOT NULL,
    url TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    retired_at INTEGER
  ) STRICT;

  CREATE UNIQUE INDEX group_registrations_active
    ON group_registrations (group_name, forge) WHERE retired_at IS NULL;

  -- gitlab-runner generates this at first start and writes it next to
  -- config.toml. It is the only field that tells one manager of an entity
  -- from another, because the managers endpoint exposes no name.
  ALTER TABLE runners ADD COLUMN system_id TEXT;
  `,
  `
  -- Where a native seat put its files. A group that leaves the config takes
  -- the work root and the install path with it, and the teardown that follows
  -- still has to find the runner release and the launchd plist to remove.
  -- Null for a container, which unpacks nothing on the host.
  ALTER TABLE runners ADD COLUMN install_dir TEXT;
  ALTER TABLE runners ADD COLUMN work_dir TEXT;

  -- Which supervisor runs this seat. A group that switches stack under a
  -- running seat leaves a record whose seat is on the old one, and only the
  -- record can say where to go and take it down.
  ALTER TABLE runners ADD COLUMN stack TEXT NOT NULL DEFAULT 'docker';
  `,
  `
  -- Small facts about the control loop itself: when the last fast tick ran,
  -- when the last full tick ran, when the daemon started. No runner sits
  -- behind any of them, which is why they are not events.
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  -- What one full tick has to tell the next about one seat. Every column is
  -- an observation grove made, kept only so the next observation can be
  -- compared with it. Losing the row costs one tick of latency and nothing
  -- else, which is why this table and meta above are a documented exception
  -- to "SQLite never decides", alongside the GitLab token in
  -- group_registrations: both are carried between ticks, not decided by.
  CREATE TABLE runner_watch (
    runner_id INTEGER PRIMARY KEY REFERENCES runners (id) ON DELETE CASCADE,
    -- When the forge first said busy, cleared the moment it says otherwise.
    busy_since INTEGER,
    -- When the forge first stopped listing a seat that is up on its host.
    unregistered_since INTEGER,
    -- One of the two stuck signals fired and the other did not.
    suspect_since INTEGER,
    suspect_reason TEXT
  ) STRICT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// `migrations` is a seam for tests. Production always migrates MIGRATIONS.
export function migrate(
  db: DatabaseSync,
  migrations: readonly string[] = MIGRATIONS,
): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  let version = Number(row?.user_version ?? 0);
  while (version < migrations.length) {
    const next = version + 1;
    // The statements and the version bump land together or not at all. A
    // half applied migration would leave every later open dying on a table
    // that already exists, and the database holds a token grove cannot
    // fetch again.
    db.exec('BEGIN');
    try {
      db.exec(migrations[version]);
      db.exec(`PRAGMA user_version = ${next}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction is already gone, which is the state the rollback
        // was asking for. The migration error is the one that travels.
      }
      throw error;
    }
    version = next;
  }
  return version;
}
