import {
  GROUP_NAME_MAX_LENGTH,
  GROUP_NAME_PATTERN,
  type GroupConfig,
  type HostConfig,
} from './config/index.js';

export const GROVE_PREFIX = 'grove-';

// An absolute path that exists on macOS and Linux and survives a reboot,
// used when neither the host nor the group names a work root. Docker needs
// an absolute path on both sides of the bind mount, so there is no relative
// fallback to be had here.
export const DEFAULT_WORK_ROOT = '/var/tmp/grove';

export interface ManagedName {
  group: string;
  index: number;
}

// Greedy on the group so a group name that ends in a digit keeps that digit
// and the last dash-separated number is always the index.
const MANAGED_NAME = /^grove-(.+)-([1-9][0-9]*)$/;

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

export function runnerName(group: string, index: number): string {
  return `${GROVE_PREFIX}${group}-${index}`;
}

export function containerName(group: string, index: number): string {
  return runnerName(group, index);
}

export function runnerDir(root: string, group: string, index: number): string {
  return `${trimTrailingSlash(root)}/${group}-${index}`;
}

export function parseManagedName(name: string): ManagedName | null {
  const match = MANAGED_NAME.exec(name);
  if (match === null) {
    return null;
  }
  const [, group, index] = match;
  if (group.length > GROUP_NAME_MAX_LENGTH || !GROUP_NAME_PATTERN.test(group)) {
    return null;
  }
  return { group, index: Number(index) };
}

export function isManagedName(name: string): boolean {
  return parseManagedName(name) !== null;
}

export function resolveWorkRoot(host: HostConfig, group: GroupConfig): string {
  return group.work_root ?? host.work_root ?? DEFAULT_WORK_ROOT;
}

export function resolveCacheRoot(host: HostConfig, group: GroupConfig): string {
  return (
    group.cache_root ??
    host.cache_root ??
    `${trimTrailingSlash(resolveWorkRoot(host, group))}-cache`
  );
}
