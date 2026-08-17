import type { GroupConfig, GroveConfig } from '../config/index.js';
import { DOCKER_SOCKET_PATH } from '../config/warnings.js';
import { shellQuote } from '../transport/index.js';
import {
  buildImageTag,
  buildRunnerDirs,
  type RunnerDirs,
  type RunnerSpecInput,
} from './docker-args.js';
import { envMap, stringList } from './raw-shared.js';

// GitLab's own image for the runner. It has no registration baked in, so
// grove registers on first start and runs afterwards.
export const DEFAULT_GITLAB_RUNNER_IMAGE = 'gitlab/gitlab-runner:latest';

// The image a job gets when its .gitlab-ci.yml names none. Small on purpose,
// because a job that cares names its own.
export const DEFAULT_GITLAB_JOB_IMAGE = 'alpine:latest';

export const GITLAB_CONFIG_DIR = '/etc/gitlab-runner';
export const GITLAB_CONFIG_FILE = `${GITLAB_CONFIG_DIR}/config.toml`;
export const GITLAB_SYSTEM_ID_FILE = '.runner_system_id';

// The section gitlab-runner writes into config.toml once a registration
// lands. Escaped for grep's basic regexes, where a bracket opens a set.
const REGISTERED_MARKER = String.raw`\[\[runners\]\]`;

export const RAW_GITLAB_KEYS = [
  'docker_run_args',
  'env',
  'job_image',
  'metrics_port',
  'register_args',
];

// The port gitlab-runner listens on inside the container once listen_address
// is set. Fixed, because the host side is what the operator chooses.
export const GITLAB_RUNNER_METRICS_PORT = 9252;

/**
 * The base port a group's seats publish gitlab-runner metrics on, or undefined
 * when they publish none. Only a GitLab Docker group does: a GitHub Actions
 * runner exposes no metrics endpoint at all, and a native seat has no
 * container to publish a port from. One predicate, because the exporter's
 * scrape, `grove doctor`'s port listing and its curl check all have to agree
 * about which seats have a port at all.
 */
export function groupMetricsPort(
  config: GroveConfig,
  group: GroupConfig,
): number | undefined {
  const declared = group.raw?.metrics_port;
  if (
    typeof declared !== 'number' ||
    group.stack !== 'docker' ||
    config.forges[group.forge]?.kind !== 'gitlab'
  ) {
    return undefined;
  }
  return declared;
}

export const MAX_PORT = 65_535;

/**
 * The seats a group asks for, which is what decides how far its metrics ports
 * count up from the base.
 */
export function groupSeatCount(group: GroupConfig): number {
  return Object.values(group.placement).reduce((sum, count) => sum + count, 0);
}

/**
 * Why a base metrics port and a seat count do not fit the port range, or
 * undefined when they do. One predicate, because `rawGitlabOptions` throws on
 * it and `grove doctor`'s `group.metrics-port` reports it, and two checks on
 * one target disagreeing is what an operator stops reading at.
 */
export function metricsPortRangeError(
  base: number,
  seats: number,
): string | undefined {
  if (!Number.isInteger(base) || base < 1 || base > MAX_PORT) {
    return `raw.metrics_port is ${base}, which is not a port number between 1 and ${MAX_PORT}`;
  }
  // Seat n takes base + n - 1, so the last seat is the one that overflows.
  const last = base + Math.max(seats, 1) - 1;
  if (last > MAX_PORT) {
    return `raw.metrics_port ${base} gives the last of ${seats} seats port ${last}, above ${MAX_PORT}`;
  }
  return undefined;
}

// grove speaks always, missing and never. gitlab-runner spells the middle
// one differently, and nothing else differs.
const PULL_POLICIES: Record<'always' | 'missing' | 'never', string> = {
  always: 'always',
  missing: 'if-not-present',
  never: 'never',
};

export function gitlabSystemIdPath(configDir: string): string {
  return `${configDir}/${GITLAB_SYSTEM_ID_FILE}`;
}

export interface RawGitlabOptions {
  env: Record<string, string>;
  runArgs: string[];
  registerArgs: string[];
  jobImage?: string;
  // The host port this group's first seat publishes gitlab-runner's own
  // /metrics on. Seat n takes metricsPort + n - 1.
  metricsPort?: number;
  unknownKeys: string[];
}

export function rawGitlabOptions(
  raw?: Record<string, unknown>,
  seats = 1,
): RawGitlabOptions {
  const env: Record<string, string> = {};
  const runArgs: string[] = [];
  const registerArgs: string[] = [];
  const unknownKeys: string[] = [];
  let jobImage: string | undefined;
  let metricsPort: number | undefined;

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key === 'docker_run_args') {
      runArgs.push(...stringList(key, value));
      continue;
    }
    if (key === 'register_args') {
      registerArgs.push(...stringList(key, value));
      continue;
    }
    if (key === 'job_image') {
      if (typeof value !== 'string' || value === '') {
        throw new Error('raw.job_image must be a string');
      }
      jobImage = value;
      continue;
    }
    if (key === 'metrics_port') {
      if (typeof value !== 'number') {
        throw new Error(
          'raw.metrics_port must be a port number, for example 9252',
        );
      }
      const problem = metricsPortRangeError(value, seats);
      if (problem !== undefined) {
        throw new Error(problem);
      }
      metricsPort = value;
      continue;
    }
    if (key === 'env') {
      Object.assign(env, envMap(key, value));
      continue;
    }
    unknownKeys.push(key);
  }

  return {
    env,
    runArgs,
    registerArgs,
    ...(jobImage === undefined ? {} : { jobImage }),
    ...(metricsPort === undefined ? {} : { metricsPort }),
    unknownKeys,
  };
}

export interface GitlabRunnerSpec extends RunnerDirs {
  // The runner container image.
  image: string;
  // The image a job runs in when it names none.
  jobImage: string;
  registrationUrl: string;
  registrationToken: string;
  // Carried for reporting. The entity already holds them, and register would
  // ignore them on the current flow.
  tags: string[];
  arch?: 'amd64' | 'arm64';
  pullPolicy?: 'always' | 'missing' | 'never';
  // Applies to the job containers the Docker executor starts.
  privileged: boolean;
  dockerVolumes: string[];
  concurrent?: number;
  limit?: number;
  // The host port this seat publishes gitlab-runner's /metrics on. Already
  // offset by the seat's index, so it is the port and not the group's base.
  metricsPort?: number;
  env: Record<string, string>;
  extraRunArgs: string[];
  extraRegisterArgs: string[];
}

function imageFor(group: GroupConfig): string {
  if (group.image !== undefined) {
    return group.image;
  }
  return group.build === undefined
    ? DEFAULT_GITLAB_RUNNER_IMAGE
    : buildImageTag(group.name, group.build);
}

export function buildGitlabRunnerSpec(
  input: RunnerSpecInput,
): GitlabRunnerSpec {
  const { group, registration } = input;
  const dirs = buildRunnerDirs(input);
  // Seat count validation belongs to the config layer, which rejects an
  // overflowing range before a spec is ever built. See `rawStackWarnings`.
  const raw = rawGitlabOptions(group.raw);

  return {
    ...dirs,
    image: imageFor(group),
    jobImage: raw.jobImage ?? DEFAULT_GITLAB_JOB_IMAGE,
    registrationUrl: registration.url,
    registrationToken: registration.token,
    tags: group.tags ?? [],
    ...(group.arch === undefined ? {} : { arch: group.arch }),
    ...(group.pull_policy === undefined
      ? {}
      : { pullPolicy: group.pull_policy }),
    privileged: group.privileged === true,
    // Path parity reaches the job container too, so a job that writes to the
    // work dir writes to the same host path the runner mounted.
    dockerVolumes: [
      `${dirs.workDir}:${dirs.workDir}`,
      `${dirs.cacheDir}:${dirs.cacheDir}`,
      ...(group.volumes ?? []),
    ],
    ...(group.concurrent === undefined ? {} : { concurrent: group.concurrent }),
    ...(group.limit === undefined ? {} : { limit: group.limit }),
    // Seat n takes the group's base port plus n - 1, so a group of three
    // starting at 9252 takes 9252, 9253 and 9254 wherever its seats are
    // placed. Doctor warns when two groups on one host overlap.
    ...(raw.metricsPort === undefined
      ? {}
      : { metricsPort: raw.metricsPort + input.index - 1 }),
    env: raw.env,
    extraRunArgs: raw.runArgs,
    extraRegisterArgs: raw.registerArgs,
  };
}

export function buildGitlabEntrypointCommand(spec: GitlabRunnerSpec): string {
  const register = [
    'gitlab-runner',
    'register',
    '--non-interactive',
    '--url',
    shellQuote(spec.registrationUrl),
    '--token',
    shellQuote(spec.registrationToken),
    '--name',
    shellQuote(spec.name),
    '--executor',
    'docker',
    '--docker-image',
    shellQuote(spec.jobImage),
    '--builds-dir',
    shellQuote(spec.workDir),
    '--cache-dir',
    shellQuote(spec.cacheDir),
  ];
  if (spec.privileged) {
    // A boolean flag gitlab-runner only reads with an explicit value.
    register.push('--docker-privileged=true');
  }
  for (const volume of spec.dockerVolumes) {
    register.push('--docker-volumes', shellQuote(volume));
  }
  if (spec.pullPolicy !== undefined) {
    register.push('--docker-pull-policy', PULL_POLICIES[spec.pullPolicy]);
  }
  if (spec.limit !== undefined) {
    register.push('--limit', String(spec.limit));
  }
  register.push(...spec.extraRegisterArgs.map(shellQuote));

  const config = shellQuote(GITLAB_CONFIG_FILE);
  // A failed register can leave a config.toml behind with no [[runners]]
  // section in it. Looking for the section rather than for a non-empty file
  // keeps that half written config from wedging the runner unregistered.
  const guard = `if ! grep -q ${shellQuote(REGISTERED_MARKER)} ${config} 2>/dev/null; then`;
  const lines = ['set -e', guard];
  // Global keys have no flag and no environment variable, so they are written
  // before register runs and register merges its own section underneath. One
  // write, because a second redirection would truncate the first.
  const globals: string[] = [];
  if (spec.concurrent !== undefined) {
    globals.push(`concurrent = ${spec.concurrent}`);
  }
  if (spec.metricsPort !== undefined) {
    globals.push(`listen_address = ":${GITLAB_RUNNER_METRICS_PORT}"`);
  }
  if (globals.length > 0) {
    lines.push(
      `  printf '%s\\n' ${globals.map(shellQuote).join(' ')} > ${config}`,
    );
  }
  // Removing what register wrote is what makes the next start retry instead
  // of running a runner that registered with nobody.
  lines.push(`  ${register.join(' ')} || { rm -f ${config}; exit 1; }`);
  lines.push('fi');
  // The guard above is what keeps a restart from appending a second
  // [[runners]] section every time the container comes back.
  lines.push(
    'exec gitlab-runner run --user=gitlab-runner --working-directory=/home/gitlab-runner',
  );
  return lines.join('\n');
}

export function buildGitlabRunArgs(spec: GitlabRunnerSpec): string[] {
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
  if (spec.metricsPort !== undefined) {
    // Loopback on the host, never 0.0.0.0. grove scrapes it over the same
    // transport every tick uses, so the port never has to leave the machine.
    args.push(
      '--publish',
      `127.0.0.1:${spec.metricsPort}:${GITLAB_RUNNER_METRICS_PORT}`,
    );
  }
  if (spec.arch !== undefined) {
    args.push('--platform', `linux/${spec.arch}`);
  }
  if (spec.pullPolicy !== undefined) {
    args.push('--pull', spec.pullPolicy);
  }
  args.push('--volume', `${spec.workDir}:${spec.workDir}`);
  args.push('--volume', `${spec.cacheDir}:${spec.cacheDir}`);
  // config.toml and .runner_system_id live here, on the host, so a restart
  // reuses the registration and grove can read the system id back.
  args.push('--volume', `${spec.configDir}:${GITLAB_CONFIG_DIR}`);
  // The Docker executor starts every job as a sibling container, so the
  // runner needs a daemon to talk to. Without this it registers and then
  // fails every job.
  args.push('--volume', `${DOCKER_SOCKET_PATH}:${DOCKER_SOCKET_PATH}`);
  for (const [name, value] of Object.entries(spec.env)) {
    args.push('--env', `${name}=${value}`);
  }
  args.push(...spec.extraRunArgs);
  // sh rather than the image's own entrypoint, because a group with build:
  // points at an image grove did not write.
  args.push('--entrypoint', 'sh');
  args.push(spec.image, '-c', buildGitlabEntrypointCommand(spec));
  return args;
}
