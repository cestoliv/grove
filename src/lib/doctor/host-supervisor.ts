import {
  groupMetricsPort,
  isDarwinPlatform,
  NO_USER_BUS,
} from '../stack/index.js';
import { firstLine } from '../transport/index.js';
import type { HostCheckContext } from './host-context.js';
import { type Check, fail, ok, skip, warn } from './types.js';

// Any of these means the user manager is up and its bus is reachable, which
// is the only thing grove needs. `degraded` exits non-zero and is still fine:
// some other user unit failed, and that is not grove's business.
export const SYSTEMD_RUNNING_STATES = [
  'running',
  'degraded',
  'initializing',
  'starting',
  'maintenance',
  'stopping',
];

export const SYSTEMD_USER_ARGS = ['--user', 'is-system-running'];
export const LINGER_ARGS = ['-c', 'loginctl show-user "$(id -un)" -p Linger'];
export const SIMCTL_ARGS = ['simctl', 'list', 'devices', 'available', '-j'];
export const CURL_PRESENT_ARGS = ['-c', 'command -v curl'];

export const COMMAND_LINE_TOOLS_PATH = '/Library/Developer/CommandLineTools';

const ENABLE_LINGER_FIX =
  'Run `loginctl enable-linger "$(id -un)"` on the host. Without it the user manager stops at logout and takes every native runner with it, and grove has no user bus to load a unit into.';

const XCODE_INSTALL_FIX =
  'Install Xcode from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app`. grove never installs Xcode.';

function nativePlaced(context: HostCheckContext): boolean {
  return context.groups.some((group) => group.stack === 'native');
}

// A Linux host with only Docker groups has no user unit, so a missing user
// session costs it nothing today. It is still worth a line, because moving one
// group to stack: native turns this into a failure.
function linuxSeverity(context: HostCheckContext): typeof fail | typeof warn {
  return nativePlaced(context) ? fail : warn;
}

export const systemdUserCheck: Check<HostCheckContext> = {
  id: 'host.systemd-user',
  async run(context) {
    const probe = await context.probe();
    if (isDarwinPlatform(probe.platform)) {
      return [skip('macOS runs launchd, not systemd')];
    }
    // The native stack points systemctl at the user bus this way, and an SSH
    // session is not a login session, so asking without it would report a
    // missing bus on a host whose bus is fine.
    const uid = await context.uid();
    const result = await context.transport.exec(
      'systemctl',
      SYSTEMD_USER_ARGS,
      uid === undefined ? {} : { env: { XDG_RUNTIME_DIR: `/run/user/${uid}` } },
    );
    const state = result.stdout.trim();
    if (SYSTEMD_RUNNING_STATES.includes(state)) {
      return [ok(`the systemd user manager is ${state}`)];
    }
    const message = firstLine(result.stderr) || state || `exit ${result.code}`;
    const severity = linuxSeverity(context);
    if (NO_USER_BUS.test(message)) {
      return [severity(`no systemd user bus: ${message}`, ENABLE_LINGER_FIX)];
    }
    return [
      severity(
        `the systemd user manager answered ${JSON.stringify(message)}`,
        `Run \`systemctl --user is-system-running\` on the host as the SSH user. grove loads every native runner as a systemd user unit, so this has to answer. ${ENABLE_LINGER_FIX}`,
      ),
    ];
  },
};

export const lingeringCheck: Check<HostCheckContext> = {
  id: 'host.lingering',
  async run(context) {
    const probe = await context.probe();
    if (isDarwinPlatform(probe.platform)) {
      return [skip('macOS has no lingering, launchd keeps a GUI agent')];
    }
    const result = await context.transport.exec('sh', LINGER_ARGS);
    const answer = result.stdout.trim();
    if (result.code === 0 && answer.toLowerCase() === 'linger=yes') {
      return [ok('lingering is enabled for the SSH user')];
    }
    return [
      linuxSeverity(context)(
        result.code === 0
          ? `lingering is off (${answer})`
          : `loginctl exited ${result.code}: ${firstLine(result.stderr)}`,
        ENABLE_LINGER_FIX,
      ),
    ];
  },
};

export const launchdCheck: Check<HostCheckContext> = {
  id: 'host.launchd',
  async run(context) {
    const probe = await context.probe();
    if (!isDarwinPlatform(probe.platform)) {
      return [skip('Linux runs systemd, not launchd')];
    }
    const uid = await context.uid();
    if (uid === undefined) {
      return [
        fail(
          '`id -u` printed no uid, so grove cannot name the launchd domain',
          'Check that `id -u` answers on the host for the SSH user. launchd addresses its per-user domain as gui/<uid>, and grove has no other way to name it.',
        ),
      ];
    }
    const result = await context.transport.exec('launchctl', [
      'print',
      `gui/${uid}`,
    ]);
    if (result.code === 0) {
      return [ok(`the launchd domain gui/${uid} answered`)];
    }
    return [
      fail(
        `launchctl print gui/${uid} exited ${result.code}: ${firstLine(result.stderr)}`,
        'Log in to the Mac once and leave the session open. grove loads a runner as a launchd agent in the per-user GUI domain, which exists only while that user has a login session. A Mac that reboots to the login window has no domain to load into.',
      ),
    ];
  },
};

function xcodeNeeded(context: HostCheckContext): boolean {
  return nativePlaced(context);
}

const NO_NATIVE = 'no native group is placed on this host';

export const xcodeSelectCheck: Check<HostCheckContext> = {
  id: 'host.xcode-select',
  async run(context) {
    const probe = await context.probe();
    if (!isDarwinPlatform(probe.platform)) {
      return [skip('Xcode is a macOS matter')];
    }
    if (!xcodeNeeded(context)) {
      return [skip(NO_NATIVE)];
    }
    const selected = await context.transport.exec('xcode-select', ['-p']);
    const path = selected.stdout.trim();
    if (selected.code !== 0 || path === '') {
      return [
        fail(
          `xcode-select -p exited ${selected.code}: ${firstLine(selected.stderr)}`,
          XCODE_INSTALL_FIX,
        ),
      ];
    }
    const present = await context.transport.exec('test', ['-d', path]);
    if (present.code !== 0) {
      return [
        fail(
          `xcode-select points at ${path}, which is not there`,
          `Run \`sudo xcode-select -s /Applications/Xcode.app\` on the host, or reinstall the Xcode that used to be at ${path}.`,
        ),
      ];
    }
    if (path === COMMAND_LINE_TOOLS_PATH) {
      return [
        warn(
          'xcode-select points at the command line tools, not at Xcode',
          'Run `sudo xcode-select -s /Applications/Xcode.app` on the host. The command line tools carry no xcodebuild and no simulators, so an iOS job on this runner fails at the first build step.',
        ),
      ];
    }
    return [ok(path)];
  },
};

export const xcodebuildCheck: Check<HostCheckContext> = {
  id: 'host.xcodebuild',
  async run(context) {
    const probe = await context.probe();
    if (!isDarwinPlatform(probe.platform)) {
      return [skip('Xcode is a macOS matter')];
    }
    if (!xcodeNeeded(context)) {
      return [skip(NO_NATIVE)];
    }
    const result = await context.transport.exec('xcodebuild', ['-version']);
    if (result.code === 0) {
      return [ok(firstLine(result.stdout), { detail: result.stdout.trim() })];
    }
    const message = firstLine(result.stderr) || firstLine(result.stdout);
    const licence = /license/i.test(message);
    return [
      fail(
        message || `xcodebuild exited ${result.code}`,
        licence
          ? 'Run `sudo xcodebuild -license accept` on the host. Until the licence is accepted every xcodebuild invocation fails, including the ones a job makes.'
          : `${XCODE_INSTALL_FIX} Then run \`sudo xcodebuild -license accept\`.`,
      ),
    ];
  },
};

export const simulatorsCheck: Check<HostCheckContext> = {
  id: 'host.simulators',
  async run(context) {
    const probe = await context.probe();
    if (!isDarwinPlatform(probe.platform)) {
      return [skip('simulators are a macOS matter')];
    }
    if (!xcodeNeeded(context)) {
      return [skip(NO_NATIVE)];
    }
    const fix =
      'Open Xcode once and let it install a platform, or run `xcodebuild -downloadPlatform iOS` on the host. A group that only builds macOS targets needs no simulator, which is why this warns rather than fails.';
    const result = await context.transport.exec('xcrun', SIMCTL_ARGS);
    let count = 0;
    try {
      const body = JSON.parse(result.stdout) as {
        devices?: Record<string, { isAvailable?: boolean }[]>;
      };
      for (const list of Object.values(body.devices ?? {})) {
        if (!Array.isArray(list)) {
          continue;
        }
        // `-j` is asked with `available`, so simctl has filtered already and
        // most entries carry no isAvailable at all. Only an explicit false is
        // a device grove should not count.
        count += list.filter((device) => device?.isAvailable !== false).length;
      }
    } catch {
      return [
        warn(
          `simctl printed no device list: ${firstLine(result.stderr) || firstLine(result.stdout)}`,
          fix,
        ),
      ];
    }
    return count === 0
      ? [warn('no simulator runtime is installed', fix)]
      : [ok(`${count} simulator device${count === 1 ? '' : 's'} available`)];
  },
};

export const curlCheck: Check<HostCheckContext> = {
  id: 'host.curl',
  async run(context) {
    // Only the exporter needs curl on a host, and only for a seat that
    // publishes a gitlab-runner metrics port. Two ways to need nothing, and
    // the summary says which one it was, because "no seat publishes a port"
    // sends an operator looking at the wrong half of the config.
    const published = context.groups.some(
      (group) => groupMetricsPort(context.config, group) !== undefined,
    );
    if (!published) {
      return [
        skip('no seat on this host publishes a gitlab-runner metrics port'),
      ];
    }
    if (context.config.metrics === undefined) {
      return [
        skip('metrics.listen is not set, so no seat metrics are re-exported'),
      ];
    }
    const result = await context.transport.exec('sh', CURL_PRESENT_ARGS);
    if (result.code === 0 && result.stdout.trim() !== '') {
      return [ok(`curl is at ${result.stdout.trim()}`)];
    }
    return [
      fail(
        'curl is not on the PATH',
        "Install curl on the host, or drop raw.metrics_port from the groups placed here. grove scrapes each seat's gitlab-runner metrics with curl over the same connection every tick uses, so that the port stays bound to the host's loopback.",
      ),
    ];
  },
};

export const SUPERVISOR_HOST_CHECKS: Check<HostCheckContext>[] = [
  systemdUserCheck,
  lingeringCheck,
  launchdCheck,
  xcodeSelectCheck,
  xcodebuildCheck,
  simulatorsCheck,
  curlCheck,
];
