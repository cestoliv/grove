import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import { createHostContext, hostWorkRoots } from './host-context.js';

const CONFIG: GroveConfig = {
  tick: { fast: 120_000, full: 1_800_000 },
  hosts: { mac: { type: 'local', work_root: '/Volumes/ci/grove' } },
  forges: { gh: { kind: 'github' } },
  groups: [
    {
      name: 'arm',
      forge: 'gh',
      scope: { level: 'organization', target: 'Acme' },
      placement: { mac: 2 },
      stack: 'docker',
    },
    {
      name: 'ios',
      forge: 'gh',
      scope: { level: 'organization', target: 'Acme' },
      placement: { mac: 1 },
      stack: 'native',
      work_root: '~/ci/ios',
    },
  ],
} as unknown as GroveConfig;

function transportFor(): FakeTransport {
  return new FakeTransport('mac')
    .on('uname -sm', { stdout: 'Darwin arm64\n' })
    .on('sh -c printf %s "$HOME"', { stdout: '/Users/ci' })
    .on('id -u', { stdout: '501\n' })
    .on('docker version', { stdout: '27.1.1\n' })
    .on('df -Pk', {
      stdout: [
        'Filesystem 1024-blocks Used Available Capacity Mounted on',
        '/dev/disk3s5 971350180 123456789 800000000 14% /Volumes/ci',
      ].join('\n'),
    });
}

describe('createHostContext', () => {
  it('probes once however many checks ask', async () => {
    const transport = transportFor();
    const context = createHostContext({
      host: 'mac',
      config: CONFIG,
      transport,
    });

    const first = await context.probe();
    const second = await context.probe();

    expect(first).toBe(second);
    expect(first.platform).toBe('Darwin');
    expect(
      transport.commandLines().filter((line) => line.startsWith('uname')),
    ).toHaveLength(1);
  });

  it('fills the facts as the shared reads run', async () => {
    const context = createHostContext({
      host: 'mac',
      config: CONFIG,
      transport: transportFor(),
    });

    await context.probe();
    await context.home();
    await context.uid();

    expect(context.facts).toMatchObject({
      host: 'mac',
      reachable: true,
      platform: 'Darwin',
      arch: 'arm64',
      home: '/Users/ci',
      uid: '501',
    });
  });

  it('reads docker version once for both Docker checks', async () => {
    const transport = transportFor();
    const context = createHostContext({
      host: 'mac',
      config: CONFIG,
      transport,
    });

    await context.dockerServer();
    await context.dockerServer();

    expect(
      transport.commandLines().filter((line) => line.startsWith('docker')),
    ).toHaveLength(1);
  });

  it('measures a work root once and records the free space in the facts', async () => {
    const context = createHostContext({
      host: 'mac',
      config: CONFIG,
      transport: transportFor(),
    });

    const usage = await context.disk('/Volumes/ci/grove');

    expect(usage?.freeBytes).toBe(800_000_000 * 1024);
    expect(context.facts.freeBytes['/Volumes/ci/grove']).toBe(
      800_000_000 * 1024,
    );
  });

  it('names the seats the config places on this host', async () => {
    const context = createHostContext({
      host: 'mac',
      config: CONFIG,
      transport: transportFor(),
    });

    await context.home();

    expect((await context.seats()).map((seat) => seat.name)).toEqual([
      'grove-arm-1',
      'grove-arm-2',
      'grove-ios-1',
    ]);
  });

  it('measures storage once and keeps it in the facts', async () => {
    const transport = transportFor()
      .on('docker system df', {
        stdout: 'Images\t12.3GB\t4.1GB (33%)\n',
      })
      .on('sh -c set --', {
        stdout: 'grove-arm-1\t2048\ngrove-arm-2\t1024\ngrove-ios-1\t512\n',
      });
    const context = createHostContext({
      host: 'mac',
      config: CONFIG,
      transport,
    });

    const first = await context.storage();
    await context.storage();

    expect(first.docker?.imagesBytes).toBe(12_300_000_000);
    expect(first.workDirBytes).toBe(3584 * 1024);
    expect(context.facts.storage).toBe(first);
    expect(
      transport.commandLines().filter((line) => line.includes('system df')),
    ).toHaveLength(1);
  });
});

describe('hostWorkRoots', () => {
  it('lists every distinct work root with the groups that use it', () => {
    expect(hostWorkRoots(CONFIG, 'mac', '/Users/ci')).toEqual([
      { root: '/Volumes/ci/grove', groups: ['arm'] },
      { root: '/Users/ci/ci/ios', groups: ['ios'] },
    ]);
  });

  it('lists nothing for a host no group is placed on', () => {
    expect(hostWorkRoots(CONFIG, 'atlas')).toEqual([]);
  });
});
