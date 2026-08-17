import { posix } from 'node:path';
import type { GroupConfig, HostConfig } from '../config/index.js';
import type { RunnerRegistration } from '../forge/index.js';
import {
  launchdLabel,
  launchdPlistPath,
  resolveCacheRoot,
  resolveInstallRoot,
  resolveWorkRoot,
  runnerDir,
  runnerInstallDir,
  runnerName,
  systemdUnit,
  systemdUnitPath,
} from '../naming.js';
import { expandHome } from '../paths.js';
import {
  type RunnerArch,
  type RunnerOs,
  runnerArch,
  runnerOs,
  runnerTarballUrl,
} from './native-release.js';
import { envMap } from './raw-shared.js';
import { DEFAULT_DRAIN_TIMEOUT_MS } from './types.js';

// launchd hands an agent a minimal PATH, and xcodebuild, git and anything
// Homebrew installed sit outside it. A job that cannot find xcodebuild is the
// first thing a native macOS runner gets wrong, so grove sets this and lets
// raw.env override it.
export const NATIVE_PATH =
  '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';

export const RAW_NATIVE_KEYS = ['env', 'runner_version'];

const TARBALL_FILE = 'actions-runner.tar.gz';

export interface RawNativeOptions {
  env: Record<string, string>;
  runnerVersion?: string;
  unknownKeys: string[];
}

export function rawNativeOptions(
  raw?: Record<string, unknown>,
): RawNativeOptions {
  const env: Record<string, string> = {};
  const unknownKeys: string[] = [];
  let runnerVersion: string | undefined;

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key === 'env') {
      Object.assign(env, envMap(key, value));
      continue;
    }
    if (key === 'runner_version') {
      if (typeof value !== 'string' || value === '') {
        throw new Error('raw.runner_version must be a string');
      }
      runnerVersion = value;
      continue;
    }
    unknownKeys.push(key);
  }

  return {
    env,
    ...(runnerVersion === undefined ? {} : { runnerVersion }),
    unknownKeys,
  };
}

export interface NativeTarget {
  name: string;
  group: string;
  index: number;
  // Passed to config.sh --work. Wiped on create and on `apply --clean`.
  workDir: string;
  // Created on the host, and not handed to the runner in milestone 4. The
  // Docker stack behaves the same way, so a native seat keeps the parity.
  cacheDir: string;
  // The unpacked release, its .credentials, its _diag directory and the two
  // files launchd redirects into. A sibling of the work dir, so a cache wipe
  // never takes the runner binary with it, unless the group names an
  // install_root and moves it off the work root entirely.
  installDir: string;
  // What each supervisor executes. `bin/runsvc.sh` is the entry point the
  // runner's own service templates name: it traps SIGTERM and sends the
  // listener SIGINT, which is the drain grove promises. `run.sh` traps
  // nothing and leaves the listener orphaned.
  serviceScript: string;
  label: string;
  unit: string;
  plistPath: string;
  unitPath: string;
  stdoutPath: string;
  stderrPath: string;
  diagDir: string;
  tarballPath: string;
}

export interface NativeTargetInput {
  group: GroupConfig;
  host: HostConfig;
  index: number;
  // Required, unlike the Docker path, because the plist and the unit file
  // live under it and neither transport expands a tilde inside a quoted path.
  home: string;
}

// What the supervisor and the runner write inside the install dir. Derived in
// one place, so a target rebuilt from a record cannot drift from a fresh one.
function installPaths(
  installDir: string,
): Pick<
  NativeTarget,
  'serviceScript' | 'stdoutPath' | 'stderrPath' | 'diagDir' | 'tarballPath'
> {
  return {
    serviceScript: `${installDir}/bin/runsvc.sh`,
    stdoutPath: `${installDir}/stdout.log`,
    stderrPath: `${installDir}/stderr.log`,
    diagDir: `${installDir}/_diag`,
    tarballPath: `${installDir}/${TARBALL_FILE}`,
  };
}

// What the seat is called to launchd and to systemd, and where each supervisor
// reads it from. All four follow from the name and the home, and from nothing
// the group says.
function unitPaths(
  home: string,
  group: string,
  index: number,
): Pick<NativeTarget, 'label' | 'unit' | 'plistPath' | 'unitPath'> {
  return {
    label: launchdLabel(group, index),
    unit: systemdUnit(group, index),
    plistPath: launchdPlistPath(home, group, index),
    unitPath: systemdUnitPath(home, group, index),
  };
}

export function buildNativeTarget(input: NativeTargetInput): NativeTarget {
  const { group, host, index, home } = input;
  const env = { HOME: home } as NodeJS.ProcessEnv;
  const workRoot = expandHome(resolveWorkRoot(host, group), env);
  const cacheRoot = expandHome(resolveCacheRoot(host, group), env);
  const installRoot = expandHome(resolveInstallRoot(host, group), env);
  const installDir = runnerInstallDir(installRoot, group.name, index);
  return {
    name: runnerName(group.name, index),
    group: group.name,
    index,
    workDir: runnerDir(workRoot, group.name, index),
    cacheDir: runnerDir(cacheRoot, group.name, index),
    installDir,
    ...unitPaths(home, group.name, index),
    ...installPaths(installDir),
  };
}

export interface NativeTargetDirsInput {
  name: string;
  group: string;
  index: number;
  home: string;
  installDir: string;
  workDir: string;
  // Left out by a caller that has no cache dir to hand, and then derived from
  // the default layout. A stop and a remove read neither the cache dir nor the
  // tarball, and every caller that does still knows its group.
  cacheDir?: string;
}

/**
 * The same target, built from the directories a create wrote down rather than
 * from the group it came from. This is what a seat whose group has left the
 * config is taken down by, because the config no longer says where its files
 * are and the record does.
 */
export function nativeTargetFromDirs(
  input: NativeTargetDirsInput,
): NativeTarget {
  const { name, group, index, home, installDir, workDir } = input;
  return {
    name,
    group,
    index,
    workDir,
    cacheDir:
      input.cacheDir ??
      runnerDir(`${posix.dirname(workDir)}-cache`, group, index),
    installDir,
    ...unitPaths(home, group, index),
    ...installPaths(installDir),
  };
}

export interface NativeRunnerSpec extends NativeTarget {
  registrationUrl: string;
  registrationToken: string;
  labels: string[];
  os: RunnerOs;
  arch: RunnerArch;
  version: string;
  downloadUrl: string;
  env: Record<string, string>;
  drainTimeoutMs: number;
  // Carried, not read. Milestone 5 owns stuck detection and work-dir pruning,
  // and it reads both off the seat rather than re-deriving them.
  maxJobDurationMs?: number;
  maxWorkSizeBytes?: number;
}

export interface NativeRunnerSpecInput extends NativeTargetInput {
  registration: RunnerRegistration;
  // What `uname -s` answered on the host.
  platform: string;
  // What `uname -m` answered, used when the group asks for no architecture.
  hostArch?: string;
  // The version the caller resolved, overridden by raw.runner_version.
  version: string;
}

export function buildNativeRunnerSpec(
  input: NativeRunnerSpecInput,
): NativeRunnerSpec {
  const { group, registration } = input;
  const target = buildNativeTarget(input);
  const raw = rawNativeOptions(group.raw);
  const version = raw.runnerVersion ?? input.version;
  const os = runnerOs(input.platform);
  const arch = runnerArch(group.arch ?? input.hostArch);
  return {
    ...target,
    registrationUrl: registration.url,
    registrationToken: registration.token,
    labels: group.labels ?? [],
    os,
    arch,
    version,
    downloadUrl: runnerTarballUrl(version, os, arch),
    env: { PATH: NATIVE_PATH, ...raw.env },
    drainTimeoutMs: group.drain_timeout ?? DEFAULT_DRAIN_TIMEOUT_MS,
    ...(group.max_job_duration === undefined
      ? {}
      : { maxJobDurationMs: group.max_job_duration }),
    ...(group.max_work_size === undefined
      ? {}
      : { maxWorkSizeBytes: group.max_work_size }),
  };
}

export function buildDownloadArgs(spec: NativeRunnerSpec): string[] {
  return ['-fsSL', '-o', spec.tarballPath, spec.downloadUrl];
}

export function buildExtractArgs(spec: NativeRunnerSpec): string[] {
  return ['xzf', spec.tarballPath, '-C', spec.installDir];
}

export function buildConfigArgs(spec: NativeRunnerSpec): string[] {
  const args = [
    '--url',
    spec.registrationUrl,
    '--token',
    spec.registrationToken,
    '--name',
    spec.name,
    '--work',
    spec.workDir,
    '--unattended',
    // Lets a recreated runner take its own name back at the forge.
    '--replace',
    // The runner would otherwise update itself and exit. No launchd plist
    // carries KeepAlive, so grove keeps the version it installed instead.
    '--disableupdate',
  ];
  if (spec.labels.length > 0) {
    args.push('--labels', spec.labels.join(','));
  }
  // Persistent by default, so caches stay warm. No --ephemeral.
  return args;
}
