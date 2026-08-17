import { formatBytes } from '../bytes.js';
import { checkWorkRootVolume } from '../stack/index.js';
import type { HostCheckContext, WorkRootTarget } from './host-context.js';
import { type Check, type CheckResult, fail, ok, skip, warn } from './types.js';

const NO_GROUP = 'no group is placed on this host';

// What the operator calls the path, and the key that put it there. An install
// root is only ever the second one, and it reads the same host the same way.
function noun(target: WorkRootTarget): string {
  return target.kind === 'install' ? 'install root' : 'work root';
}

function key(target: WorkRootTarget): string {
  return target.kind === 'install' ? 'install_root' : 'work_root';
}

// Both roots the host has to hold, in one list, so a check written once
// covers a group that installs its runner off its work root.
async function roots(context: HostCheckContext): Promise<WorkRootTarget[]> {
  const [work, install] = await Promise.all([
    context.workRoots(),
    context.installRoots(),
  ]);
  return [...work, ...install];
}

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
    const targets = await roots(context);
    if (targets.length === 0) {
      return [skip(NO_GROUP)];
    }
    const results: CheckResult[] = [];
    for (const target of targets) {
      const test = await exists(context, target.root);
      results.push(
        test.code === 0
          ? ok(`the ${noun(target)} is a directory`, { subject: target.root })
          : fail(
              `the ${noun(target)} is not there`,
              `Create it on the host with \`mkdir -p ${target.root}\`, or mount the volume that holds it. grove never creates a ${noun(target)} or a mount point itself, because \`mkdir -p\` on an absent mount point silently writes to the boot disk.`,
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
    const targets = await roots(context);
    if (targets.length === 0) {
      return [skip(NO_GROUP)];
    }
    const results: CheckResult[] = [];
    for (const target of targets) {
      const present = await exists(context, target.root);
      if (present.code !== 0) {
        results.push(
          skip(`the ${noun(target)} is not there`, { subject: target.root }),
        );
        continue;
      }
      const test = await context.transport.exec('test', ['-w', target.root]);
      results.push(
        test.code === 0
          ? ok(`the ${noun(target)} is writable`, { subject: target.root })
          : fail(
              `the ${noun(target)} is not writable by this user`,
              `Run \`sudo chown -R "$(id -un)" ${target.root}\` on the host, or point ${key(target)} somewhere the SSH user owns. grove creates each seat's directory under this root, so it needs to write here.`,
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
    const targets = await roots(context);
    if (targets.length === 0) {
      return [skip(NO_GROUP)];
    }
    const probe = await context.probe();
    const results: CheckResult[] = [];
    for (const target of targets) {
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
            `the ${noun(target)} is not under /Volumes, /mnt or /media, so an absent mount cannot be mistaken for it`,
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
          check.reason ??
            `the ${noun(target)} may have fallen back to the boot disk`,
          `Mount the disk at ${check.mountPoint}, or point ${key(target)} at a path on a disk that is already there. grove refuses to start a runner whose work root fell back to the boot volume, so this blocks the group rather than quietly filling the internal SSD.`,
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
