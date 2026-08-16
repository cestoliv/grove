import { firstLine, type Transport } from '../transport/index.js';

// The three conventional mount roots. Under any of them, a work root that
// shares a device with / means the disk is not mounted. Anywhere else, a
// shared device is normal and guarding would produce false positives.
export const GUARDED_MOUNT_PREFIXES = ['/Volumes/', '/mnt/', '/media/'];

const EMPTY_STAT = 'stat printed nothing';

export interface VolumeCheck {
  guarded: boolean;
  ok: boolean;
  mountPoint?: string;
  reason?: string;
}

export function mountPointFor(path: string): string | null {
  if (!GUARDED_MOUNT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return null;
  }
  const parts = path.split('/');
  if (parts.length < 3 || parts[2] === '') {
    return null;
  }
  return `/${parts[1]}/${parts[2]}`;
}

export function statDeviceArgs(platform: string, path: string): string[] {
  return platform.toLowerCase() === 'darwin'
    ? ['-f', '%d', path]
    : ['-c', '%d', path];
}

async function deviceId(
  transport: Transport,
  platform: string,
  path: string,
): Promise<{ device?: string; error?: string }> {
  const result = await transport.exec('stat', statDeviceArgs(platform, path));
  if (result.code !== 0) {
    return { error: firstLine(result.stderr) };
  }
  const device = result.stdout.trim();
  return device === '' ? { error: EMPTY_STAT } : { device };
}

export async function checkWorkRootVolume(
  transport: Transport,
  platform: string,
  workRoot: string,
): Promise<VolumeCheck> {
  const mountPoint = mountPointFor(workRoot);
  if (mountPoint === null) {
    return { guarded: false, ok: true };
  }

  const mount = await deviceId(transport, platform, mountPoint);
  if (mount.device === undefined) {
    return {
      guarded: true,
      ok: false,
      mountPoint,
      reason:
        mount.error === EMPTY_STAT
          ? `could not read the device id of ${mountPoint} on this host`
          : `mount point ${mountPoint} does not exist, so ${workRoot} would fall back to the boot volume. Mount the disk. grove never creates a mount point itself. (${mount.error})`,
    };
  }

  const root = await deviceId(transport, platform, '/');
  if (root.device === undefined) {
    return {
      guarded: true,
      ok: false,
      mountPoint,
      reason: `could not read the device id of / on this host (${root.error})`,
    };
  }

  if (mount.device === root.device) {
    return {
      guarded: true,
      ok: false,
      mountPoint,
      reason: `${mountPoint} sits on the same device as /, so the volume is not mounted and ${workRoot} would fill the boot disk. Mount the disk, or point work_root somewhere else.`,
    };
  }

  return { guarded: true, ok: true, mountPoint };
}
