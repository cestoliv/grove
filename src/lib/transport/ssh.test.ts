import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRemoteCommand,
  buildSshArgs,
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_CONTROL_PERSIST,
  SshTransport,
  shellQuote,
} from './ssh.js';
import { createFakeSpawn } from './test-utils.js';

const ARGV_OPTIONS = {
  controlPath: '/tmp/grove-ssh/%C',
  controlPersist: '60s',
  connectTimeoutSeconds: 10,
};

describe('shellQuote', () => {
  it('single quotes a plain value', () => {
    expect(shellQuote('atlas')).toBe("'atlas'");
  });

  it('escapes an embedded single quote', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('neutralises shell metacharacters', () => {
    expect(shellQuote('a; rm -rf /')).toBe("'a; rm -rf /'");
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'");
  });
});

describe('buildRemoteCommand', () => {
  it('quotes the command and every argument', () => {
    expect(buildRemoteCommand('uname', ['-sm'])).toBe("'uname' '-sm'");
  });

  it('prefixes a cd when cwd is set', () => {
    expect(buildRemoteCommand('ls', [], { cwd: '/PROD/local/grove' })).toBe(
      "cd '/PROD/local/grove' && 'ls'",
    );
  });

  it('prefixes environment assignments', () => {
    expect(buildRemoteCommand('env', [], { env: { GROVE_X: 'a b' } })).toBe(
      "GROVE_X='a b' 'env'",
    );
  });

  it('puts the cd before the environment assignments', () => {
    expect(buildRemoteCommand('ls', [], { cwd: '/tmp', env: { A: '1' } })).toBe(
      "cd '/tmp' && A='1' 'ls'",
    );
  });

  it('rejects an environment variable name that is not an identifier', () => {
    expect(() =>
      buildRemoteCommand('env', [], { env: { 'a-b': '1' } }),
    ).toThrow(/not a valid environment variable name/);
  });
});

describe('buildSshArgs', () => {
  it('builds the argv with the persistent control master options', () => {
    expect(buildSshArgs('atlas', "'uname' '-sm'", ARGV_OPTIONS)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPath=/tmp/grove-ssh/%C',
      '-o',
      'ControlPersist=60s',
      '--',
      'atlas',
      "'uname' '-sm'",
    ]);
  });

  it('passes the target through untouched, so ssh config aliases keep working', () => {
    const args = buildSshArgs('ci@atlas.internal', "'true'", ARGV_OPTIONS);
    expect(args.at(-2)).toBe('ci@atlas.internal');
  });

  it('terminates options with -- so a host value cannot be parsed as an ssh flag', () => {
    const args = buildSshArgs(
      '-oProxyCommand=touch /tmp/pwned',
      'uname -sm',
      ARGV_OPTIONS,
    );
    expect(args.at(-3)).toBe('--');
    expect(args.at(-2)).toBe('-oProxyCommand=touch /tmp/pwned');
  });
});

describe('SshTransport', () => {
  it('exposes the defaults the spec calls for', () => {
    expect(DEFAULT_CONTROL_PERSIST).toBe('60s');
    expect(DEFAULT_CONNECT_TIMEOUT_SECONDS).toBe(10);
  });

  it('builds argv for a command without connecting', () => {
    const transport = new SshTransport('atlas', 'atlas', ARGV_OPTIONS);
    expect(transport.argsFor('docker', ['ps', '-a'])).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPath=/tmp/grove-ssh/%C',
      '-o',
      'ControlPersist=60s',
      '--',
      'atlas',
      "'docker' 'ps' '-a'",
    ]);
  });

  it('defaults the control path under ~/.ssh/grove, short enough for the AF_UNIX limit', () => {
    const transport = new SshTransport('atlas', 'atlas');
    const args = transport.argsFor('true', []);
    const controlPathEntry = args.find((arg) => arg.startsWith('ControlPath='));
    const controlPath = controlPathEntry?.slice('ControlPath='.length);
    expect(controlPath?.startsWith(join(homedir(), '.ssh', 'grove'))).toBe(
      true,
    );
  });

  it('runs the ssh binary with that argv', async () => {
    const { spawnFn, calls } = createFakeSpawn({ stdout: 'Linux x86_64\n' });
    const transport = new SshTransport('atlas', 'atlas', {
      ...ARGV_OPTIONS,
      spawnFn,
    });
    const result = await transport.exec('uname', ['-sm']);
    expect(result).toEqual({ code: 0, stdout: 'Linux x86_64\n', stderr: '' });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('ssh');
    expect(calls[0].args.at(-1)).toBe("'uname' '-sm'");
  });

  it('reads a file with cat and fails loudly when cat fails', async () => {
    const ok = createFakeSpawn({ stdout: 'ID=debian\n' });
    const okTransport = new SshTransport('atlas', 'atlas', {
      ...ARGV_OPTIONS,
      spawnFn: ok.spawnFn,
    });
    expect(await okTransport.readFile('/etc/os-release')).toBe('ID=debian\n');
    expect(ok.calls[0].args.at(-1)).toBe("'cat' '/etc/os-release'");

    const bad = createFakeSpawn({ code: 1, stderr: 'cat: no such file\n' });
    const badTransport = new SshTransport('atlas', 'atlas', {
      ...ARGV_OPTIONS,
      spawnFn: bad.spawnFn,
    });
    await expect(badTransport.readFile('/nope')).rejects.toThrow(
      'cannot read /nope on atlas: cat: no such file',
    );
  });

  it('writes a file by piping the content into a remote redirect', async () => {
    const { spawnFn, calls } = createFakeSpawn();
    const transport = new SshTransport('atlas', 'atlas', {
      ...ARGV_OPTIONS,
      spawnFn,
    });
    await transport.writeFile('/PROD/local/grove/unit.service', 'body\n');
    expect(calls[0].args.at(-1)).toBe(
      "'sh' '-c' 'cat > '\\''/PROD/local/grove/unit.service'\\'''",
    );
    expect(calls[0].stdin).toBe('body\n');
  });

  it('fails loudly when the remote write fails', async () => {
    const { spawnFn } = createFakeSpawn({
      code: 1,
      stderr: 'sh: cannot create /nope: Permission denied\n',
    });
    const transport = new SshTransport('atlas', 'atlas', {
      ...ARGV_OPTIONS,
      spawnFn,
    });
    await expect(transport.writeFile('/nope', 'body\n')).rejects.toThrow(
      'cannot write /nope on atlas: sh: cannot create /nope: Permission denied',
    );
  });

  it('tears down the control master on close', async () => {
    const { spawnFn, calls } = createFakeSpawn();
    const transport = new SshTransport('atlas', 'atlas', {
      ...ARGV_OPTIONS,
      spawnFn,
    });
    await transport.close();
    expect(calls[0].command).toBe('ssh');
    expect(calls[0].args).toEqual([
      '-o',
      'ControlPath=/tmp/grove-ssh/%C',
      '-O',
      'exit',
      '--',
      'atlas',
    ]);
  });

  it('swallows a close failure, because the socket may already be gone', async () => {
    const { spawnFn } = createFakeSpawn({
      code: 255,
      stderr: 'no control path',
    });
    const transport = new SshTransport('atlas', 'atlas', {
      ...ARGV_OPTIONS,
      spawnFn,
    });
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
