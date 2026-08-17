import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockHeldError, readLockHolder, StateLock } from './lock.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-lock-'));
  path = join(dir, 'grove.pid');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const alive = () => true;
const dead = () => false;

// A live claim that lands while we are deciding whether the lock is stale.
const rival = {
  pid: 99,
  command: 'rival',
  startedAt: new Date(0).toISOString(),
};

describe('StateLock', () => {
  it('writes the holder and removes the file on release', async () => {
    const lock = StateLock.acquire({
      path,
      command: 'daemon',
      pid: 4242,
      isPidAlive: dead,
      now: () => 0,
    });
    expect(lock.holder).toEqual({
      pid: 4242,
      command: 'daemon',
      startedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(4242);

    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('releases nothing when the same pid took the lock over later', async () => {
    // A pid the kernel reused names a different process. `acquire` confirms
    // both fields before it hands the lock back, so `release` compares both
    // too rather than deleting a lock this process does not hold.
    const lock = StateLock.acquire({
      path,
      command: 'daemon',
      pid: 4242,
      isPidAlive: dead,
      now: () => 0,
    });
    await writeFile(
      path,
      `${JSON.stringify({
        pid: 4242,
        command: 'apply',
        startedAt: '2026-08-16T09:12:04.008Z',
      })}\n`,
      'utf8',
    );

    lock.release();
    expect(existsSync(path)).toBe(true);
    expect(readLockHolder(path)?.command).toBe('apply');
  });

  it('refuses when a live process already holds it', () => {
    StateLock.acquire({ path, command: 'daemon', pid: 1, isPidAlive: alive });
    let thrown: unknown;
    try {
      StateLock.acquire({ path, command: 'apply', pid: 2, isPidAlive: alive });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LockHeldError);
    expect((thrown as LockHeldError).holder.pid).toBe(1);
    expect((thrown as LockHeldError).holder.command).toBe('daemon');
    expect((thrown as LockHeldError).message).toContain('daemon');
  });

  it('takes over a lock whose process is gone', () => {
    StateLock.acquire({ path, command: 'daemon', pid: 1, isPidAlive: alive });
    const lock = StateLock.acquire({
      path,
      command: 'apply',
      pid: 2,
      isPidAlive: dead,
    });
    expect(lock.holder.pid).toBe(2);
  });

  it('takes over a lockfile it cannot parse', async () => {
    await writeFile(path, 'not json at all', 'utf8');
    const lock = StateLock.acquire({
      path,
      command: 'apply',
      pid: 7,
      isPidAlive: alive,
    });
    expect(lock.holder.pid).toBe(7);
  });

  it('leaves a lock that somebody else took while we held ours', () => {
    const lock = StateLock.acquire({
      path,
      command: 'apply',
      pid: 3,
      isPidAlive: dead,
    });
    StateLock.acquire({ path, command: 'daemon', pid: 9, isPidAlive: dead });
    lock.release();
    expect(readLockHolder(path)?.pid).toBe(9);
  });

  it('creates the state directory when it is not there yet', () => {
    const nested = join(dir, 'nested', 'grove.pid');
    const lock = StateLock.acquire({
      path: nested,
      command: 'daemon',
      pid: 5,
      isPidAlive: dead,
    });
    expect(readLockHolder(nested)?.pid).toBe(5);
    lock.release();
  });

  it('does not clobber a lock that another process claimed during a stale takeover', () => {
    // pid 1 holds a lock that is about to be judged stale.
    StateLock.acquire({ path, command: 'daemon', pid: 1, isPidAlive: dead });

    // Simulate a second process winning the same race: right as our
    // liveness check for pid 1 runs, the file at `path` gets replaced by a
    // rival's fresh, live claim. `rename` swaps the file atomically, the way
    // a real writer replaces a file it does not want another reader to see
    // half of.
    const isPidAlive = (pid: number): boolean => {
      if (pid === 1) {
        const staging = `${path}.rival`;
        writeFileSync(staging, `${JSON.stringify(rival)}\n`, { mode: 0o600 });
        renameSync(staging, path);
        return false;
      }
      return pid === 99;
    };

    let thrown: unknown;
    try {
      StateLock.acquire({ path, command: 'apply', pid: 2, isPidAlive });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LockHeldError);
    expect((thrown as LockHeldError).holder.pid).toBe(99);
    // The rival's lock survives untouched: we never unlinked it.
    expect(readLockHolder(path)?.pid).toBe(99);
  });

  it('does not clobber a rival claim that reuses the inode of the stale file', () => {
    StateLock.acquire({ path, command: 'daemon', pid: 1, isPidAlive: dead });

    // The rival unlinks and recreates the file. Linux commonly hands the
    // freed inode number straight back, so `ino` and `dev` alone cannot tell
    // the two files apart.
    const isPidAlive = (pid: number): boolean => {
      if (pid === 1) {
        unlinkSync(path);
        writeFileSync(path, `${JSON.stringify(rival)}\n`, { mode: 0o600 });
        return false;
      }
      return pid === 99;
    };

    let thrown: unknown;
    try {
      StateLock.acquire({ path, command: 'apply', pid: 2, isPidAlive });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LockHeldError);
    expect((thrown as LockHeldError).holder.pid).toBe(99);
    expect(readLockHolder(path)?.pid).toBe(99);
  });

  it('does not clobber a rival that rewrote the lock file in place', () => {
    StateLock.acquire({ path, command: 'daemon', pid: 1, isPidAlive: dead });

    // The rival truncates and rewrites the same inode, so `ino` and `dev`
    // are guaranteed to match on every platform. Only the contents say the
    // file changed hands.
    const isPidAlive = (pid: number): boolean => {
      if (pid === 1) {
        writeFileSync(path, `${JSON.stringify(rival)}\n`, { mode: 0o600 });
        return false;
      }
      return pid === 99;
    };

    let thrown: unknown;
    try {
      StateLock.acquire({ path, command: 'apply', pid: 2, isPidAlive });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LockHeldError);
    expect((thrown as LockHeldError).holder.pid).toBe(99);
    expect(readLockHolder(path)?.pid).toBe(99);
  });

  it('takes over a lock file whose pid is zero or negative', async () => {
    await writeFile(
      path,
      JSON.stringify({
        pid: 0,
        command: 'daemon',
        startedAt: new Date(0).toISOString(),
      }),
      'utf8',
    );
    const lock = StateLock.acquire({
      path,
      command: 'apply',
      pid: 7,
      isPidAlive: alive,
    });
    expect(lock.holder.pid).toBe(7);

    await writeFile(
      path,
      JSON.stringify({
        pid: -5,
        command: 'daemon',
        startedAt: new Date(0).toISOString(),
      }),
      'utf8',
    );
    const lock2 = StateLock.acquire({
      path,
      command: 'apply',
      pid: 8,
      isPidAlive: alive,
    });
    expect(lock2.holder.pid).toBe(8);
  });
});

describe('readLockHolder', () => {
  it('answers undefined for a missing or unreadable file', async () => {
    expect(readLockHolder(path)).toBeUndefined();
    await writeFile(path, '{"pid":"nope"}', 'utf8');
    expect(readLockHolder(path)).toBeUndefined();
  });
});
