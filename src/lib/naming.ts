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

// The description grove gives the one runner entity a GitLab group owns. It
// carries no index, because every seat in the group shares it.
export function sharedRunnerName(group: string): string {
  return `${GROVE_PREFIX}${group}`;
}

const SHARED_NAME = /^grove-(.+)$/;

// `grove-chevro-2` is a seat of group `chevro` and an entity of group
// `chevro-2` at the same time. grove reads it as the seat, and refuses to
// read it as an entity, so one string never means two runners.
export function parseSharedName(name: string): { group: string } | null {
  if (parseManagedName(name) !== null) {
    return null;
  }
  const match = SHARED_NAME.exec(name);
  if (match === null) {
    return null;
  }
  const group = match[1];
  if (group.length > GROUP_NAME_MAX_LENGTH || !GROUP_NAME_PATTERN.test(group)) {
    return null;
  }
  return { group };
}

// config.toml lands here after registration, and it holds the glrt token, so
// this directory is created 0700 and never sits inside the work dir that
// `apply --clean` wipes.
export function runnerConfigDir(
  root: string,
  group: string,
  index: number,
): string {
  return `${runnerDir(root, group, index)}-config`;
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

// The launchd label the spec fixes for a managed runner, and the daemon of
// milestone 5 sits under the same prefix with the fixed suffix "daemon".
export const LAUNCHD_LABEL_PREFIX = 'com.cestoliv.grove.';
export const SYSTEMD_UNIT_SUFFIX = '.service';
export const LAUNCH_AGENTS_DIR = 'Library/LaunchAgents';
export const SYSTEMD_USER_DIR = '.config/systemd/user';

export function launchdLabel(group: string, index: number): string {
  return `${LAUNCHD_LABEL_PREFIX}${group}-${index}`;
}

export function systemdUnit(group: string, index: number): string {
  return `${runnerName(group, index)}${SYSTEMD_UNIT_SUFFIX}`;
}

export function launchdPlistPath(
  home: string,
  group: string,
  index: number,
): string {
  return `${trimTrailingSlash(home)}/${LAUNCH_AGENTS_DIR}/${launchdLabel(group, index)}.plist`;
}

export function systemdUnitPath(
  home: string,
  group: string,
  index: number,
): string {
  return `${trimTrailingSlash(home)}/${SYSTEMD_USER_DIR}/${systemdUnit(group, index)}`;
}

// The unpacked runner release, its credentials and its own logs. A sibling of
// the work dir, so `apply --clean` wipes the caches and leaves the install.
export function runnerInstallDir(
  root: string,
  group: string,
  index: number,
): string {
  return `${runnerDir(root, group, index)}-runner`;
}

// A label or a unit name grove would recognise as one of its seats. Anything
// that does not parse as a managed runner name answers null, which is what
// keeps the daemon and every foreign job out of the observation.
export function runnerNameFromLaunchdLabel(label: string): string | null {
  if (!label.startsWith(LAUNCHD_LABEL_PREFIX)) {
    return null;
  }
  const name = `${GROVE_PREFIX}${label.slice(LAUNCHD_LABEL_PREFIX.length)}`;
  return parseManagedName(name) === null ? null : name;
}

export function runnerNameFromSystemdUnit(unit: string): string | null {
  if (!unit.endsWith(SYSTEMD_UNIT_SUFFIX)) {
    return null;
  }
  const name = unit.slice(0, -SYSTEMD_UNIT_SUFFIX.length);
  return parseManagedName(name) === null ? null : name;
}
