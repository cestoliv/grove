import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../transport/index.js';
import {
  parseDockerDiskUsage,
  parseDockerSize,
  readHostStorage,
} from './storage.js';

const DF_OUTPUT = [
  'Images\t12.3GB\t4.1GB (33%)',
  'Containers\t250.4MB\t0B (0%)',
  'Local Volumes\t1.5GB\t1.5GB (100%)',
  'Build Cache\t900MB\t900MB',
  '',
].join('\n');

describe('parseDockerSize', () => {
  it('reads every unit docker prints', () => {
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('512B')).toBe(512);
    expect(parseDockerSize('1.5kB')).toBe(1500);
    expect(parseDockerSize('250.4MB')).toBe(250_400_000);
    expect(parseDockerSize('12.3GB')).toBe(12_300_000_000);
    expect(parseDockerSize('1.1TB')).toBe(1_100_000_000_000);
  });

  it('drops a trailing percentage and tolerates spacing', () => {
    expect(parseDockerSize(' 4.1GB (33%) ')).toBe(4_100_000_000);
  });

  it('answers nothing for a value it does not recognise', () => {
    expect(parseDockerSize('N/A')).toBeUndefined();
    expect(parseDockerSize('')).toBeUndefined();
  });
});

describe('parseDockerDiskUsage', () => {
  it('reads the four rows docker system df prints', () => {
    expect(parseDockerDiskUsage(DF_OUTPUT)).toEqual({
      imagesBytes: 12_300_000_000,
      imagesReclaimableBytes: 4_100_000_000,
      containersBytes: 250_400_000,
      volumesBytes: 1_500_000_000,
      buildCacheBytes: 900_000_000,
    });
  });

  it('answers nothing when no row was recognisable', () => {
    expect(
      parseDockerDiskUsage('Cannot connect to the Docker daemon'),
    ).toBeUndefined();
  });
});

describe('readHostStorage', () => {
  it('measures the image store and the work dirs in two calls', async () => {
    const transport = new FakeTransport('mac')
      .on('docker system df', { stdout: DF_OUTPUT })
      .on('sh -c', { stdout: 'grove-arm-1\t2048\ngrove-arm-2\t1024\n' });

    const storage = await readHostStorage(transport, 'mac', [
      { name: 'grove-arm-1', workDir: '/Volumes/ci/grove/arm-1' },
      { name: 'grove-arm-2', workDir: '/Volumes/ci/grove/arm-2' },
    ]);

    expect(storage.docker?.imagesBytes).toBe(12_300_000_000);
    expect(storage.workDirBytes).toBe(3072 * 1024);
    expect(storage.workDirs).toEqual([
      { name: 'grove-arm-1', bytes: 2048 * 1024 },
      { name: 'grove-arm-2', bytes: 1024 * 1024 },
    ]);
    expect(storage.dockerError).toBeUndefined();
    expect(storage.workDirError).toBeUndefined();
  });

  it('reports a host with no Docker without losing the work dirs', async () => {
    const transport = new FakeTransport('mac')
      .fail('docker system df', 'docker: command not found', 127)
      .on('sh -c', { stdout: 'grove-ios-1\t4096\n' });

    const storage = await readHostStorage(transport, 'mac', [
      { name: 'grove-ios-1', workDir: '/Volumes/ci/grove/ios-1' },
    ]);

    expect(storage.docker).toBeUndefined();
    expect(storage.dockerError).toContain('command not found');
    expect(storage.workDirBytes).toBe(4096 * 1024);
  });

  it('skips docker entirely when the caller says the host runs none', async () => {
    const transport = new FakeTransport('mac').on('sh -c', { stdout: '' });
    const storage = await readHostStorage(transport, 'mac', [], {
      docker: false,
    });
    expect(storage.docker).toBeUndefined();
    expect(storage.dockerError).toBeUndefined();
    expect(transport.commandLines().join('\n')).not.toContain('docker');
  });

  it('never throws when the transport does', async () => {
    const transport = new FakeTransport('atlas')
      .throwOn('docker system df', 'ssh: connect failed')
      .throwOn('sh -c', 'ssh: connect failed');

    const storage = await readHostStorage(transport, 'atlas', [
      { name: 'grove-dind-1', workDir: '/PROD/local/grove/dind-1' },
    ]);

    expect(storage.dockerError).toContain('ssh: connect failed');
    expect(storage.workDirError).toContain('ssh: connect failed');
    expect(storage.workDirBytes).toBeUndefined();
  });
});
