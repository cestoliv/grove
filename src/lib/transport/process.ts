import type { ExecOptions, ExecResult, SpawnFn } from './types.js';

export const TIMEOUT_EXIT_CODE = 124;

export function runProcess(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd,
      env:
        options.env === undefined
          ? process.env
          : { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(error);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      finish({ code: code ?? (signal === null ? 1 : 128), stdout, stderr });
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({
          code: TIMEOUT_EXIT_CODE,
          stdout,
          stderr: `${stderr}timed out after ${options.timeoutMs}ms`,
        });
      }, options.timeoutMs);
      timer.unref();
    }

    child.stdin?.end(options.stdin ?? '');
  });
}
