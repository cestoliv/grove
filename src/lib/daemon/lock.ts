import { randomBytes } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface LockHolder {
  pid: number;
  // What is holding it: `daemon`, `apply` or `teardown`. It is in the file so
  // the operator who is refused learns what to wait for.
  command: string;
  startedAt: string;
}

export class LockHeldError extends Error {
  readonly holder: LockHolder;
  readonly path: string;

  constructor(holder: LockHolder, path: string) {
    super(
      `another grove process holds ${path}: pid ${holder.pid} (${holder.command}) since ${holder.startedAt}. Wait for it to finish, or stop the daemon. grove plan, grove status and grove logs still work.`,
    );
    this.name = 'LockHeldError';
    this.holder = holder;
    this.path = path;
  }
}

/**
 * Signal 0 asks the kernel whether a pid exists without sending anything.
 * EPERM means it exists and belongs to somebody else, which is still alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLockHolder(path: string): LockHolder | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  return parseLockHolder(text);
}

function parseLockHolder(text: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<LockHolder>;
    // A pid of 0 or less names no real process. Treat it the same as a
    // parse failure: the file is corrupt, and stale by definition.
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0
    ) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      command: typeof parsed.command === 'string' ? parsed.command : 'grove',
      startedAt:
        typeof parsed.startedAt === 'string'
          ? parsed.startedAt
          : 'an unknown time',
    };
  } catch {
    // A truncated or hand-edited file names nobody, so it is stale by
    // definition and the caller takes it over.
    return undefined;
  }
}

interface LockSnapshot {
  ino: number;
  dev: number;
  body: string;
}

/**
 * Read the lock file's identity and its bytes together, so a later
 * comparison can tell a replaced file from the one we inspected.
 */
function readLockSnapshot(path: string): LockSnapshot | undefined {
  try {
    const body = readFileSync(path, 'utf8');
    const stat = statSync(path);
    return { ino: stat.ino, dev: stat.dev, body };
  } catch {
    return undefined;
  }
}

/**
 * `ino` and `dev` alone do not identify a file across an unlink. Linux
 * commonly hands the freed inode number straight back to the next file
 * created in the same directory, so a rival's fresh claim can wear the
 * inode of the stale lock we just judged dead. Compare the bytes too: a
 * rival writes a different pid and `startedAt`, and an in-place rewrite
 * keeps the inode outright.
 */
function sameLockFile(a: LockSnapshot, b: LockSnapshot): boolean {
  return a.ino === b.ino && a.dev === b.dev && a.body === b.body;
}

export interface StateLockOptions {
  path: string;
  command: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
}

export class StateLock {
  readonly path: string;
  readonly holder: LockHolder;

  private constructor(path: string, holder: LockHolder) {
    this.path = path;
    this.holder = holder;
  }

  static acquire(options: StateLockOptions): StateLock {
    const path = options.path;
    const holder: LockHolder = {
      pid: options.pid ?? process.pid,
      command: options.command,
      startedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    };
    const alive = options.isPidAlive ?? isPidAlive;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify(holder)}\n`;

    // Bounded: a well-behaved run claims on attempt 1, or takes over a
    // stale lock on attempt 2. Further attempts only happen under real
    // contention between multiple grove processes, which should not spin
    // forever.
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (StateLock.tryClaim(path, body)) {
        const confirmed = readLockHolder(path);
        if (
          confirmed?.pid === holder.pid &&
          confirmed.startedAt === holder.startedAt
        ) {
          return new StateLock(path, holder);
        }
        // Our own just-linked file reads back as somebody else's. The
        // link is atomic, so this should not happen, but do not lean on
        // that alone: retry rather than hand back a lock we do not hold.
        continue;
      }

      // Something is at `path`. Snapshot it before asking whether its pid
      // is alive, so a takeover only ever removes the exact file we
      // inspected, never a fresh claim that lands while we are asking.
      const baseline = readLockSnapshot(path);
      if (baseline === undefined) {
        // Vanished already. Nothing to remove; retry the claim.
        continue;
      }

      const existing = parseLockHolder(baseline.body);
      if (existing !== undefined && alive(existing.pid)) {
        throw new LockHeldError(existing, path);
      }

      // Stale: the pid is gone, or the file names nobody. Take it over
      // rather than make the operator delete a file after a reboot, but
      // only remove the exact file we snapshotted above.
      const recheck = readLockSnapshot(path);
      if (recheck !== undefined && sameLockFile(baseline, recheck)) {
        try {
          unlinkSync(path);
        } catch {
          // Already gone, which is what we wanted.
        }
      }
      // Otherwise somebody replaced the file between our snapshot and now,
      // either taking over the same stale lock themselves or renewing it.
      // That file is not the one we judged stale, so it is not ours to
      // remove: the next attempt evaluates it fresh.
    }

    const winner = readLockHolder(path);
    throw new LockHeldError(
      winner ?? { pid: 0, command: 'grove', startedAt: 'an unknown time' },
      path,
    );
  }

  /**
   * Write the holder to a unique temp file beside `path`, then hard-link it
   * onto `path`. `link` is atomic and fails with EEXIST when `path` is
   * already there, so there is no gap between checking and creating for a
   * second process to land in.
   */
  private static tryClaim(path: string, body: string): boolean {
    const tmp = join(
      dirname(path),
      `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      writeFileSync(tmp, body, { mode: 0o600 });
      linkSync(tmp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // Already gone, or never created.
      }
    }
  }

  /** Remove the file, but only while it still names this claim. */
  release(): void {
    const current = readLockHolder(this.path);
    // Both fields, the way `acquire` confirms them. A pid the kernel reused
    // after a stale takeover names a different process, and deleting its lock
    // would put two reconcilers on one fleet.
    if (
      current?.pid !== this.holder.pid ||
      current.startedAt !== this.holder.startedAt
    ) {
      return;
    }
    try {
      unlinkSync(this.path);
    } catch {
      // Already gone. Releasing a lock that is not there is a success.
    }
  }
}
