import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalTransport } from './local.js';
import { TIMEOUT_EXIT_CODE } from './process.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-local-'));
});

describe('LocalTransport', () => {
  it('runs a command and captures stdout', async () => {
    const result = await new LocalTransport().exec('echo', ['hello']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('');
  });

  it('reports a non-zero exit code instead of throwing', async () => {
    const result = await new LocalTransport().exec('sh', ['-c', 'exit 3']);
    expect(result.code).toBe(3);
  });

  it('captures stderr separately', async () => {
    const result = await new LocalTransport().exec('sh', [
      '-c',
      'echo oops >&2',
    ]);
    expect(result.stderr).toBe('oops\n');
    expect(result.stdout).toBe('');
  });

  it('feeds stdin to the command', async () => {
    const result = await new LocalTransport().exec('cat', [], {
      stdin: 'piped input\n',
    });
    expect(result.stdout).toBe('piped input\n');
  });

  it('honours cwd', async () => {
    const result = await new LocalTransport().exec('pwd', [], { cwd: dir });
    expect(result.stdout.trim()).toContain('grove-local-');
  });

  it('honours extra environment variables', async () => {
    const result = await new LocalTransport().exec(
      'sh',
      ['-c', 'echo $GROVE_X'],
      {
        env: { GROVE_X: 'set-by-test' },
      },
    );
    expect(result.stdout.trim()).toBe('set-by-test');
  });

  it('kills a command that outruns its timeout', async () => {
    const result = await new LocalTransport().exec('sh', ['-c', 'sleep 5'], {
      timeoutMs: 150,
    });
    expect(result.code).toBe(TIMEOUT_EXIT_CODE);
    expect(result.stderr).toContain('timed out after 150ms');
  });

  it('rejects when the binary does not exist', async () => {
    await expect(
      new LocalTransport().exec('grove-does-not-exist', []),
    ).rejects.toThrow(/ENOENT/);
  });

  it('round-trips a file', async () => {
    const transport = new LocalTransport();
    const path = join(dir, 'unit.service');
    await transport.writeFile(path, 'body\n');
    expect(await readFile(path, 'utf8')).toBe('body\n');
    expect(await transport.readFile(path)).toBe('body\n');
  });

  it('expands a tilde in a file path for reads and writes', async () => {
    const transport = new LocalTransport();
    const subdir = `.grove-test-${randomBytes(6).toString('hex')}`;
    const homePath = join(homedir(), subdir);
    try {
      await mkdir(homePath, { recursive: true });
      await writeFile(join(homePath, 'read.txt'), 'read body\n', 'utf8');
      expect(await transport.readFile(`~/${subdir}/read.txt`)).toBe(
        'read body\n',
      );

      await transport.writeFile(`~/${subdir}/write.txt`, 'write body\n');
      expect(await readFile(join(homePath, 'write.txt'), 'utf8')).toBe(
        'write body\n',
      );
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it('closes without doing anything', async () => {
    await expect(new LocalTransport().close()).resolves.toBeUndefined();
  });

  it('defaults its name to local', () => {
    expect(new LocalTransport().name).toBe('local');
    expect(new LocalTransport('mac').name).toBe('mac');
  });
});
