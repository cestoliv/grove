import { describe, expect, it } from 'vitest';
import type { GroupConfig, HostConfig } from '../config/index.js';
import {
  buildBuildArgs,
  buildEntrypointCommand,
  buildImageTag,
  buildRunArgs,
  buildRunnerDirs,
  buildRunnerSpec,
  DEFAULT_GITHUB_RUNNER_IMAGE,
  rawDockerOptions,
} from './docker-args.js';

const host = { type: 'local', work_root: '/Volumes/ci/grove' } as HostConfig;

function group(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    name: 'overload-arm',
    forge: 'gh-overload',
    scope: { level: 'organization', target: 'Overload-coach' },
    placement: { mac: 2 },
    stack: 'docker',
    labels: ['arm64'],
    ...overrides,
  } as GroupConfig;
}

const registration = {
  token: 'AABBCC',
  url: 'https://github.com/Overload-coach',
};

describe('buildRunnerSpec', () => {
  it('derives every path and name from the group and the index', () => {
    const spec = buildRunnerSpec({
      group: group(),
      host,
      index: 1,
      registration,
    });
    expect(spec).toEqual({
      name: 'grove-overload-arm-1',
      group: 'overload-arm',
      index: 1,
      image: DEFAULT_GITHUB_RUNNER_IMAGE,
      workDir: '/Volumes/ci/grove/overload-arm-1',
      cacheDir: '/Volumes/ci/grove-cache/overload-arm-1',
      configDir: '/Volumes/ci/grove/overload-arm-1-config',
      registrationUrl: 'https://github.com/Overload-coach',
      registrationToken: 'AABBCC',
      labels: ['arm64'],
      privileged: false,
      volumes: [],
      env: {},
      extraRunArgs: [],
    });
  });

  it('expands a tilde against the host home', () => {
    const spec = buildRunnerSpec({
      group: group({ work_root: '~/ci/ios' }),
      host,
      index: 3,
      home: '/Users/olivier',
      registration,
    });
    expect(spec.workDir).toBe('/Users/olivier/ci/ios/overload-arm-3');
  });

  it('keeps arch, privileged, volumes and the pull policy', () => {
    const spec = buildRunnerSpec({
      group: group({
        arch: 'arm64',
        privileged: true,
        volumes: ['/cache'],
        pull_policy: 'always',
      }),
      host,
      index: 1,
      registration,
    });
    expect(spec.arch).toBe('arm64');
    expect(spec.privileged).toBe(true);
    expect(spec.volumes).toEqual(['/cache']);
    expect(spec.pullPolicy).toBe('always');
  });

  it('uses an explicit image, or a tag derived from the Dockerfile', () => {
    expect(
      buildRunnerSpec({
        group: group({ image: 'my/runner:1' }),
        host,
        index: 1,
        registration,
      }).image,
    ).toBe('my/runner:1');
    expect(
      buildRunnerSpec({
        group: group({ build: '/srv/runners/Dockerfile' }),
        host,
        index: 1,
        registration,
      }).image,
    ).toBe(buildImageTag('overload-arm', '/srv/runners/Dockerfile'));
  });

  it('carries the raw block into env and extra run args', () => {
    const spec = buildRunnerSpec({
      group: group({
        raw: {
          env: { HTTPS_PROXY: 'http://proxy:3128', RETRIES: 3 },
          docker_run_args: ['--dns', '1.1.1.1'],
          something_else: true,
        },
      }),
      host,
      index: 1,
      registration,
    });
    expect(spec.env).toEqual({
      HTTPS_PROXY: 'http://proxy:3128',
      RETRIES: '3',
    });
    expect(spec.extraRunArgs).toEqual(['--dns', '1.1.1.1']);
  });
});

describe('buildRunnerDirs', () => {
  it('gives the two directories without needing a registration', () => {
    expect(buildRunnerDirs({ group: group(), host, index: 2 })).toEqual({
      name: 'grove-overload-arm-2',
      group: 'overload-arm',
      index: 2,
      workDir: '/Volumes/ci/grove/overload-arm-2',
      cacheDir: '/Volumes/ci/grove-cache/overload-arm-2',
      configDir: '/Volumes/ci/grove/overload-arm-2-config',
    });
  });
});

describe('buildEntrypointCommand', () => {
  it('configures then runs, unattended, replacing its own record', () => {
    const spec = buildRunnerSpec({
      group: group(),
      host,
      index: 1,
      registration,
    });
    expect(buildEntrypointCommand(spec)).toBe(
      "./config.sh --url 'https://github.com/Overload-coach' --token 'AABBCC' " +
        "--name 'grove-overload-arm-1' --work '/Volumes/ci/grove/overload-arm-1' " +
        "--unattended --replace --labels 'arm64' && ./run.sh",
    );
  });

  it('omits --labels when the group declares none', () => {
    const spec = buildRunnerSpec({
      group: group({ labels: undefined }),
      host,
      index: 1,
      registration,
    });
    expect(buildEntrypointCommand(spec)).not.toContain('--labels');
  });

  it('quotes a token that contains a shell metacharacter', () => {
    const spec = buildRunnerSpec({
      group: group(),
      host,
      index: 1,
      registration: { ...registration, token: "a'b;rm -rf /" },
    });
    expect(buildEntrypointCommand(spec)).toContain(
      String.raw`--token 'a'\''b;rm -rf /'`,
    );
  });
});

describe('buildRunArgs', () => {
  it('mounts the work root at the identical path and never restarts', () => {
    const args = buildRunArgs(
      buildRunnerSpec({ group: group(), host, index: 1, registration }),
    );
    expect(args.slice(0, 10)).toEqual([
      'run',
      '--detach',
      '--restart',
      'no',
      '--name',
      'grove-overload-arm-1',
      '--label',
      'grove.group=overload-arm',
      '--label',
      'grove.index=1',
    ]);
    expect(args).toContain(
      '/Volumes/ci/grove/overload-arm-1:/Volumes/ci/grove/overload-arm-1',
    );
    expect(args).toContain(
      '/Volumes/ci/grove-cache/overload-arm-1:/Volumes/ci/grove-cache/overload-arm-1',
    );
    expect(args.at(-4)).toBe(DEFAULT_GITHUB_RUNNER_IMAGE);
    expect(args.at(-3)).toBe('sh');
    expect(args.at(-2)).toBe('-c');
    expect(args.at(-1)).toContain('./config.sh');
  });

  it('adds platform, pull policy, privileged, volumes, env and raw args in order', () => {
    const args = buildRunArgs(
      buildRunnerSpec({
        group: group({
          arch: 'amd64',
          privileged: true,
          pull_policy: 'always',
          volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
          raw: { env: { A: 'b' }, docker_run_args: ['--dns', '1.1.1.1'] },
        }),
        host,
        index: 2,
        registration,
      }),
    );
    const joined = args.join(' ');
    expect(joined).toContain('--platform linux/amd64');
    expect(joined).toContain('--pull always');
    expect(joined).toContain('--privileged');
    expect(joined).toContain(
      '--volume /var/run/docker.sock:/var/run/docker.sock',
    );
    expect(joined).toContain('--env A=b');
    expect(joined).toContain('--dns 1.1.1.1');
    expect(args.indexOf('--dns')).toBeLessThan(
      args.indexOf(DEFAULT_GITHUB_RUNNER_IMAGE),
    );
  });
});

describe('buildImageTag and buildBuildArgs', () => {
  it('derives a stable tag per group and Dockerfile', () => {
    const tag = buildImageTag('overload-arm', '/srv/runners/Dockerfile');
    expect(tag).toMatch(/^grove-overload-arm:[0-9a-f]{12}$/);
    expect(buildImageTag('overload-arm', '/srv/runners/Dockerfile')).toBe(tag);
    expect(buildImageTag('overload-arm', '/srv/other/Dockerfile')).not.toBe(
      tag,
    );
  });

  it('builds from the Dockerfile with its own directory as context', () => {
    expect(
      buildBuildArgs('grove-x:abc', '/srv/runners/Dockerfile', 'arm64'),
    ).toEqual([
      'build',
      '--tag',
      'grove-x:abc',
      '--platform',
      'linux/arm64',
      '--file',
      '/srv/runners/Dockerfile',
      '/srv/runners',
    ]);
    expect(buildBuildArgs('grove-x:abc', '/srv/runners/Dockerfile')).toEqual([
      'build',
      '--tag',
      'grove-x:abc',
      '--file',
      '/srv/runners/Dockerfile',
      '/srv/runners',
    ]);
  });
});

describe('rawDockerOptions', () => {
  it('returns empty results for an absent raw block', () => {
    expect(rawDockerOptions()).toEqual({
      env: {},
      runArgs: [],
      unknownKeys: [],
    });
  });

  it('collects unknown keys instead of failing', () => {
    expect(rawDockerOptions({ config_toml: 'x' }).unknownKeys).toEqual([
      'config_toml',
    ]);
  });

  it('rejects a raw block with the wrong shape', () => {
    expect(() => rawDockerOptions({ docker_run_args: 'nope' })).toThrow(
      /raw.docker_run_args must be a list of strings/,
    );
    expect(() => rawDockerOptions({ env: ['A=b'] })).toThrow(
      /raw.env must be a mapping/,
    );
    expect(() => rawDockerOptions({ env: { A: { deep: true } } })).toThrow(
      /raw.env.A must be a string, number or boolean/,
    );
  });
});
