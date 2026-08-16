import { homedir, platform as osPlatform } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHome } from '../paths.js';

export const STATE_DB_FILE = 'grove.db';

export interface StateDirOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

export function resolveStateDir(options: StateDirOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? osPlatform();
  const home = options.home ?? env.HOME ?? homedir();
  const homeEnv = { HOME: home } as NodeJS.ProcessEnv;

  if (isSet(env.GROVE_STATE_DIR)) {
    return resolve(expandHome(env.GROVE_STATE_DIR.trim(), homeEnv));
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'grove');
  }
  if (isSet(env.XDG_STATE_HOME)) {
    return join(
      resolve(expandHome(env.XDG_STATE_HOME.trim(), homeEnv)),
      'grove',
    );
  }
  return join(home, '.local', 'state', 'grove');
}

export function resolveStateDbPath(options: StateDirOptions = {}): string {
  return join(resolveStateDir(options), STATE_DB_FILE);
}
