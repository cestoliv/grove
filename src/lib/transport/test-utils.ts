import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnFn } from './types.js';

export interface FakeSpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  stdin: string;
}

export interface FakeSpawnResult {
  code?: number;
  stdout?: string;
  stderr?: string;
}

export function createFakeSpawn(result: FakeSpawnResult = {}): {
  spawnFn: SpawnFn;
  calls: FakeSpawnCall[];
} {
  const calls: FakeSpawnCall[] = [];

  const spawnFn: SpawnFn = (command, args, options) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: (signal?: string) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;

    const call: FakeSpawnCall = { command, args, options, stdin: '' };
    child.stdin.on('data', (chunk: Buffer | string) => {
      call.stdin += String(chunk);
    });
    calls.push(call);

    setImmediate(() => {
      if (result.stdout !== undefined) {
        child.stdout.write(result.stdout);
      }
      if (result.stderr !== undefined) {
        child.stderr.write(result.stderr);
      }
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => {
        child.emit('close', result.code ?? 0, null);
      });
    });

    return child as unknown as ChildProcess;
  };

  return { spawnFn, calls };
}
