import { spawn as nodeSpawn } from 'node:child_process';
import { resolveConfigPath } from '../lib/config/index.js';
import type { SpawnFn } from '../lib/transport/index.js';

export interface ConfigCommandOptions {
  config?: string;
  path?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  spawnFn?: SpawnFn;
  stdout?: (line: string) => void;
}

export async function runConfig(
  options: ConfigCommandOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.stdout ?? ((line: string) => console.log(line));
  const configPath = resolveConfigPath({
    explicit: options.config,
    env,
    cwd: options.cwd,
  });

  if (options.path === true) {
    write(configPath);
    return 0;
  }

  const editor =
    [env.VISUAL, env.EDITOR].find((value) => value?.trim()) ?? 'nano';
  const [bin, ...flags] = editor.trim().split(/\s+/);
  write(`Config: ${configPath}`);

  const spawnFn = options.spawnFn ?? nodeSpawn;
  return new Promise<number>((resolve, reject) => {
    const child = spawnFn(bin, [...flags, configPath], { stdio: 'inherit' });
    child.on('error', (error: Error) => {
      reject(new Error(`cannot open ${editor}: ${error.message}`));
    });
    child.on('close', (code: number | null) => {
      resolve(code ?? 0);
    });
  });
}
