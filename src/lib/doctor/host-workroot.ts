import { formatBytes } from '../bytes.js';
import { checkWorkRootVolume } from '../stack/index.js';
import type { HostCheckContext } from './host-context.js';
import { type Check, type CheckResult, fail, ok, skip, warn } from './types.js';

const NO_GROUP = 'no group is placed on this host';

function exists(
  context: HostCheckContext,
  root: string,
): Promise<{ code: number }> {
  // Memoised, because the writable check needs the same answer and asking a
  // remote host twice for one `test -d` is two SSH round trips.
  return context.once(`test-d:${root}`, () =>
    context.transport.exec('test', ['-d', root]),
  );
}

export const workRootExistsCheck: Check<HostCheckContext> = {
  id: 'host.work-root-exists',
  async run(context) {
    const roots = await context.workRoots();
    if (roots.length === 0) {
      return [skip(NO_GROUP)];
    }
    const results: CheckResult[] = [];
    for (const target of roots) {
      const test = await exists(context, target.root);
      results.push(
        test.code === 0
          ? ok('the work root is a directory', { subject: target.root })
          : fail(
              'the work root is not there',
              `Create it on the host with \`mkdir -p ${target.root}\`, or mount the volume that holds it. grove never creates a work root or a mount point itself, because \`mkdir -p\` on an absent mount point silently writes to the boot disk.`,
              {
                subject: target.root,
                detail: `used by ${target.groups.join(', ')}`,
              },
            ),
      );
    }
    return results;
  },
};

export const workRootWritableCheck: Check<HostCheckContext> = {
  id: 'host.work-root-writable',
  async run(context) {
    const roots = await context.workRoots();
    if (roots.length === 0) {
      return [skip(NO_GROUP)];
    }
    const results: CheckResult[] = [];
    for (const target of roots) {
      const present = await exists(context, target.root);
      if (present.code !== 0) {
        results.push(
          skip('the work root is not there', { subject: target.root }),
        );
        continue;
      }
      const test = await context.transport.exec('test', ['-w', target.root]);
      results.push(
        test.code === 0
          ? ok('the work root is writable', { subject: target.root })
          : fail(
              'the work root is not writable by this user',
              `Run \`sudo chown -R "$(id -un)" ${target.root}\` on the host, or point work_root somewhere the SSH user owns. grove creates each seat's directory under this root, so it needs to write here.`,
              { subject: target.root },
            ),
      );
    }
    return results;
  },
};

export const workRootVolumeCheck: Check<HostCheckContext> = {
  id: 'host.work-root-volume',
  async run(context) {
    const roots = await context.workRoots();
    if (roots.length === 0) {
      return [skip(NO_GROUP)];
    }
    const probe = await context.probe();
    const results: CheckResult[] = [];
    for (const target of roots) {
      // The same function the fast tick runs before every start, so a work
      // root doctor passes is one the daemon will start a runner on.
      const check = await checkWorkRootVolume(
        context.transport,
        probe.platform ?? 'Linux',
        target.root,
      );
      if (!check.guarded) {
        results.push(
          skip(
            'the work root is not under /Volumes, /mnt or /media, so an absent mount cannot be mistaken for it',
            { subject: target.root },
          ),
        );
        continue;
      }
      if (check.ok) {
        results.push(
          ok(`${check.mountPoint} is mounted on its own device`, {
            subject: target.root,
          }),
        );
        continue;
      }
      results.push(
        fail(
          check.reason ?? 'the work root may have fallen back to the boot disk',
          `Mount the disk at ${check.mountPoint}, or point work_root at a path on a disk that is already there. grove refuses to start a runner whose work root fell back to the boot volume, so this blocks the group rather than quietly filling the internal SSD.`,
          { subject: target.root },
        ),
      );
    }
    return results;
  },
};

export const workDirsCheck: Check<HostCheckContext> = {
  id: 'host.work-dirs',
  async run(context) {
    const seats = await context.seats();
    if (seats.length === 0) {
      return [skip(NO_GROUP)];
    }
    const storage = await context.storage();
    if (storage.workDirError !== undefined) {
      return [
        warn(
          storage.workDirError,
          'Check that `du -sk` answers under the work root on the host. grove reports work-dir usage here, and prunes it only for a group that sets max_work_size.',
        ),
      ];
    }
    const largest = [...storage.workDirs].sort((a, b) => b.bytes - a.bytes)[0];
    return [
      ok(
        `${formatBytes(storage.workDirBytes ?? 0)} across ${seats.length} seat${seats.length === 1 ? '' : 's'}`,
        {
          detail:
            largest === undefined
              ? 'no seat has a work dir on the host yet'
              : `largest ${largest.name} at ${formatBytes(largest.bytes)}`,
        },
      ),
    ];
  },
};

export const WORK_ROOT_HOST_CHECKS: Check<HostCheckContext>[] = [
  workRootExistsCheck,
  workRootWritableCheck,
  workRootVolumeCheck,
  workDirsCheck,
];
