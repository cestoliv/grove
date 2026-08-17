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

// A native group whose runner lives on the boot disk while its work dir stays
// on the external volume, which is the layout install_root exists for.
function configWithInstallRoot(): GroveConfig {
  return {
    ...configWith('/Volumes/ci/grove'),
    groups: [
      {
        name: 'ios',
        forge: 'gh',
        scope: { level: 'organization', target: 'Acme' },
        placement: { mac: 1 },
        stack: 'native',
        install_root: '/Users/ci/runners',
      },
    ],
  } as unknown as GroveConfig;
}

function installRootContext(transport: FakeTransport) {
  return createHostContext({
    host: 'mac',
    config: configWithInstallRoot(),
    transport,
  });
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

describe('the install root a native group names', () => {
  it('is checked for existence under its own subject', async () => {
    const context = installRootContext(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('test -d', { code: 0 }),
    );
    const results = await workRootExistsCheck.run(context);
    expect(results.map((result) => result.subject)).toEqual([
      '/Volumes/ci/grove',
      '/Users/ci/runners',
    ]);
    expect(results[1].summary).toBe('the install root is a directory');
  });

  it('names install_root in the fix when it is not writable', async () => {
    const context = installRootContext(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('test -d', { code: 0 })
        .on('test -w', { code: 1 }),
    );
    const results = await workRootWritableCheck.run(context);
    expect(results[1].subject).toBe('/Users/ci/runners');
    expect(results[1].summary).toBe(
      'the install root is not writable by this user',
    );
    expect(results[1].fix).toContain('install_root');
  });

  it('is checked against the boot device like any other root', async () => {
    const context = installRootContext(
      new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('stat -f %d /Volumes/ci', { stdout: '17\n' })
        .on('stat -f %d /', { stdout: '1\n' }),
    );
    const results = await workRootVolumeCheck.run(context);
    expect(results[1].subject).toBe('/Users/ci/runners');
    expect(results[1].status).toBe('skip');
    expect(results[1].summary).toContain('the install root is not under');
  });

  it('is left out when it is the work root the group already uses', async () => {
    const config = configWithInstallRoot();
    const context = createHostContext({
      host: 'mac',
      config: {
        ...config,
        groups: [{ ...config.groups[0], install_root: '/Volumes/ci/grove' }],
      } as unknown as GroveConfig,
      transport: new FakeTransport('mac')
        .on('uname -sm', DARWIN)
        .on('test -d', { code: 0 }),
    });
    const results = await workRootExistsCheck.run(context);
    expect(results.map((result) => result.subject)).toEqual([
      '/Volumes/ci/grove',
    ]);
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
