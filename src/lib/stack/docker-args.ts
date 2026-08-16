import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { ConfigError } from '../config/errors.js';
import type {
  ConfigWarning,
  GroupConfig,
  GroveConfig,
  HostConfig,
} from '../config/index.js';
import type { RunnerRegistration } from '../forge/index.js';
import {
  resolveCacheRoot,
  resolveWorkRoot,
  runnerDir,
  runnerName,
} from '../naming.js';
import { expandHome } from '../paths.js';
import { shellQuote } from '../transport/index.js';

// GitHub's own image for self-hosted Actions runners. Multi-architecture, no
// ENTRYPOINT, and config.sh and run.sh sit in the working directory.
export const DEFAULT_GITHUB_RUNNER_IMAGE =
  'ghcr.io/actions/actions-runner:latest';

export const RAW_DOCKER_KEYS = ['docker_run_args', 'env'];

export interface RunnerSpec {
  name: string;
  group: string;
  index: number;
  image: string;
  // The same string on both sides of the bind mount. The host Docker daemon
  // resolves every path a job builds against the host, never the container.
  workDir: string;
  cacheDir: string;
  registrationUrl: string;
  registrationToken: string;
  labels: string[];
  arch?: 'amd64' | 'arm64';
  pullPolicy?: 'always' | 'missing' | 'never';
  privileged: boolean;
  volumes: string[];
  env: Record<string, string>;
  extraRunArgs: string[];
}

export type RunnerDirs = Pick<
  RunnerSpec,
  'name' | 'group' | 'index' | 'workDir' | 'cacheDir'
>;

export interface RunnerSpecInput {
  group: GroupConfig;
  host: HostConfig;
  index: number;
  registration: RunnerRegistration;
  home?: string;
}

export interface RawDockerOptions {
  env: Record<string, string>;
  runArgs: string[];
  unknownKeys: string[];
}

export function rawDockerOptions(
  raw?: Record<string, unknown>,
): RawDockerOptions {
  const env: Record<string, string> = {};
  const runArgs: string[] = [];
  const unknownKeys: string[] = [];

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key === 'docker_run_args') {
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string')
      ) {
        throw new Error('raw.docker_run_args must be a list of strings');
      }
      runArgs.push(...(value as string[]));
      continue;
    }
    if (key === 'env') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('raw.env must be a mapping of names to values');
      }
      for (const [name, entry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (
          typeof entry !== 'string' &&
          typeof entry !== 'number' &&
          typeof entry !== 'boolean'
        ) {
          throw new Error(
            `raw.env.${name} must be a string, number or boolean`,
          );
        }
        env[name] = String(entry);
      }
      continue;
    }
    unknownKeys.push(key);
  }

  return { env, runArgs, unknownKeys };
}

// The key whose value made a raw block malformed, read back out of
// rawDockerOptions' own error message, so a config typo turns into a
// ConfigError instead of an uncaught throw from inside `plan`.
function rawKeyFromError(message: string): string | undefined {
  return /^raw\.([^.\s]+)/.exec(message)?.[1];
}

export function rawDockerWarnings(config: GroveConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  for (const [index, group] of config.groups.entries()) {
    if (group.stack !== 'docker' || group.raw === undefined) {
      continue;
    }
    let options: RawDockerOptions;
    try {
      options = rawDockerOptions(group.raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = rawKeyFromError(message);
      const path =
        key === undefined
          ? `groups[${index}].raw`
          : `groups[${index}].raw.${key}`;
      throw new ConfigError([{ path, message }]);
    }
    for (const key of options.unknownKeys) {
      warnings.push({
        code: 'raw-unused',
        path: `groups[${index}].raw.${key}`,
        message: `the Docker stack reads ${RAW_DOCKER_KEYS.join(' and ')} from raw, and passes nothing else through. grove proceeds anyway.`,
      });
    }
  }
  return warnings;
}

// Stable per group and Dockerfile path. A Dockerfile that changes in place
// keeps its tag, and `docker build` reuses its own layer cache, so `apply`
// rebuilds cheaply on every create.
export function buildImageTag(group: string, dockerfile: string): string {
  const digest = createHash('sha256').update(dockerfile).digest('hex');
  return `grove-${group}:${digest.slice(0, 12)}`;
}

export function buildBuildArgs(
  tag: string,
  dockerfile: string,
  arch?: string,
): string[] {
  return [
    'build',
    '--tag',
    tag,
    ...(arch === undefined ? [] : ['--platform', `linux/${arch}`]),
    '--file',
    dockerfile,
    posix.dirname(dockerfile),
  ];
}

// Everything about where a runner keeps its files, with no forge call
// involved, so a restart can prepare directories without minting a token.
export function buildRunnerDirs(
  input: Omit<RunnerSpecInput, 'registration'>,
): RunnerDirs {
  const { group, host, index } = input;
  const env =
    input.home === undefined
      ? undefined
      : ({ HOME: input.home } as NodeJS.ProcessEnv);
  const workRoot = expandHome(resolveWorkRoot(host, group), env);
  const cacheRoot = expandHome(resolveCacheRoot(host, group), env);
  return {
    name: runnerName(group.name, index),
    group: group.name,
    index,
    workDir: runnerDir(workRoot, group.name, index),
    cacheDir: runnerDir(cacheRoot, group.name, index),
  };
}

export function buildRunnerSpec(input: RunnerSpecInput): RunnerSpec {
  const { group, registration } = input;
  const dirs = buildRunnerDirs(input);
  const raw = rawDockerOptions(group.raw);

  const image =
    group.image ??
    (group.build === undefined
      ? DEFAULT_GITHUB_RUNNER_IMAGE
      : buildImageTag(group.name, group.build));

  return {
    ...dirs,
    image,
    registrationUrl: registration.url,
    registrationToken: registration.token,
    labels: group.labels ?? [],
    ...(group.arch === undefined ? {} : { arch: group.arch }),
    ...(group.pull_policy === undefined
      ? {}
      : { pullPolicy: group.pull_policy }),
    privileged: group.privileged === true,
    volumes: group.volumes ?? [],
    env: raw.env,
    extraRunArgs: raw.runArgs,
  };
}

export function buildEntrypointCommand(spec: RunnerSpec): string {
  const parts = [
    './config.sh',
    '--url',
    shellQuote(spec.registrationUrl),
    '--token',
    shellQuote(spec.registrationToken),
    '--name',
    shellQuote(spec.name),
    '--work',
    shellQuote(spec.workDir),
    '--unattended',
    // Lets a recreated runner take its own name back at the forge.
    '--replace',
  ];
  if (spec.labels.length > 0) {
    parts.push('--labels', shellQuote(spec.labels.join(',')));
  }
  // Persistent by default, so caches stay warm. No --ephemeral.
  return `${parts.join(' ')} && ./run.sh`;
}

export function buildRunArgs(spec: RunnerSpec): string[] {
  const args = [
    'run',
    '--detach',
    // grove owns crash recovery. Nothing resurrects a runner behind its back.
    '--restart',
    'no',
    '--name',
    spec.name,
    '--label',
    `grove.group=${spec.group}`,
    '--label',
    `grove.index=${spec.index}`,
  ];
  if (spec.arch !== undefined) {
    args.push('--platform', `linux/${spec.arch}`);
  }
  if (spec.pullPolicy !== undefined) {
    args.push('--pull', spec.pullPolicy);
  }
  if (spec.privileged) {
    args.push('--privileged');
  }
  args.push('--volume', `${spec.workDir}:${spec.workDir}`);
  args.push('--volume', `${spec.cacheDir}:${spec.cacheDir}`);
  for (const volume of spec.volumes) {
    args.push('--volume', volume);
  }
  for (const [name, value] of Object.entries(spec.env)) {
    args.push('--env', `${name}=${value}`);
  }
  args.push(...spec.extraRunArgs);
  args.push(spec.image, 'sh', '-c', buildEntrypointCommand(spec));
  return args;
}
