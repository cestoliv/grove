import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonLog, formatLogLine } from './log.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-log-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('formatLogLine', () => {
  it('writes an ISO timestamp, a level, a subject and a message', () => {
    expect(
      formatLogLine(1_700_000_000_000, 'info', 'grove-ios-1', 'started'),
    ).toBe(
      '2023-11-14T22:13:20.000Z  info   grove-ios-1               started',
    );
  });

  it('uses a dash for an event with no subject', () => {
    expect(formatLogLine(0, 'warn', '', 'atlas did not answer')).toContain(
      '  -  ',
    );
  });

  it('folds a multi-line message onto one line', () => {
    expect(formatLogLine(0, 'error', 'mac', 'a\nb\r\nc')).toMatch(/a b c$/);
  });
});

describe('DaemonLog', () => {
  it('appends to the file and keeps what was already there', async () => {
    const path = join(dir, 'grove.log');
    await writeFile(path, 'earlier\n', 'utf8');
    const log = DaemonLog.open(path, { now: () => 0 });
    log.info('mac', 'first');
    log.warn('atlas', 'second');
    log.close();

    const text = await readFile(path, 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(3);
    expect(text).toContain('earlier');
    expect(text).toContain('info');
    expect(text).toContain('warn');
  });

  it('rolls over once the file passes the size limit', async () => {
    const path = join(dir, 'grove.log');
    const log = DaemonLog.open(path, { now: () => 0, maxBytes: 140 });
    log.info('mac', 'one');
    log.info('mac', 'two');
    log.info('mac', 'three');
    log.close();

    const rolled = await readFile(`${path}.1`, 'utf8');
    const current = await readFile(path, 'utf8');
    expect(rolled).toContain('one');
    expect(current).toContain('three');
    expect(current).not.toContain('one');
  });

  it('creates the file private to the operator', async () => {
    // The log quotes the stderr of a failing `command:` credential, so it gets
    // the same mode the state directory does rather than whatever the umask
    // happens to be.
    const path = join(dir, 'grove.log');
    const log = DaemonLog.open(path, { now: () => 0 });
    log.info('mac', 'first');
    log.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('keeps writing when the rollover itself fails', async () => {
    // A directory at the rollover path makes renameSync fail. The fd must
    // survive it, because a logger that throws EBADF from then on replaces the
    // real failure with its own on every later line.
    const path = join(dir, 'grove.log');
    await mkdir(`${path}.1`, { recursive: true });
    await writeFile(join(`${path}.1`, 'keep'), 'x', 'utf8');

    const log = DaemonLog.open(path, { now: () => 0, maxBytes: 140 });
    log.info('mac', 'one');
    log.info('mac', 'two');
    log.info('mac', 'three');
    log.close();

    const text = await readFile(path, 'utf8');
    expect(text).toContain('one');
    expect(text).toContain('three');
  });

  it('creates the state directory when it is not there yet', async () => {
    const path = join(dir, 'nested', 'grove.log');
    const log = DaemonLog.open(path, { now: () => 0 });
    log.info('mac', 'first');
    log.close();
    expect(await readFile(path, 'utf8')).toContain('first');
  });
});
