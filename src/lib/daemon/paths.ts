import { join } from 'node:path';
import { resolveStateDir, type StateDirOptions } from '../state/index.js';

// The spec's contents of the state directory, beside grove.db.
export const DAEMON_LOG_FILE = 'grove.log';
export const DAEMON_LOCK_FILE = 'grove.pid';
// Whatever the daemon writes before its own logger is open, and whatever a
// crash prints on the way out. launchd redirects into these. On Linux the
// journal holds the same output, so the unit names neither.
export const DAEMON_STDOUT_FILE = 'daemon.out.log';
export const DAEMON_STDERR_FILE = 'daemon.err.log';

export function daemonLogPath(options: StateDirOptions = {}): string {
  return join(resolveStateDir(options), DAEMON_LOG_FILE);
}

export function daemonLockPath(options: StateDirOptions = {}): string {
  return join(resolveStateDir(options), DAEMON_LOCK_FILE);
}

export function daemonStdoutPath(options: StateDirOptions = {}): string {
  return join(resolveStateDir(options), DAEMON_STDOUT_FILE);
}

export function daemonStderrPath(options: StateDirOptions = {}): string {
  return join(resolveStateDir(options), DAEMON_STDERR_FILE);
}
