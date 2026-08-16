import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../transport/index.js';
import {
  checkWorkRootVolume,
  mountPointFor,
  statDeviceArgs,
} from './volume-guard.js';

describe('mountPointFor', () => {
  it('takes the two leading segments of a guarded path', () => {
    expect(mountPointFor('/Volumes/ci/grove/overload-arm-1')).toBe(
      '/Volumes/ci',
    );
    expect(mountPointFor('/mnt/data/grove')).toBe('/mnt/data');
    expect(mountPointFor('/media/usb')).toBe('/media/usb');
  });

  it('returns null for a path grove does not guard', () => {
    expect(mountPointFor('/PROD/local/grove')).toBeNull();
    expect(mountPointFor('/var/tmp/grove')).toBeNull();
    expect(mountPointFor('/Volumes')).toBeNull();
  });
});

describe('statDeviceArgs', () => {
  it('uses BSD stat on macOS and GNU stat on Linux', () => {
    expect(statDeviceArgs('Darwin', '/Volumes/ci')).toEqual([
      '-f',
      '%d',
      '/Volumes/ci',
    ]);
    expect(statDeviceArgs('Linux', '/mnt/data')).toEqual([
      '-c',
      '%d',
      '/mnt/data',
    ]);
  });
});

describe('checkWorkRootVolume', () => {
  it('does not guard a path outside the mount prefixes', async () => {
    const transport = new FakeTransport('atlas');
    const check = await checkWorkRootVolume(
      transport,
      'Linux',
      '/PROD/local/grove',
    );
    expect(check).toEqual({ guarded: false, ok: true });
    expect(transport.calls).toEqual([]);
  });

  it('accepts a work root on its own device', async () => {
    const transport = new FakeTransport('mac')
      .on('stat -f %d /Volumes/ci', { stdout: '17\n' })
      .on('stat -f %d /', { stdout: '16\n' });
    const check = await checkWorkRootVolume(
      transport,
      'Darwin',
      '/Volumes/ci/grove',
    );
    expect(check).toEqual({
      guarded: true,
      ok: true,
      mountPoint: '/Volumes/ci',
    });
  });

  it('refuses a work root that fell back to the boot volume', async () => {
    const transport = new FakeTransport('mac')
      .on('stat -f %d /Volumes/ci', { stdout: '16\n' })
      .on('stat -f %d /', { stdout: '16\n' });
    const check = await checkWorkRootVolume(
      transport,
      'Darwin',
      '/Volumes/ci/grove',
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(
      /\/Volumes\/ci sits on the same device as \/, so the volume is not mounted/,
    );
  });

  it('refuses a mount point that does not exist', async () => {
    const transport = new FakeTransport('mac').fail(
      'stat -f %d /Volumes/ci',
      'stat: /Volumes/ci: No such file or directory\n',
      1,
    );
    const check = await checkWorkRootVolume(
      transport,
      'Darwin',
      '/Volumes/ci/grove',
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/mount point \/Volumes\/ci does not exist/);
    expect(check.reason).toMatch(/grove never creates a mount point/);
  });

  it('refuses when stat prints something that is not a device id', async () => {
    const transport = new FakeTransport('mac')
      .on('stat -f %d /Volumes/ci', { stdout: '\n' })
      .on('stat -f %d /', { stdout: '16\n' });
    const check = await checkWorkRootVolume(
      transport,
      'Darwin',
      '/Volumes/ci/grove',
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/could not read the device id/);
  });
});
