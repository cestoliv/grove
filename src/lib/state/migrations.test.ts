import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, SCHEMA_VERSION } from './migrations.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
});

afterEach(() => {
  db.close();
});

function userVersion(): number {
  const row = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  return Number(row.user_version);
}

function tables(): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

describe('migrate', () => {
  it('runs the shipped migrations and reports the version', () => {
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(userVersion()).toBe(SCHEMA_VERSION);
    expect(tables()).toContain('group_registrations');
  });

  it('does nothing on a database already at the current version', () => {
    migrate(db);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
  });

  it('leaves the version untouched when a migration fails halfway', () => {
    const broken = [
      'CREATE TABLE one (id INTEGER PRIMARY KEY) STRICT;',
      `CREATE TABLE two (id INTEGER PRIMARY KEY) STRICT;
       THIS IS NOT SQL;`,
    ];
    expect(migrate(db, [broken[0]])).toBe(1);
    expect(() => migrate(db, broken)).toThrow();
    // Version 2 never happened, so the next open retries it from a clean
    // schema rather than dying on "table two already exists".
    expect(userVersion()).toBe(1);
    expect(tables()).toContain('one');
    expect(tables()).not.toContain('two');
  });

  it('rolls back far enough to run the same migration again', () => {
    const good = 'CREATE TABLE two (id INTEGER PRIMARY KEY) STRICT;';
    const broken = ['CREATE TABLE one (id INTEGER PRIMARY KEY) STRICT;'];
    migrate(db, broken);
    expect(() =>
      migrate(db, [...broken, `${good} THIS IS NOT SQL;`]),
    ).toThrow();
    expect(migrate(db, [...broken, good])).toBe(2);
    expect(userVersion()).toBe(2);
    expect(tables()).toContain('two');
  });

  it('keeps every shipped migration a single version step', () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });
});
