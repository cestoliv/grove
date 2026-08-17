import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import { createHostContext } from './host-context.js';
import {
  workDirsCheck,
  workRootExistsCheck,
  workRootVolumeCheck,
  workRootWritableCheck,
} from './host-workroot.js';

function configWith(workRoot: string): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { mac: { type: 'local', work_root: workRoot } },
    forges: { gh: { kind: 'github' } },
    groups: [
      {
        name: 'arm',
        forge: 'gh',
        scope: { level: 'organization', target: 'Acme' },
        placement: { mac: 1 },
        stack: 'docker',
      },
    ],
  } as unknown as GroveConfig;
}

function contextFor(transport: FakeTransport, workRoot = '/Volumes/ci/grove') {
  return createHostContext({
    host: 'mac',
    config: configWith(workRoot),
    transport,
  });
}

const DARWIN = { stdout: 'Darwin arm64\n' };

describe('workRootExistsCheck', () => {
  it('passes a root that is a directory', async () => {
    const context = contextFor(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('test -d', { code: 0 }),
    );
    const [result] = await workRootExistsCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.subject).toBe('/Volumes/ci/grove');
  });

  it('fails a root that is not there, and refuses to offer to create it', async () => {
    const context = contextFor(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('test -d', { code: 1 }),
    );
    const [result] = await workRootExistsCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('mkdir -p /Volumes/ci/grove');
    expect(result.fix).toContain('never creates');
  });

  it('skips a host no group is placed on', async () => {
    const config = configWith('/Volumes/ci/grove');
    const context = createHostContext({
      host: 'mac',
      config: { ...config, groups: [] } as unknown as GroveConfig,
      transport: new FakeTransport('mac').on('uname -sm', DARWIN),
    });
    const [result] = await workRootExistsCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('workRootWritableCheck', () => {
  it('passes a writable root', async () => {
    const context = contextFor(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('test -d', { code: 0 })
        .on('test -w', { code: 0 }),
    );
    const [result] = await workRootWritableCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('fails a root the user cannot write', async () => {
    const context = contextFor(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('test -d', { code: 0 })
        .on('test -w', { code: 1 }),
    );
    const [result] = await workRootWritableCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('chown');
  });

  it('skips when the root is not there, because the other check already said so', async () => {
    const context = contextFor(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('test -d', { code: 1 })
        .on('test -w', { code: 1 }),
    );
    const [result] = await workRootWritableCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('workRootVolumeCheck', () => {
  it('passes a mount point whose device differs from the root device', async () => {
    const context = contextFor(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('stat -f %d /Volumes/ci', { stdout: '17\n' })
        .on('stat -f %d /', { stdout: '1\n' }),
    );
    const [result] = await workRootVolumeCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('/Volumes/ci');
  });

  it('fails when the volume is not mounted and the work root would fill the boot disk', async () => {
    const context = contextFor(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('stat -f %d /Volumes/ci', { stdout: '1\n' })
        .on('stat -f %d /', { stdout: '1\n' }),
    );
    const [result] = await workRootVolumeCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('boot disk');
    expect(result.fix).toContain('Mount the disk');
  });

  it('skips a work root outside the three guarded mount roots', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('uname -sm', DARWIN),
      '/srv/grove',
    );
    const [result] = await workRootVolumeCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('workDirsCheck', () => {
  it('reports the total and the largest seat', async () => {
    const context = contextFor(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('docker system df', { stdout: 'Images\t1GB\t0B (0%)\n' })
        .on('sh -c set --', { stdout: 'grove-arm-1\t2097152\n' }),
    );
    const [result] = await workDirsCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('2.0 GiB');
    expect(result.detail).toContain('grove-arm-1');
  });

  it('warns when the work dirs could not be measured', async () => {
    const context = contextFor(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('docker system df', { stdout: 'Images\t1GB\t0B (0%)\n' })
        .fail('sh -c set --', 'du: permission denied'),
    );
    const [result] = await workDirsCheck.run(context);
    expect(result.status).toBe('warn');
  });
});
