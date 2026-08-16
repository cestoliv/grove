import { describe, expect, it } from 'vitest';
import { FakeTransport } from './fake.js';
import { normalizeArch, PROBE_TIMEOUT_MS, probeHost } from './probe.js';

describe('normalizeArch', () => {
  it('folds the aarch64 and arm64 spellings together', () => {
    expect(normalizeArch('aarch64')).toBe('arm64');
    expect(normalizeArch('arm64')).toBe('arm64');
  });

  it('folds the x86_64 and amd64 spellings together', () => {
    expect(normalizeArch('x86_64')).toBe('amd64');
    expect(normalizeArch('amd64')).toBe('amd64');
  });

  it('passes anything else through in lower case', () => {
    expect(normalizeArch(' RISCV64 ')).toBe('riscv64');
  });
});

describe('probeHost', () => {
  it('reports a reachable host with its platform and architecture', async () => {
    const transport = new FakeTransport('mac').on('uname', {
      stdout: 'Darwin arm64\n',
    });
    expect(await probeHost('mac', transport)).toEqual({
      host: 'mac',
      reachable: true,
      platform: 'Darwin',
      arch: 'arm64',
    });
  });

  it('normalises a Linux architecture', async () => {
    const transport = new FakeTransport('atlas').on('uname', {
      stdout: 'Linux x86_64\n',
    });
    const probe = await probeHost('atlas', transport);
    expect(probe.platform).toBe('Linux');
    expect(probe.arch).toBe('amd64');
  });

  it('uses the default timeout and passes it to exec', async () => {
    const transport = new FakeTransport('mac').on('uname', {
      stdout: 'Darwin arm64\n',
    });
    await probeHost('mac', transport);
    expect(transport.calls[0].command).toBe('uname');
    expect(transport.calls[0].args).toEqual(['-sm']);
    expect(transport.calls[0].options?.timeoutMs).toBe(PROBE_TIMEOUT_MS);
  });

  it('passes an explicit timeout through', async () => {
    const transport = new FakeTransport('mac');
    await probeHost('mac', transport, 2500);
    expect(transport.calls[0].options?.timeoutMs).toBe(2500);
  });

  it('reports the first stderr line as the reason for a non-zero exit', async () => {
    const transport = new FakeTransport('atlas').fail(
      'uname',
      'ssh: connect to host atlas port 22: No route to host\r\nlost connection\n',
      255,
    );
    expect(await probeHost('atlas', transport)).toEqual({
      host: 'atlas',
      reachable: false,
      reason: 'ssh: connect to host atlas port 22: No route to host',
    });
  });

  it('falls back to the exit code when there is no stderr', async () => {
    const transport = new FakeTransport('atlas').fail('uname', '', 255);
    const probe = await probeHost('atlas', transport);
    expect(probe.reachable).toBe(false);
    expect(probe.reason).toBe('uname -sm exited 255');
  });

  it('turns a thrown error into an unreachable result', async () => {
    const transport = new FakeTransport('atlas').throwOn(
      'uname',
      'spawn ssh ENOENT',
    );
    expect(await probeHost('atlas', transport)).toEqual({
      host: 'atlas',
      reachable: false,
      reason: 'spawn ssh ENOENT',
    });
  });

  it('reports a timeout as unreachable', async () => {
    const transport = new FakeTransport('atlas').on('uname', {
      code: 124,
      stderr: 'timed out after 10000ms',
    });
    const probe = await probeHost('atlas', transport);
    expect(probe.reachable).toBe(false);
    expect(probe.reason).toBe('timed out after 10000ms');
  });

  it('treats a zero exit with unparseable output as reachable with no arch', async () => {
    const transport = new FakeTransport('mac').on('uname', { stdout: '\n' });
    expect(await probeHost('mac', transport)).toEqual({
      host: 'mac',
      reachable: true,
      platform: undefined,
      arch: undefined,
    });
  });
});
