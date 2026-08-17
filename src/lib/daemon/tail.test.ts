import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastLines, tailFile } from './tail.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-tail-'));
  path = join(dir, 'grove.log');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('lastLines', () => {
  it('keeps the last n lines and their trailing newline', () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc\n');
  });

  it('keeps everything when there are fewer lines than asked for', () => {
    expect(lastLines('a\nb\n', 10)).toBe('a\nb\n');
  });

  it('answers nothing for an empty file', () => {
    expect(lastLines('', 10)).toBe('');
  });

  // The window read from the end can start mid-line, and half a line is
  // worse than no line.
  it('drops a leading partial line when asked to', () => {
    expect(lastLines('lf-of-a-line\nb\nc\n', 2)).toBe('b\nc\n');
  });
});

describe('tailFile', () => {
  it('prints the last lines and returns', async () => {
    await writeFile(path, 'one\ntwo\nthree\n', 'utf8');
    const out: string[] = [];
    await tailFile(path, { lines: 2, write: (text) => out.push(text) });
    expect(out.join('')).toBe('two\nthree\n');
  });

  it('names the install command when the log is not there', async () => {
    await expect(
      tailFile(path, { lines: 10, write: () => undefined }),
    ).rejects.toThrow(/grove daemon install/);
  });

  it('streams what is appended while it follows', async () => {
    await writeFile(path, 'one\n', 'utf8');
    const out: string[] = [];
    const controller = new AbortController();

    const following = tailFile(path, {
      lines: 10,
      follow: true,
      pollIntervalMs: 5,
      signal: controller.signal,
      write: (text) => {
        out.push(text);
        if (out.join('').includes('two')) {
          controller.abort();
        }
      },
    });

    await appendFile(path, 'two\n', 'utf8');
    await following;

    expect(out.join('')).toContain('one');
    expect(out.join('')).toContain('two');
  });

  it('starts again from the top when the log rolls over under it', async () => {
    await writeFile(path, 'aaaaaaaaaaaaaaaa\n', 'utf8');
    const out: string[] = [];
    const controller = new AbortController();

    const following = tailFile(path, {
      lines: 10,
      follow: true,
      pollIntervalMs: 5,
      signal: controller.signal,
      write: (text) => {
        out.push(text);
        if (out.join('').includes('rolled')) {
          controller.abort();
        }
      },
    });

    await writeFile(path, 'rolled\n', 'utf8');
    await following;

    expect(out.join('')).toContain('rolled');
  });

  // DaemonLog rolls by renaming grove.log to grove.log.1 and creating a
  // fresh grove.log, rather than truncating in place. An open handle keeps
  // reading the renamed file (its size never moves), so size-only rollover
  // detection misses this and the follow loop would sit reading a file that
  // no longer has the name anyone else is writing to.
  it('detects a renamed rollover and starts again from the top', async () => {
    await writeFile(path, 'one\n', 'utf8');
    const out: string[] = [];
    const controller = new AbortController();

    const following = tailFile(path, {
      lines: 10,
      follow: true,
      pollIntervalMs: 5,
      signal: controller.signal,
      write: (text) => {
        out.push(text);
        if (out.join('').includes('fresh')) {
          controller.abort();
        }
      },
    });

    await rename(path, `${path}.1`);
    await writeFile(path, 'fresh\n', 'utf8');
    await following;

    expect(out.join('')).toContain('fresh');
  });
});
