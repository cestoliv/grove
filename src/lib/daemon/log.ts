import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

// One previous file is kept. Fifty megabytes of one-line events is months of
// a healthy fleet, and an operator who wants more has journald and grove.db.
export const LOG_MAX_BYTES = 50 * 1024 * 1024;

// The same mode the state directory gets. The log quotes the stderr of a
// failing `command:` credential, so the directory's 0700 must not be the only
// thing standing between it and the rest of the machine.
const LOG_MODE = 0o600;

const LEVEL_WIDTH = 5;
const SUBJECT_WIDTH = 24;

/**
 * One event, one line. A message that spans lines is folded onto one, because
 * an SSH failure with four lines of stderr would otherwise become four log
 * entries, three of them with no timestamp and no subject.
 */
export function formatLogLine(
  ts: number,
  level: LogLevel,
  subject: string,
  message: string,
): string {
  const when = new Date(ts).toISOString();
  const who = (subject.trim() === '' ? '-' : subject).padEnd(SUBJECT_WIDTH);
  const what = message.replace(/\s*[\r\n]+\s*/g, ' ').trimEnd();
  return `${when}  ${level.padEnd(LEVEL_WIDTH)}  ${who}  ${what}`;
}

export interface DaemonLogOptions {
  now?: () => number;
  maxBytes?: number;
}

export class DaemonLog {
  readonly path: string;

  private fd: number;
  private bytes: number;
  private readonly now: () => number;
  private readonly maxBytes: number;

  private constructor(
    path: string,
    fd: number,
    bytes: number,
    options: DaemonLogOptions,
  ) {
    this.path = path;
    this.fd = fd;
    this.bytes = bytes;
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  }

  static open(path: string, options: DaemonLogOptions = {}): DaemonLog {
    // The same mode the state directory gets, because the log names groups,
    // hosts and runner names even though it never names a token.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'a', LOG_MODE);
    return new DaemonLog(path, fd, fstatSync(fd).size, options);
  }

  info(subject: string, message: string): void {
    this.write('info', subject, message);
  }

  warn(subject: string, message: string): void {
    this.write('warn', subject, message);
  }

  error(subject: string, message: string): void {
    this.write('error', subject, message);
  }

  private write(level: LogLevel, subject: string, message: string): void {
    const line = `${formatLogLine(this.now(), level, subject, message)}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes > 0 && this.bytes + size > this.maxBytes) {
      this.roll();
    }
    try {
      // Synchronous, because the line that explains a crash is the one a
      // buffered writer loses.
      writeSync(this.fd, line);
      this.bytes += size;
    } catch {
      // A full disk must not become the daemon's reported failure. The log is
      // diagnostics, and a logger that throws replaces every real error with
      // its own, three frames further out.
    }
  }

  private roll(): void {
    try {
      closeSync(this.fd);
      // renameSync replaces an existing .1, so exactly one previous file is
      // kept and the directory never grows without bound.
      renameSync(this.path, `${this.path}.1`);
      this.fd = openSync(this.path, 'a', LOG_MODE);
      this.bytes = 0;
    } catch {
      // The fd is closed by now, so leaving it there would make every later
      // line throw EBADF. Reopen the original file and keep logging to it:
      // an oversized log is worth more than a daemon that dies reporting a
      // rename.
      try {
        this.fd = openSync(this.path, 'a', LOG_MODE);
        this.bytes = fstatSync(this.fd).size;
      } catch {
        // Nothing left to write to. `write` swallows the EBADF that follows.
      }
    }
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      // A roll that could not reopen leaves a closed fd behind. Closing it
      // again is not a failure worth reporting from a `finally`.
    }
  }
}
