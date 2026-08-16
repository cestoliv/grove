import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Transport {
  readonly name: string;
  exec(
    command: string,
    args: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  close(): Promise<void>;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RecordedCall {
  command: string;
  args: string[];
  options?: ExecOptions;
}
