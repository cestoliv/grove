import { describe, expect, it } from 'vitest';
import { FakeTransport } from './fake.js';

describe('FakeTransport', () => {
  it('returns a scripted response for a matching command line prefix', async () => {
    const transport = new FakeTransport('mac').on('uname', {
      stdout: 'Darwin arm64\n',
    });
    expect(await transport.exec('uname', ['-sm'])).toEqual({
      code: 0,
      stdout: 'Darwin arm64\n',
      stderr: '',
    });
  });

  it('matches on the full command line, not just the binary', async () => {
    const transport = new FakeTransport()
      .on('docker ps', { stdout: 'containers' })
      .on('docker images', { stdout: 'images' });
    expect((await transport.exec('docker', ['ps', '-a'])).stdout).toBe(
      'containers',
    );
    expect((await transport.exec('docker', ['images'])).stdout).toBe('images');
  });

  it('returns a zero exit and empty output when nothing matches', async () => {
    const transport = new FakeTransport();
    expect(await transport.exec('anything', [])).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('honours a configured fallback', async () => {
    const transport = new FakeTransport().setFallback({
      code: 127,
      stderr: 'command not found',
    });
    expect(await transport.exec('nope', [])).toEqual({
      code: 127,
      stdout: '',
      stderr: 'command not found',
    });
  });

  it('scripts a failure', async () => {
    const transport = new FakeTransport().fail(
      'uname',
      'no route to host',
      255,
    );
    expect(await transport.exec('uname', ['-sm'])).toEqual({
      code: 255,
      stdout: '',
      stderr: 'no route to host',
    });
  });

  it('scripts a thrown error, which is how a missing ssh binary behaves', async () => {
    const transport = new FakeTransport().throwOn('ssh', 'spawn ssh ENOENT');
    await expect(transport.exec('ssh', ['atlas'])).rejects.toThrow(
      'spawn ssh ENOENT',
    );
  });

  it('records every call with its options', async () => {
    const transport = new FakeTransport();
    await transport.exec('uname', ['-sm'], { timeoutMs: 5000 });
    await transport.exec('docker', ['ps']);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].options).toEqual({ timeoutMs: 5000 });
    expect(transport.commandLines()).toEqual(['uname -sm', 'docker ps']);
  });

  it('serves a preloaded file and rejects an unknown one', async () => {
    const transport = new FakeTransport().file(
      '/etc/os-release',
      'ID=debian\n',
    );
    expect(await transport.readFile('/etc/os-release')).toBe('ID=debian\n');
    await expect(transport.readFile('/nope')).rejects.toThrow(
      'FakeTransport has no file at /nope',
    );
  });

  it('records a write and serves it back', async () => {
    const transport = new FakeTransport();
    await transport.writeFile('/tmp/unit.service', 'body');
    expect(transport.writes.get('/tmp/unit.service')).toBe('body');
    expect(await transport.readFile('/tmp/unit.service')).toBe('body');
  });

  it('records that it was closed', async () => {
    const transport = new FakeTransport();
    expect(transport.closed).toBe(false);
    await transport.close();
    expect(transport.closed).toBe(true);
  });

  it('defaults its name to fake', () => {
    expect(new FakeTransport().name).toBe('fake');
    expect(new FakeTransport('atlas').name).toBe('atlas');
  });
});

describe('FakeTransport streaming', () => {
  it('replays scripted output through the callbacks', async () => {
    const transport = new FakeTransport('mac').on('docker logs', {
      stdout: 'line one\n',
      stderr: 'warn\n',
    });
    const out: string[] = [];
    const err: string[] = [];

    await transport.exec('docker', ['logs', 'grove-ios-1'], {
      onStdout: (chunk) => out.push(chunk),
      onStderr: (chunk) => err.push(chunk),
    });

    expect(out).toEqual(['line one\n']);
    expect(err).toEqual(['warn\n']);
  });

  it('calls nothing when the scripted output is empty', async () => {
    const transport = new FakeTransport('mac').on('docker stop', { code: 0 });
    const out: string[] = [];
    await transport.exec('docker', ['stop', 'grove-ios-1'], {
      onStdout: (chunk) => out.push(chunk),
    });
    expect(out).toEqual([]);
  });
});
