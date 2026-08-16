import { describe, expect, it } from 'vitest';
import type { GroupConfig, HostConfig } from '../config/index.js';
import {
  buildGitlabEntrypointCommand,
  buildGitlabRunArgs,
  buildGitlabRunnerSpec,
  DEFAULT_GITLAB_JOB_IMAGE,
  DEFAULT_GITLAB_RUNNER_IMAGE,
  gitlabSystemIdPath,
  rawGitlabOptions,
} from './gitlab-args.js';

const host = {
  type: 'ssh',
  host: 'atlas',
  work_root: '/PROD/local/grove',
} as HostConfig;

const registration = {
  token: ['glrt', 'K1l2M3n4O5p6Q7r8S9t0'].join('-'),
  url: 'https://git.chevro.fr',
  runnerId: '48',
};

function group(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    name: 'chevro-dind',
    forge: 'gl-chevro',
    scope: { level: 'instance' },
    placement: { atlas: 3 },
    stack: 'docker',
    tags: ['docker', 'dind'],
    ...overrides,
  } as GroupConfig;
}

describe('buildGitlabRunnerSpec', () => {
  it('derives every path, the runner image and the job image', () => {
    const spec = buildGitlabRunnerSpec({
      group: group(),
      host,
      index: 2,
      registration,
    });
    expect(spec).toEqual({
      name: 'grove-chevro-dind-2',
      group: 'chevro-dind',
      index: 2,
      workDir: '/PROD/local/grove/chevro-dind-2',
      cacheDir: '/PROD/local/grove-cache/chevro-dind-2',
      configDir: '/PROD/local/grove/chevro-dind-2-config',
      image: DEFAULT_GITLAB_RUNNER_IMAGE,
      jobImage: DEFAULT_GITLAB_JOB_IMAGE,
      registrationUrl: 'https://git.chevro.fr',
      registrationToken: registration.token,
      tags: ['docker', 'dind'],
      privileged: false,
      dockerVolumes: [
        '/PROD/local/grove/chevro-dind-2:/PROD/local/grove/chevro-dind-2',
        '/PROD/local/grove-cache/chevro-dind-2:/PROD/local/grove-cache/chevro-dind-2',
      ],
      env: {},
      extraRunArgs: [],
      extraRegisterArgs: [],
    });
  });

  it('gives the executor the volumes the group declared, after the two parity mounts', () => {
    const spec = buildGitlabRunnerSpec({
      group: group({
        privileged: true,
        volumes: ['/cache', '/var/run/docker.sock:/var/run/docker.sock'],
        concurrent: 4,
        limit: 2,
        arch: 'amd64',
        pull_policy: 'missing',
      }),
      host,
      index: 1,
      registration,
    });
    expect(spec.privileged).toBe(true);
    expect(spec.concurrent).toBe(4);
    expect(spec.limit).toBe(2);
    expect(spec.arch).toBe('amd64');
    expect(spec.pullPolicy).toBe('missing');
    expect(spec.dockerVolumes.slice(2)).toEqual([
      '/cache',
      '/var/run/docker.sock:/var/run/docker.sock',
    ]);
  });

  it('tags the image it builds when the group names a Dockerfile', () => {
    const spec = buildGitlabRunnerSpec({
      group: group({ build: './runners/gitlab.Dockerfile' }),
      host,
      index: 1,
      registration,
    });
    expect(spec.image).toMatch(/^grove-chevro-dind:[0-9a-f]{12}$/);
  });
});

describe('rawGitlabOptions', () => {
  it('reads the four keys the GitLab stack understands', () => {
    const options = rawGitlabOptions({
      docker_run_args: ['--dns', '1.1.1.1'],
      env: { HTTPS_PROXY: 'http://proxy:3128' },
      job_image: 'node:22',
      register_args: ['--docker-network-mode', 'host'],
    });
    expect(options).toEqual({
      runArgs: ['--dns', '1.1.1.1'],
      env: { HTTPS_PROXY: 'http://proxy:3128' },
      jobImage: 'node:22',
      registerArgs: ['--docker-network-mode', 'host'],
      unknownKeys: [],
    });
  });

  it('reports a key it does not read rather than dropping it silently', () => {
    expect(rawGitlabOptions({ launchd_plist: {} }).unknownKeys).toEqual([
      'launchd_plist',
    ]);
  });

  it('refuses a register_args that is not a list of strings', () => {
    expect(() => rawGitlabOptions({ register_args: 'nope' })).toThrow(
      'raw.register_args must be a list of strings',
    );
  });

  it('refuses a job_image that is not a string', () => {
    expect(() => rawGitlabOptions({ job_image: 3 })).toThrow(
      'raw.job_image must be a string',
    );
  });
});

describe('buildGitlabEntrypointCommand', () => {
  it('registers once, then runs, and never registers twice', () => {
    const spec = buildGitlabRunnerSpec({
      group: group(),
      host,
      index: 1,
      registration,
    });
    expect(buildGitlabEntrypointCommand(spec)).toBe(
      [
        'set -e',
        "if ! grep -q '\\[\\[runners\\]\\]' '/etc/gitlab-runner/config.toml' 2>/dev/null; then",
        "  gitlab-runner register --non-interactive --url 'https://git.chevro.fr'" +
          ` --token '${registration.token}' --name 'grove-chevro-dind-1'` +
          " --executor docker --docker-image 'alpine:latest'" +
          " --builds-dir '/PROD/local/grove/chevro-dind-1'" +
          " --cache-dir '/PROD/local/grove-cache/chevro-dind-1'" +
          " --docker-volumes '/PROD/local/grove/chevro-dind-1:/PROD/local/grove/chevro-dind-1'" +
          " --docker-volumes '/PROD/local/grove-cache/chevro-dind-1:/PROD/local/grove-cache/chevro-dind-1'" +
          " || { rm -f '/etc/gitlab-runner/config.toml'; exit 1; }",
        'fi',
        'exec gitlab-runner run --user=gitlab-runner --working-directory=/home/gitlab-runner',
      ].join('\n'),
    );
  });

  it('writes the global concurrent value before register merges its section', () => {
    const spec = buildGitlabRunnerSpec({
      group: group({ concurrent: 4 }),
      host,
      index: 1,
      registration,
    });
    const lines = buildGitlabEntrypointCommand(spec).split('\n');
    expect(lines[2]).toBe(
      "  printf 'concurrent = %s\\n' '4' > '/etc/gitlab-runner/config.toml'",
    );
    expect(lines[3]).toContain('gitlab-runner register');
  });

  it('passes privileged, the pull policy and the limit to register', () => {
    const spec = buildGitlabRunnerSpec({
      group: group({ privileged: true, pull_policy: 'missing', limit: 2 }),
      host,
      index: 1,
      registration,
    });
    const script = buildGitlabEntrypointCommand(spec);
    // gitlab-runner only reads this boolean with an explicit value.
    expect(script).toContain('--docker-privileged=true');
    expect(script).toContain('--docker-pull-policy if-not-present');
    expect(script).toContain('--limit 2');
  });

  it('leaves nothing behind when register fails, so the next start retries', () => {
    const spec = buildGitlabRunnerSpec({
      group: group(),
      host,
      index: 1,
      registration,
    });
    const script = buildGitlabEntrypointCommand(spec);
    // A half written config.toml would satisfy an "is the file empty" guard
    // and wedge the runner unregistered forever, so the guard looks for a
    // registered runner and a failed register removes what it wrote.
    expect(script).toContain(
      "if ! grep -q '\\[\\[runners\\]\\]' '/etc/gitlab-runner/config.toml' 2>/dev/null; then",
    );
    expect(script).toContain(
      "|| { rm -f '/etc/gitlab-runner/config.toml'; exit 1; }",
    );
  });

  it('gives register the job image the raw block names', () => {
    const spec = buildGitlabRunnerSpec({
      group: group({ raw: { job_image: 'node:22' } }),
      host,
      index: 1,
      registration,
    });
    expect(buildGitlabEntrypointCommand(spec)).toContain(
      "--docker-image 'node:22'",
    );
  });

  it('never passes tags, because the entity already carries them', () => {
    const spec = buildGitlabRunnerSpec({
      group: group(),
      host,
      index: 1,
      registration,
    });
    expect(buildGitlabEntrypointCommand(spec)).not.toContain('--tag-list');
  });

  it('appends raw register args last, so they win', () => {
    const spec = buildGitlabRunnerSpec({
      group: group({
        raw: { register_args: ['--docker-network-mode', 'host'] },
      }),
      host,
      index: 1,
      registration,
    });
    const script = buildGitlabEntrypointCommand(spec);
    expect(script).toContain("'--docker-network-mode' 'host'");
  });
});

describe('buildGitlabRunArgs', () => {
  it('mounts the work, cache and config directories and the host socket', () => {
    const spec = buildGitlabRunnerSpec({
      group: group({ arch: 'amd64', pull_policy: 'always' }),
      host,
      index: 3,
      registration,
    });
    const args = buildGitlabRunArgs(spec);

    expect(args.slice(0, 10)).toEqual([
      'run',
      '--detach',
      '--restart',
      'no',
      '--name',
      'grove-chevro-dind-3',
      '--label',
      'grove.group=chevro-dind',
      '--label',
      'grove.index=3',
    ]);
    expect(args).toContain('--platform');
    expect(args).toContain('linux/amd64');
    expect(args.join(' ')).toContain(
      '--volume /PROD/local/grove/chevro-dind-3:/PROD/local/grove/chevro-dind-3',
    );
    expect(args.join(' ')).toContain(
      '--volume /PROD/local/grove/chevro-dind-3-config:/etc/gitlab-runner',
    );
    expect(args.join(' ')).toContain(
      '--volume /var/run/docker.sock:/var/run/docker.sock',
    );
    expect(args.slice(-5, -3)).toEqual(['--entrypoint', 'sh']);
    expect(args.at(-3)).toBe(DEFAULT_GITLAB_RUNNER_IMAGE);
    expect(args.at(-2)).toBe('-c');
    expect(args.at(-1)).toBe(buildGitlabEntrypointCommand(spec));
  });

  it('never runs the runner container privileged, only the jobs', () => {
    const spec = buildGitlabRunnerSpec({
      group: group({ privileged: true }),
      host,
      index: 1,
      registration,
    });
    expect(buildGitlabRunArgs(spec)).not.toContain('--privileged');
  });

  it('adds raw env and raw run args before the image', () => {
    const spec = buildGitlabRunnerSpec({
      group: group({
        raw: {
          env: { HTTPS_PROXY: 'http://proxy:3128' },
          docker_run_args: ['--dns', '1.1.1.1'],
        },
      }),
      host,
      index: 1,
      registration,
    });
    const args = buildGitlabRunArgs(spec);
    expect(args.join(' ')).toContain('--env HTTPS_PROXY=http://proxy:3128');
    expect(args.join(' ')).toContain('--dns 1.1.1.1');
  });
});

describe('gitlabSystemIdPath', () => {
  it('sits beside config.toml, where gitlab-runner writes it', () => {
    expect(gitlabSystemIdPath('/PROD/local/grove/chevro-dind-1-config')).toBe(
      '/PROD/local/grove/chevro-dind-1-config/.runner_system_id',
    );
  });
});
