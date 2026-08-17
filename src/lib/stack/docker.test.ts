import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GroupConfig, HostConfig } from '../config/index.js';
import {
  type ExecOptions,
  type ExecResult,
  FakeTransport,
  LocalTransport,
  type Transport,
} from '../transport/index.js';
import {
  buildFailureLine,
  buildSystemIdScript,
  DockerStack,
} from './docker.js';
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

// A real failed build under BuildKit: a banner, progress lines, the failing
// step's own `#5 ERROR:` line, the summary `ERROR:` line, and Docker
// Desktop's trailer after it.
const BUILDKIT_STDERR = [
  '#0 building with "orbstack" instance using docker driver',
  '',
  '#1 [internal] load build definition from Dockerfile',
  '#1 transferring dockerfile: 812B done',
  '#1 DONE 0.0s',
  '',
  '#5 [3/5] RUN apt-get install -y nope',
  '#5 2.145 E: Unable to locate package nope',
  '#5 ERROR: process "/bin/sh -c apt-get install -y nope" did not complete successfully: exit code: 100',
  '------',
  ' > [3/5] RUN apt-get install -y nope:',
  '2.145 E: Unable to locate package nope',
  '------',
  'Dockerfile:7',
  '--------------------',
  '   6 |     RUN apt-get update',
  '   7 | >>> RUN apt-get install -y nope',
  '--------------------',
  'ERROR: failed to solve: process "/bin/sh -c apt-get install -y nope" did not complete successfully: exit code: 100',
  '',
  'View build details: docker-desktop://dashboard/build/orbstack/orbstack/x1y2z3',
  '',
].join('\n');

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

  // The banner is the first thing BuildKit writes and it says nothing about
  // the failure, so an operator reading the error must be handed the step
  // that actually broke.
  it('names the step that failed rather than the buildkit banner', async () => {
    const transport = new FakeTransport('mac').fail(
      'docker build',
      BUILDKIT_STDERR,
      1,
    );
    await expect(
      stack(transport).build('grove-x:abc', '/srv/runners/Dockerfile'),
    ).rejects.toThrow(
      'mac: docker build grove-x:abc failed: ERROR: failed to solve: ' +
        'process "/bin/sh -c apt-get install -y nope" did not complete successfully: exit code: 100',
    );
  });

  it('falls back to the exit code when the build said nothing at all', async () => {
    const transport = new FakeTransport('mac').fail('docker build', '', 1);
    await expect(
      stack(transport).build('grove-x:abc', '/srv/runners/Dockerfile'),
    ).rejects.toThrow('mac: docker build grove-x:abc failed: exit 1');
  });
});

describe('buildFailureLine', () => {
  it('takes the summary ERROR line, not the banner and not the trailer', () => {
    expect(buildFailureLine(BUILDKIT_STDERR)).toBe(
      'ERROR: failed to solve: process "/bin/sh -c apt-get install -y nope" ' +
        'did not complete successfully: exit code: 100',
    );
  });

  it('keeps a legacy one-line error as it is', () => {
    expect(
      buildFailureLine(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
      ),
    ).toBe(
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    );
  });

  // A builder that marks nothing still says the useful thing last.
  it('takes the last non-empty line when nothing is marked ERROR', () => {
    expect(
      buildFailureLine('#1 [internal] load\n\nfailed to read dockerfile\n\n'),
    ).toBe('failed to read dockerfile');
  });

  it('answers with nothing when stderr is empty, so the caller can name the exit code', () => {
    expect(buildFailureLine('\n  \n')).toBe('');
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

describe('buildSystemIdScript', () => {
  const targets = [
    {
      name: 'grove-chevro-dind-1',
      configDir: '/PROD/local/grove/chevro-dind-1-config',
    },
  ];

  it('carries every path quoted, as a positional parameter', () => {
    expect(buildSystemIdScript(targets)).toContain(
      "set -- 'grove-chevro-dind-1' " +
        "'/PROD/local/grove/chevro-dind-1-config/.runner_system_id'",
    );
  });

  // Both copies are the same file through the bind mount, so the exec is
  // there for the host that cannot read its own file and must not be paid
  // where the read already worked.
  it('reads the host file first and asks the container only after', () => {
    const script = buildSystemIdScript(targets);
    const readAt = script.indexOf('if [ -r "$2" ]; then sid=$(cat "$2"');
    const execAt = script.indexOf(
      `if [ -z "$sid" ]; then sid=$(docker exec "$1" cat '/etc/gitlab-runner/.runner_system_id'`,
    );
    expect(readAt).toBeGreaterThan(-1);
    expect(execAt).toBeGreaterThan(readAt);
  });

  // A stopped container makes docker write to stderr and exit non-zero, and
  // none of that may reach the tab-separated answer.
  it('keeps docker noise out of the answer', () => {
    expect(buildSystemIdScript(targets)).toContain(
      `docker exec "$1" cat '/etc/gitlab-runner/.runner_system_id' 2>/dev/null`,
    );
  });
});

// The script itself decides which id wins and whether docker is called at
// all, and a fake transport can only answer a whole `sh -c` with one canned
// string. So the outcomes run against a real /bin/sh with a stub docker ahead
// of the real one on PATH.
class StubbedPathTransport implements Transport {
  readonly name = 'stub';
  private readonly local = new LocalTransport();
  private readonly binDir: string;

  constructor(binDir: string) {
    this.binDir = binDir;
  }

  async exec(
    command: string,
    args: string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    return this.local.exec(command, args, {
      ...options,
      env: { ...options.env, PATH: `${this.binDir}:${process.env.PATH ?? ''}` },
    });
  }

  async readFile(path: string): Promise<string> {
    return this.local.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.local.writeFile(path, content);
  }

  async close(): Promise<void> {
    return this.local.close();
  }
}

describe('DockerStack.readSystemIds, against a real shell', () => {
  let root: string;
  let binDir: string;
  let configDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'grove-system-id-'));
    binDir = join(root, 'bin');
    configDir = join(root, 'chevro-dind-1-config');
    await mkdir(binDir);
    await mkdir(configDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Every stub docker leaves a mark before it answers, so a test can tell
  // whether the exec was paid at all.
  async function stubDocker(body: string): Promise<void> {
    const path = join(binDir, 'docker');
    await writeFile(
      path,
      `#!/bin/sh\ntouch '${join(root, 'docker-was-called')}'\n${body}\n`,
      'utf8',
    );
    await chmod(path, 0o755);
  }

  function dockerWasCalled(): boolean {
    return existsSync(join(root, 'docker-was-called'));
  }

  const noSuchContainer = [
    'echo "Error response from daemon: No such container" >&2',
    'exit 1',
  ].join('\n');

  async function hostFile(content: string): Promise<void> {
    await writeFile(join(configDir, '.runner_system_id'), content, 'utf8');
  }

  async function readSystemIds(): Promise<Record<string, string>> {
    return new DockerStack({
      transport: new StubbedPathTransport(binDir),
      host: 'atlas',
    }).readSystemIds([{ name: 'grove-chevro-dind-1', configDir }]);
  }

  // The stub would answer with another value, so the answer says which of the
  // two the script read, and the mark says the exec was never run.
  it('reads the host file without paying an exec', async () => {
    await stubDocker(`printf 's_from_container\\n'`);
    await hostFile('s_from_host\n');
    expect(await readSystemIds()).toEqual({
      'grove-chevro-dind-1': 's_from_host',
    });
    expect(dockerWasCalled()).toBe(false);
  });

  // The Linux case this is all for: the container wrote the file as root,
  // 0600, and the ssh user cannot read it. Skipped when the suite itself runs
  // as root, where the mode bits stop nothing.
  it.skipIf(process.getuid?.() === 0)(
    'asks the container when the host file is there but unreadable',
    async () => {
      await stubDocker(`printf 's_from_container\\n'`);
      await hostFile('s_from_host\n');
      await chmod(join(configDir, '.runner_system_id'), 0o000);
      expect(await readSystemIds()).toEqual({
        'grove-chevro-dind-1': 's_from_container',
      });
      expect(dockerWasCalled()).toBe(true);
    },
  );

  it('asks the container when the host file is not there', async () => {
    await stubDocker(`printf 's_from_container\\n'`);
    expect(await readSystemIds()).toEqual({
      'grove-chevro-dind-1': 's_from_container',
    });
    expect(dockerWasCalled()).toBe(true);
  });

  it('asks the container when the host file is readable but empty', async () => {
    await stubDocker(`printf 's_from_container\\n'`);
    await hostFile('');
    expect(await readSystemIds()).toEqual({
      'grove-chevro-dind-1': 's_from_container',
    });
    expect(dockerWasCalled()).toBe(true);
  });

  it('says nothing about a seat neither the host nor the container can answer for', async () => {
    await stubDocker(noSuchContainer);
    expect(await readSystemIds()).toEqual({});
  });
});
