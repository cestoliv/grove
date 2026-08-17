import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import { createHostContext } from './host-context.js';
import {
  dockerCliCheck,
  dockerDaemonCheck,
  dockerGroupCheck,
  imageStoreCheck,
} from './host-docker.js';

function configWith(stack: 'docker' | 'native'): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { box: { type: 'ssh', host: 'box', work_root: '/srv/grove' } },
    forges: { gh: { kind: 'github' } },
    groups: [
      {
        name: 'runners',
        forge: 'gh',
        scope: { level: 'organization', target: 'Acme' },
        placement: { box: 1 },
        stack,
      },
    ],
  } as unknown as GroveConfig;
}

function contextFor(
  transport: FakeTransport,
  stack: 'docker' | 'native' = 'docker',
) {
  return createHostContext({
    host: 'box',
    config: configWith(stack),
    transport,
  });
}

const LINUX = { stdout: 'Linux x86_64\n' };
const DARWIN = { stdout: 'Darwin arm64\n' };

describe('dockerCliCheck', () => {
  it('passes when docker is on the PATH', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('docker version', { stdout: '27.1.1\n' }),
    );
    const [result] = await dockerCliCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('fails when the binary is missing, and the fix names both installers', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .fail('docker version', 'sh: docker: command not found', 127),
    );
    const [result] = await dockerCliCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('OrbStack');
    expect(result.fix).toContain('get.docker.com');
  });

  it('passes when the binary is there but the daemon is not, because that is the other check', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .fail(
          'docker version',
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
          1,
        ),
    );
    const [result] = await dockerCliCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('skips a host with no Docker group placed on it', async () => {
    const context = contextFor(
      new FakeTransport('box').on('uname -sm', DARWIN),
      'native',
    );
    const [result] = await dockerCliCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('dockerDaemonCheck', () => {
  it('reports the server version', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('docker version', { stdout: '27.1.1\n' }),
    );
    const [result] = await dockerDaemonCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('27.1.1');
  });

  it('fails when the daemon does not answer, with a per-platform fix', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .fail(
          'docker version',
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
          1,
        ),
    );
    const [result] = await dockerDaemonCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('systemctl start docker');
  });

  it('names the macOS fix on a Mac', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .fail('docker version', 'Cannot connect to the Docker daemon.', 1),
    );
    const [result] = await dockerDaemonCheck.run(context);
    expect(result.fix).toContain('OrbStack');
  });
});

describe('dockerGroupCheck', () => {
  it('passes when the daemon already answered as this user', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('docker version', { stdout: '27.1.1\n' }),
    );
    const [result] = await dockerGroupCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('fails when the daemon refused and the user is not in the docker group', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .fail('docker version', 'permission denied while trying to connect', 1)
        .on('id -nG', { stdout: 'ci sudo users\n' }),
    );
    const [result] = await dockerGroupCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('usermod -aG docker');
  });

  it('passes when the user is in the group even though the daemon is down', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .fail('docker version', 'Cannot connect to the Docker daemon.', 1)
        .on('id -nG', { stdout: 'ci docker sudo\n' }),
    );
    const [result] = await dockerGroupCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('skips on macOS, which has no docker group', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .fail('docker version', 'Cannot connect to the Docker daemon.', 1),
    );
    const [result] = await dockerGroupCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('imageStoreCheck', () => {
  function transportWith(images: string, reclaimable: string): FakeTransport {
    return new FakeTransport('box')
      .on('uname -sm', LINUX)
      .on('docker system df', {
        stdout: `Images\t${images}\t${reclaimable}\n`,
      })
      .on('sh -c set --', { stdout: 'grove-runners-1\t1024\n' });
  }

  it('reports the image store size', async () => {
    const context = contextFor(transportWith('4.2GB', '100MB (2%)'));
    const [result] = await imageStoreCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('images');
  });

  it('warns above twenty gibibytes', async () => {
    const context = contextFor(transportWith('30GB', '1GB (3%)'));
    const [result] = await imageStoreCheck.run(context);
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('docker image prune');
  });

  it('warns when more than half of it is reclaimable', async () => {
    const context = contextFor(transportWith('8GB', '6GB (75%)'));
    const [result] = await imageStoreCheck.run(context);
    expect(result.status).toBe('warn');
  });

  it('says grove cannot move the store', async () => {
    const context = contextFor(transportWith('30GB', '1GB (3%)'));
    const [result] = await imageStoreCheck.run(context);
    expect(result.fix).toContain('outside grove');
  });

  it('warns when docker system df did not answer', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .fail('docker system df', 'Cannot connect to the Docker daemon.', 1)
        .on('sh -c set --', { stdout: '' }),
    );
    const [result] = await imageStoreCheck.run(context);
    expect(result.status).toBe('warn');
  });
});
