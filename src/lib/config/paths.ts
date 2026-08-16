import { resolve } from 'node:path';
import { expandHome } from '../paths.js';

export const DEFAULT_CONFIG_FILE = 'grove.yaml';

export interface ConfigPathOptions {
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function resolveConfigPath(options: ConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const candidate = options.explicit ?? env.GROVE_CONFIG ?? DEFAULT_CONFIG_FILE;
  return resolve(cwd, expandHome(candidate, env));
}
