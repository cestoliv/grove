import type { GroupConfig } from '../config/index.js';
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
  'register_args',
];

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
  unknownKeys: string[];
}

export function rawGitlabOptions(
  raw?: Record<string, unknown>,
): RawGitlabOptions {
  const env: Record<string, string> = {};
  const runArgs: string[] = [];
  const registerArgs: string[] = [];
  const unknownKeys: string[] = [];
  let jobImage: string | undefined;

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
  if (spec.concurrent !== undefined) {
    // concurrent is a global key with no flag and no environment variable.
    // Writing it before register runs lets register merge its own section
    // underneath, which is the only way to set it without an interactive step.
    lines.push(
      `  printf 'concurrent = %s\\n' ${shellQuote(String(spec.concurrent))} > ${config}`,
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
