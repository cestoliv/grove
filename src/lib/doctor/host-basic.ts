import { formatBytes } from '../bytes.js';
import { firstLine } from '../transport/index.js';
import type { HostCheckContext } from './host-context.js';
import { type Check, type CheckResult, fail, ok, skip, warn } from './types.js';

// A shell that runs a command and prints exactly what it was asked to print.
// A login banner, a `set -x`, or a shell that is not POSIX all fail here, and
// every one of them would corrupt the output of a later parse instead.
export const SHELL_PROBE_ARGS = ['-c', 'printf %s ok'];
export const CLOCK_ARGS = ['+%s'];

export const CLOCK_WARN_MS = 30_000;
export const CLOCK_FAIL_MS = 300_000;

// A Docker layer pull does not fit under a gibibyte, so that is the floor.
export const DISK_FAIL_BYTES = 1024 ** 3;
export const DISK_WARN_BYTES = 10 * 1024 ** 3;
export const DISK_WARN_PERCENT = 90;

const MANAGED_PLATFORMS = ['darwin', 'linux'];

const NTP_FIX =
  'Turn on network time. On macOS, System Settings > General > Date & Time, or `sudo sntp -sS time.apple.com`. On Linux, `sudo timedatectl set-ntp true`.';

export const reachableCheck: Check<HostCheckContext> = {
  id: 'host.reachable',
  async run(context) {
    const probe = await context.probe();
    if (probe.reachable) {
      return [
        ok(
          `answered as ${probe.platform ?? 'an unknown platform'} ${probe.arch ?? ''}`.trim(),
        ),
      ];
    }
    const fix =
      context.hostConfig.type === 'ssh'
        ? `Run \`ssh ${context.hostConfig.host}\` from this machine. grove shells out to the ssh binary, so whatever fixes that command fixes this: a Host block in ~/.ssh/config, an agent with the key loaded, or a jump host.`
        : 'grove could not run a command on this machine. Check that the shell in the environment grove runs under works.';
    return [fail(probe.reason ?? 'the host did not answer', fix)];
  },
};

export const shellCheck: Check<HostCheckContext> = {
  id: 'host.shell',
  async run(context) {
    const result = await context.transport.exec('sh', SHELL_PROBE_ARGS);
    if (result.code === 0 && result.stdout === 'ok') {
      return [ok('sh runs a command and prints only its output')];
    }
    return [
      fail(
        result.code === 0
          ? `sh printed ${JSON.stringify(result.stdout)} instead of "ok"`
          : `sh exited ${result.code}: ${firstLine(result.stderr)}`,
        'grove parses what a host prints, so a login banner or a shell that is not POSIX breaks every later read. Move the banner into an interactive-only branch of the login shell, or set the login shell to sh, bash or zsh.',
      ),
    ];
  },
};

export const platformCheck: Check<HostCheckContext> = {
  id: 'host.platform',
  async run(context) {
    const probe = await context.probe();
    const platform = probe.platform ?? '';
    if (!MANAGED_PLATFORMS.includes(platform.toLowerCase())) {
      return [
        warn(
          `${platform === '' ? 'an unknown platform' : platform} ${probe.arch ?? ''}`.trim(),
          'grove manages macOS and Linux hosts. Remove the host from grove.yaml, or point it at a macOS or Linux machine.',
        ),
      ];
    }
    if (probe.arch === undefined) {
      return [
        warn(
          `${platform}, architecture unknown`,
          '`uname -m` printed nothing grove recognises, so grove cannot check a group `arch:` against this host. Nothing else is affected.',
        ),
      ];
    }
    return [ok(`${platform} ${probe.arch}`)];
  },
};

export const clockCheck: Check<HostCheckContext> = {
  id: 'host.clock',
  async run(context) {
    const before = context.now();
    const result = await context.transport.exec('date', CLOCK_ARGS);
    const after = context.now();
    const seconds = Number(result.stdout.trim());
    if (result.code !== 0 || !Number.isFinite(seconds)) {
      return [
        fail(
          `\`date +%s\` answered ${JSON.stringify(result.stdout.trim())}`,
          'grove compares the host clock with its own to catch a skew that makes a forge reject a token. Check that `date` is on the PATH the host gives a non-interactive shell.',
        ),
      ];
    }
    // The round trip is subtracted, so a slow link does not read as a skew.
    // What is left is the part grove is confident about.
    const midpoint = (before + after) / 2;
    const uncertainty = (after - before) / 2;
    const raw = Math.abs(seconds * 1000 - midpoint);
    const skew = Math.max(0, raw - uncertainty);
    const detail = `the host is ${(skew / 1000).toFixed(1)}s from this machine, measured across a ${Math.round(after - before)}ms round trip`;
    if (skew >= CLOCK_FAIL_MS) {
      return [
        fail(`clock is ${(skew / 1000).toFixed(0)}s out`, NTP_FIX, { detail }),
      ];
    }
    if (skew >= CLOCK_WARN_MS) {
      return [
        warn(`clock is ${(skew / 1000).toFixed(0)}s out`, NTP_FIX, { detail }),
      ];
    }
    return [ok('clock agrees with this machine', { detail })];
  },
};

export const diskCheck: Check<HostCheckContext> = {
  id: 'host.disk',
  async run(context) {
    const roots = await context.workRoots();
    if (roots.length === 0) {
      return [skip('no group is placed on this host')];
    }
    const results: CheckResult[] = [];
    for (const target of roots) {
      const usage = await context.disk(target.root);
      if (usage === undefined) {
        results.push(
          fail(
            'df could not measure this work root',
            `Check that ${target.root} exists on the host and that \`df -Pk ${target.root}\` answers. grove never creates a work root itself.`,
            { subject: target.root },
          ),
        );
        continue;
      }
      const summary = `${formatBytes(usage.freeBytes)} free, ${usage.capacityPercent}% used`;
      const detail = `on ${usage.mountPoint}, used by ${target.groups.join(', ')}`;
      if (usage.freeBytes < DISK_FAIL_BYTES) {
        results.push(
          fail(
            summary,
            `Free space on ${usage.mountPoint}. A job cannot pull one Docker layer into ${formatBytes(usage.freeBytes)}. Set max_work_size on the groups using this root so grove prunes them on the full tick, or move work_root to a bigger disk.`,
            { subject: target.root, detail },
          ),
        );
        continue;
      }
      if (
        usage.freeBytes < DISK_WARN_BYTES ||
        usage.capacityPercent >= DISK_WARN_PERCENT
      ) {
        results.push(
          warn(
            summary,
            `Free space on ${usage.mountPoint}, or set max_work_size on the groups using this root so grove prunes them oldest-first on the full tick.`,
            { subject: target.root, detail },
          ),
        );
        continue;
      }
      results.push(ok(summary, { subject: target.root, detail }));
    }
    return results;
  },
};

export const BASIC_HOST_CHECKS: Check<HostCheckContext>[] = [
  reachableCheck,
  shellCheck,
  platformCheck,
  clockCheck,
  diskCheck,
];
