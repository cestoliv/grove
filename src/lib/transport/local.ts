import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { expandHome } from '../paths.js';
import { runProcess } from './process.js';
import type { ExecOptions, ExecResult, SpawnFn, Transport } from './types.js';

export class LocalTransport implements Transport {
  readonly name: string;
  private readonly spawnFn: SpawnFn;

  constructor(name = 'local', spawnFn: SpawnFn = nodeSpawn) {
    this.name = name;
    this.spawnFn = spawnFn;
  }

  async exec(
    command: string,
    args: string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    return runProcess(this.spawnFn, command, args, options);
  }

  async readFile(path: string): Promise<string> {
    return readFile(expandHome(path), 'utf8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeFile(expandHome(path), content, 'utf8');
  }

  async close(): Promise<void> {
    // The control node needs no teardown. SshTransport is where close matters.
  }
}
