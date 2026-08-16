import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runProcess } from './process.js';
import type { ExecOptions, ExecResult, SpawnFn, Transport } from './types.js';

// ~/.ssh/grove keeps the control socket path short enough for the 104 byte
// AF_UNIX limit on macOS once OpenSSH expands %C to a connection hash.
// A system temp dir does not give that guarantee: on macOS it resolves to a
// long per-user path under /var/folders that can push the socket over the
// limit, which makes ControlMaster silently stop working.
export const SSH_CONTROL_DIR = join(homedir(), '.ssh', 'grove');
export const DEFAULT_CONTROL_PERSIST = '60s';
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SshArgvOptions {
  controlPath: string;
  controlPersist: string;
  connectTimeoutSeconds: number;
}

export interface SshTransportOptions extends Partial<SshArgvOptions> {
  spawnFn?: SpawnFn;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildRemoteCommand(
  command: string,
  args: string[],
  options: ExecOptions = {},
): string {
  const parts: string[] = [];
  if (options.cwd !== undefined) {
    parts.push(`cd ${shellQuote(options.cwd)} &&`);
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`${name} is not a valid environment variable name`);
    }
    parts.push(`${name}=${shellQuote(value)}`);
  }
  parts.push([command, ...args].map(shellQuote).join(' '));
  return parts.join(' ');
}

export function buildSshArgs(
  target: string,
  remoteCommand: string,
  options: SshArgvOptions,
): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${options.connectTimeoutSeconds}`,
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${options.controlPath}`,
    '-o',
    `ControlPersist=${options.controlPersist}`,
    '--',
    target,
    remoteCommand,
  ];
}

export class SshTransport implements Transport {
  readonly name: string;
  private readonly target: string;
  private readonly argv: SshArgvOptions;
  private readonly spawnFn: SpawnFn;
  private controlDirReady?: Promise<unknown>;

  constructor(name: string, target: string, options: SshTransportOptions = {}) {
    this.name = name;
    this.target = target;
    this.argv = {
      controlPath: options.controlPath ?? join(SSH_CONTROL_DIR, '%C'),
      controlPersist: options.controlPersist ?? DEFAULT_CONTROL_PERSIST,
      connectTimeoutSeconds:
        options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS,
    };
    this.spawnFn = options.spawnFn ?? nodeSpawn;
  }

  argsFor(
    command: string,
    args: string[],
    options: ExecOptions = {},
  ): string[] {
    return buildSshArgs(
      this.target,
      buildRemoteCommand(command, args, options),
      this.argv,
    );
  }

  private ensureControlDir(): Promise<unknown> {
    this.controlDirReady ??= mkdir(dirname(this.argv.controlPath), {
      recursive: true,
      mode: 0o700,
    });
    return this.controlDirReady;
  }

  async exec(
    command: string,
    args: string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    await this.ensureControlDir();
    return runProcess(
      this.spawnFn,
      'ssh',
      this.argsFor(command, args, options),
      {
        stdin: options.stdin,
        timeoutMs: options.timeoutMs,
      },
    );
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec('cat', [path]);
    if (result.code !== 0) {
      throw new Error(
        `cannot read ${path} on ${this.name}: ${result.stderr.trim()}`,
      );
    }
    return result.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const result = await this.exec('sh', ['-c', `cat > ${shellQuote(path)}`], {
      stdin: content,
    });
    if (result.code !== 0) {
      throw new Error(
        `cannot write ${path} on ${this.name}: ${result.stderr.trim()}`,
      );
    }
  }

  async close(): Promise<void> {
    // A missing socket is not an error. The connection is gone either way.
    await runProcess(
      this.spawnFn,
      'ssh',
      [
        '-o',
        `ControlPath=${this.argv.controlPath}`,
        '-O',
        'exit',
        '--',
        this.target,
      ],
      {},
    ).catch(() => undefined);
  }
}
