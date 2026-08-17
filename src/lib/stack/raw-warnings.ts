import { ConfigError } from '../config/errors.js';
import type { ConfigWarning, GroveConfig } from '../config/index.js';
import { RAW_DOCKER_KEYS, rawDockerOptions } from './docker-args.js';
import { RAW_GITLAB_KEYS, rawGitlabOptions } from './gitlab-args.js';
import { RAW_NATIVE_KEYS, rawNativeOptions } from './native-args.js';

// The key whose value made a raw block malformed, read back out of the
// reader's own error message, so a config typo turns into a ConfigError
// instead of an uncaught throw from inside `plan`.
function rawKeyFromError(message: string): string | undefined {
  return /^raw\.([^.\s]+)/.exec(message)?.[1];
}

function listKeys(keys: string[]): string {
  return keys.length < 2
    ? keys.join('')
    : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
}

export function rawStackWarnings(config: GroveConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  for (const [index, group] of config.groups.entries()) {
    if (group.raw === undefined) {
      continue;
    }
    const native = group.stack === 'native';
    const gitlab = config.forges[group.forge]?.kind === 'gitlab';
    const keys = native
      ? RAW_NATIVE_KEYS
      : gitlab
        ? RAW_GITLAB_KEYS
        : RAW_DOCKER_KEYS;
    let unknownKeys: string[];
    try {
      unknownKeys = native
        ? rawNativeOptions(group.raw).unknownKeys
        : gitlab
          ? rawGitlabOptions(group.raw).unknownKeys
          : rawDockerOptions(group.raw).unknownKeys;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = rawKeyFromError(message);
      const path =
        key === undefined
          ? `groups[${index}].raw`
          : `groups[${index}].raw.${key}`;
      throw new ConfigError([{ path, message }]);
    }
    for (const key of unknownKeys) {
      warnings.push({
        code: 'raw-unused',
        path: `groups[${index}].raw.${key}`,
        message: `this stack reads ${listKeys(keys)} from raw, and passes nothing else through. grove proceeds anyway.`,
      });
    }
  }
  return warnings;
}
