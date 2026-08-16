import { homedir } from 'node:os';
import { join } from 'node:path';

export function expandHome(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME ?? homedir();
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/')) {
    return join(home, value.slice(2));
  }
  return value;
}
