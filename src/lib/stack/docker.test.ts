import { describe, expect, it } from 'vitest';
import type { GroupConfig, HostConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import { DockerStack } from './docker.js';
import { buildRunnerSpec, type RunnerSpec } from './docker-args.js';
import { buildGitlabRunnerSpec, type GitlabRunnerSpec } from './gitlab-args.js';

const host = { type: 'local', work_root: '/Volumes/ci/grove' } as HostConfig;
const group = {
  name: 'overload-arm',
  stack: 'docker',
  labels: ['arm64'],
} as GroupConfig;

function spec(): RunnerSpec {
  return buildRunnerSpec({
    group,
    host,
    index: 1,
    registration: { token: 'AABBCC', url: 'https://github.com/Overload-coach' },
  });
}

function stack(transport: FakeTransport): DockerStack {
  return new DockerStack({ transport, host: 'mac' });
}

describe('DockerStack.listContainers', () => {
  it('lists grove containers', async () => {
    const transport = new FakeTransport('mac').on('docker ps', {
      stdout: `${JSON.stringify({
        ID: 'abc',
        Names: 'grove-overload-arm-1',
        State: 'running',
        Image: 'x',
        Status: 'Up 1 hour',
        CreatedAt: 'now',
      })}\n`,
    });
    const containers = await stack(transport).listContainers();
    expect(containers.map((container) => container.name)).toEqual([
      'grove-overload-arm-1',
    ]);
    expect(transport.commandLines()[0]).toBe(
      'docker ps -a --no-trunc --filter name=^grove- --format {{json .}}',
    );
  });

  it('names the host when docker is not there', async () => {
    const transport = new FakeTransport('atlas').fail(
      'docker ps',
      'docker: command not found\n',
      127,
    );
    await expect(stack(transport).listContainers()).rejects.toThrow(
      /mac: docker ps failed: docker: command not found/,
    );
  });
});

describe('DockerStack.prepareDirs', () => {
  it('wipes and recreates the work dir when asked', async () => {
    const transport = new FakeTransport('mac');
    await stack(transport).prepareDirs(spec(), { wipe: true });
    expect(transport.commandLines()[0]).toBe(
      "sh -c rm -rf '/Volumes/ci/grove/overload-arm-1' && " +
        "mkdir -p '/Volumes/ci/grove/overload-arm-1' '/Volumes/ci/grove-cache/overload-arm-1' && " +
        "chmod 0777 '/Volumes/ci/grove/overload-arm-1' '/Volumes/ci/grove-cache/overload-arm-1'",
    );
  });

  it('keeps the work dir on a restart', async () => {
    const transport = new FakeTransport('mac');
    await stack(transport).prepareDirs(spec(), { wipe: false });
    expect(transport.commandLines()[0]).not.toContain('rm -rf');
    expect(transport.commandLines()[0]).toContain('mkdir -p');
  });

  it('refuses to wipe a directory that is not a runner directory', async () => {
    const transport = new FakeTransport('mac');
    const bad = { ...spec(), workDir: '/' };
    await expect(
      stack(transport).prepareDirs(bad, { wipe: true }),
    ).rejects.toThrow(/refusing to wipe/);
    expect(transport.calls).toEqual([]);
  });
});

describe('DockerStack.create', () => {
  it('runs the container and returns its id', async () => {
    const transport = new FakeTransport('mac').on('docker run', {
      stdout: 'c0ffee\n',
    });
    const id = await stack(transport).create(spec());
    expect(id).toBe('c0ffee');
    const line = transport.commandLines()[0];
    expect(line).toContain('--name grove-overload-arm-1');
    expect(line).toContain('--restart no');
  });

  it('names the container when the name is taken', async () => {
    const transport = new FakeTransport('mac').fail(
      'docker run',
      'docker: Error response from daemon: Conflict. The container name "/grove-overload-arm-1" is already in use\n',
    );
    await expect(stack(transport).create(spec())).rejects.toThrow(
      /grove-overload-arm-1.*already in use/,
    );
  });
});

describe('DockerStack.build', () => {
  it('builds the tag from the Dockerfile', async () => {
    const transport = new FakeTransport('mac');
    await stack(transport).build(
      'grove-x:abc',
      '/srv/runners/Dockerfile',
      'arm64',
    );
    expect(transport.commandLines()[0]).toBe(
      'docker build --tag grove-x:abc --platform linux/arm64 --file /srv/runners/Dockerfile /srv/runners',
    );
  });
});

describe('DockerStack start, stop and remove', () => {
  it('starts by name', async () => {
    const transport = new FakeTransport('mac');
    await stack(transport).start('grove-overload-arm-1');
    expect(transport.commandLines()[0]).toBe(
      'docker start grove-overload-arm-1',
    );
  });

  it('stops with the drain timeout in seconds', async () => {
    const transport = new FakeTransport('mac');
    await stack(transport).stop('grove-overload-arm-1', 90_000);
    expect(transport.commandLines()[0]).toBe(
      'docker stop -t 90 grove-overload-arm-1',
    );
  });

  it('keeps a sub-second drain at one second rather than a force kill', async () => {
    const transport = new FakeTransport('mac');
    const stack = new DockerStack({ transport, host: 'mac' });
    await stack.stop('grove-overload-arm-1', 400);
    expect(transport.commandLines()).toEqual([
      'docker stop -t 1 grove-overload-arm-1',
    ]);
  });

  it('stops immediately when the drain timeout is zero', async () => {
    const transport = new FakeTransport('mac');
    await stack(transport).stop('grove-overload-arm-1', 0);
    expect(transport.commandLines()[0]).toBe(
      'docker stop -t 0 grove-overload-arm-1',
    );
  });

  it('removes with force so a running container still goes', async () => {
    const transport = new FakeTransport('mac');
    await stack(transport).remove('grove-overload-arm-1');
    expect(transport.commandLines()[0]).toBe(
      'docker rm -f grove-overload-arm-1',
    );
  });

  it('treats a container that is already gone as removed', async () => {
    const transport = new FakeTransport('mac').fail(
      'docker rm',
      'Error: No such container: grove-overload-arm-1\n',
      1,
    );
    await expect(
      stack(transport).remove('grove-overload-arm-1'),
    ).resolves.toBeUndefined();
  });
});

describe('DockerStack.logs', () => {
  it('reads the tail and returns the exit code', async () => {
    const transport = new FakeTransport('mac').on('docker logs', {
      stdout: 'hello\n',
    });
    const chunks: string[] = [];
    const code = await stack(transport).logs('grove-overload-arm-1', {
      tail: 50,
      onChunk: (chunk) => chunks.push(chunk),
    });
    expect(code).toBe(0);
    expect(chunks.join('')).toBe('hello\n');
    expect(transport.commandLines()[0]).toBe(
      'docker logs --tail 50 grove-overload-arm-1',
    );
  });

  it('follows when asked', async () => {
    const transport = new FakeTransport('mac');
    await stack(transport).logs('grove-overload-arm-1', {
      follow: true,
      tail: 10,
      onChunk: () => undefined,
    });
    expect(transport.commandLines()[0]).toBe(
      'docker logs --follow --tail 10 grove-overload-arm-1',
    );
  });
});

describe('DockerStack, gitlab-runner', () => {
  const gitlabHostConfig = {
    type: 'ssh',
    host: 'atlas',
    work_root: '/PROD/local/grove',
  } as HostConfig;

  const gitlabGroup = {
    name: 'chevro-dind',
    stack: 'docker',
    tags: ['docker'],
  } as GroupConfig;

  function gitlabSpec(): GitlabRunnerSpec {
    return buildGitlabRunnerSpec({
      group: gitlabGroup,
      host: gitlabHostConfig,
      index: 1,
      registration: {
        token: ['glrt', 'K1l2M3n4O5p6Q7r8S9t0'].join('-'),
        url: 'https://git.chevro.fr',
        runnerId: '48',
      },
    });
  }

  it('creates the config directory only its owner can read', async () => {
    const transport = new FakeTransport('atlas');
    await stack(transport).prepareConfigDir(gitlabSpec(), { wipe: false });
    expect(transport.commandLines()[0]).toBe(
      "sh -c mkdir -p '/PROD/local/grove/chevro-dind-1-config' && " +
        "chmod 0700 '/PROD/local/grove/chevro-dind-1-config'",
    );
  });

  it('wipes the config directory when a runner is created, so it registers again', async () => {
    const transport = new FakeTransport('atlas');
    await stack(transport).prepareConfigDir(gitlabSpec(), { wipe: true });
    expect(transport.commandLines()[0]).toContain(
      "rm -rf '/PROD/local/grove/chevro-dind-1-config'",
    );
  });

  it('refuses to wipe a directory that is not a config directory', async () => {
    const transport = new FakeTransport('atlas');
    const bad = { ...gitlabSpec(), configDir: '/etc' };
    await expect(
      stack(transport).prepareConfigDir(bad, { wipe: true }),
    ).rejects.toThrow(/refusing to wipe/);
    expect(transport.calls).toEqual([]);
  });

  it('runs the gitlab-runner container and returns its id', async () => {
    const transport = new FakeTransport('atlas').on('docker run', {
      stdout: 'beef42\n',
    });
    const id = await stack(transport).createGitlabRunner(gitlabSpec());
    expect(id).toBe('beef42');
    const line = transport.commandLines()[0];
    expect(line).toContain('--name grove-chevro-dind-1');
    expect(line).toContain(
      '--volume /PROD/local/grove/chevro-dind-1-config:/etc/gitlab-runner',
    );
    expect(line).toContain('--entrypoint sh');
  });

  it('reads a system id for every runner it was given, in one exec', async () => {
    const transport = new FakeTransport('atlas').on('sh -c set --', {
      stdout:
        'grove-chevro-dind-1\ts_aaaaaaaaaaaa\ngrove-chevro-dind-3\tr_cccccccccccc\n',
    });
    const ids = await stack(transport).readSystemIds([
      {
        name: 'grove-chevro-dind-1',
        configDir: '/PROD/local/grove/chevro-dind-1-config',
      },
      {
        name: 'grove-chevro-dind-2',
        configDir: '/PROD/local/grove/chevro-dind-2-config',
      },
      {
        name: 'grove-chevro-dind-3',
        configDir: '/PROD/local/grove/chevro-dind-3-config',
      },
    ]);

    expect(ids).toEqual({
      'grove-chevro-dind-1': 's_aaaaaaaaaaaa',
      'grove-chevro-dind-3': 'r_cccccccccccc',
    });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].args[1]).toContain(
      "'/PROD/local/grove/chevro-dind-1-config/.runner_system_id'",
    );
  });

  it('asks nothing of the host when there is nothing to read', async () => {
    const transport = new FakeTransport('atlas');
    expect(await stack(transport).readSystemIds([])).toEqual({});
    expect(transport.calls).toEqual([]);
  });

  it('answers with nothing rather than failing the pass when the exec goes wrong', async () => {
    const transport = new FakeTransport('atlas').fail(
      'sh -c set --',
      'sh: cannot execute',
      127,
    );
    expect(
      await stack(transport).readSystemIds([
        {
          name: 'grove-chevro-dind-1',
          configDir: '/PROD/local/grove/chevro-dind-1-config',
        },
      ]),
    ).toEqual({});
  });
});
