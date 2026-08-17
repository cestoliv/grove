import { describe, expect, it } from 'vitest';
import type { GroupConfig, HostConfig } from '../config/index.js';
import { buildNativeRunnerSpec } from './native-args.js';
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  escapeXml,
  LAUNCHCTL_LIST_ARGS,
  launchctlBootoutArgs,
  launchctlBootstrapArgs,
  launchctlKickstartArgs,
  parseLaunchctlList,
  parseSystemctlList,
  SYSTEMCTL_LIST_ARGS,
} from './native-units.js';

const host = { type: 'local', work_root: '/Volumes/ci/grove' } as HostConfig;

function spec(overrides: Partial<GroupConfig> = {}, platform = 'Darwin') {
  return buildNativeRunnerSpec({
    group: {
      name: 'ios',
      forge: 'gh-overload',
      scope: { level: 'organization', target: 'Overload-coach' },
      placement: { mac: 1 },
      stack: 'native',
      labels: ['macos'],
      ...overrides,
    } as GroupConfig,
    host,
    index: 1,
    home: '/Users/olivier',
    registration: {
      token: 'AABBCC',
      url: 'https://github.com/Overload-coach',
    },
    platform,
    hostArch: 'arm64',
    version: '2.328.0',
  });
}

describe('escapeXml', () => {
  it('escapes what a path or an environment value can legally contain', () => {
    expect(escapeXml('a & b < c > d "e" \'f\'')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;',
    );
  });
});

describe('buildLaunchdPlist', () => {
  const plist = buildLaunchdPlist(spec());

  it('runs bin/runsvc.sh out of the install dir at load', () => {
    expect(plist).toContain(
      '<key>Label</key>\n  <string>com.cestoliv.grove.ios-1</string>',
    );
    // runsvc.sh is the entry point upstream's own plist template names. It
    // traps SIGTERM and sends the listener SIGINT, which is the unbounded
    // finish-the-job drain. run.sh traps nothing.
    expect(plist).toContain(
      '<string>/Volumes/ci/grove/ios-1-runner/bin/runsvc.sh</string>',
    );
    expect(plist).not.toContain('/ios-1-runner/run.sh');
    expect(plist).toContain(
      '<key>WorkingDirectory</key>\n  <string>/Volumes/ci/grove/ios-1-runner</string>',
    );
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
  });

  it('redirects both streams into files grove can tail', () => {
    expect(plist).toContain(
      '<key>StandardOutPath</key>\n  <string>/Volumes/ci/grove/ios-1-runner/stdout.log</string>',
    );
    expect(plist).toContain(
      '<key>StandardErrorPath</key>\n  <string>/Volumes/ci/grove/ios-1-runner/stderr.log</string>',
    );
  });

  it('carries no KeepAlive, because grove owns crash recovery', () => {
    expect(plist).not.toContain('KeepAlive');
  });

  it('asks launchd not to throttle the job, because a build is the workload', () => {
    expect(plist).toContain(
      '<key>ProcessType</key>\n  <string>Interactive</string>',
    );
  });

  it('tells the runner it runs as a service, and lets no raw.env unset that', () => {
    expect(plist).toContain(
      '<key>ACTIONS_RUNNER_SVC</key>\n    <string>1</string>',
    );
    const built = buildLaunchdPlist(
      spec({
        raw: { env: { ACTIONS_RUNNER_SVC: '0' } },
      } as Partial<GroupConfig>),
    );
    expect(built).toContain(
      '<key>ACTIONS_RUNNER_SVC</key>\n    <string>1</string>',
    );
    expect(built).not.toContain('<string>0</string>');
  });

  it('writes the environment, escaping anything XML would eat', () => {
    const built = buildLaunchdPlist(
      spec({ raw: { env: { NOTE: 'a & b' } } } as Partial<GroupConfig>),
    );
    expect(built).toContain('<key>PATH</key>');
    expect(built).toContain('<key>NOTE</key>\n    <string>a &amp; b</string>');
  });

  it('opens with the plist declaration Apple expects', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(
      true,
    );
    expect(plist).toContain('<!DOCTYPE plist PUBLIC');
    expect(plist.endsWith('</plist>\n')).toBe(true);
  });

  it('gives launchd the drain timeout as ExitTimeOut, since its default would SIGKILL a draining job', () => {
    expect(plist).toContain('<key>ExitTimeOut</key>\n  <integer>120</integer>');
    expect(
      buildLaunchdPlist(
        spec({ drain_timeout: 300_000 } as Partial<GroupConfig>),
      ),
    ).toContain('<key>ExitTimeOut</key>\n  <integer>300</integer>');
  });
});

describe('buildSystemdUnit', () => {
  const unit = buildSystemdUnit(spec({}, 'Linux'));

  it('runs bin/runsvc.sh as a simple service that nothing restarts', () => {
    expect(unit).toContain('Type=simple');
    expect(unit).toContain(
      'ExecStart="/Volumes/ci/grove/ios-1-runner/bin/runsvc.sh"',
    );
    expect(unit).toContain('WorkingDirectory="/Volumes/ci/grove/ios-1-runner"');
    expect(unit).toContain('Restart=no');
  });

  it('signals only the entry point, so the trap is what reaches the listener', () => {
    // Without KillMode=process systemd signals the whole cgroup, which hits
    // the listener, the worker and the job's own children at once.
    expect(unit).toContain('KillMode=process');
  });

  it('gives systemd the drain timeout as its own stop timeout', () => {
    expect(unit).toContain('TimeoutStopSec=120');
    expect(
      buildSystemdUnit(
        spec({ drain_timeout: 300_000 } as Partial<GroupConfig>, 'Linux'),
      ),
    ).toContain('TimeoutStopSec=300');
  });

  it('quotes every environment value and escapes a quote inside one', () => {
    const built = buildSystemdUnit(
      spec(
        { raw: { env: { NOTE: 'say "hi"' } } } as Partial<GroupConfig>,
        'Linux',
      ),
    );
    expect(built).toContain(
      'Environment="PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"',
    );
    expect(built).toContain('Environment="NOTE=say \\"hi\\""');
  });

  it('installs into the default user target so lingering brings it back', () => {
    expect(unit).toContain('[Install]\nWantedBy=default.target\n');
  });

  it('does not carry After=network-online.target, a no-op in a user manager', () => {
    expect(unit).not.toContain('network-online.target');
  });

  it('quotes ExecStart and WorkingDirectory, escaping a literal % before the quote escaping', () => {
    const built = buildSystemdUnit(
      spec(
        { work_root: '/Volumes/ci/100% grove path' } as Partial<GroupConfig>,
        'Linux',
      ),
    );
    expect(built).toContain(
      'WorkingDirectory="/Volumes/ci/100%% grove path/ios-1-runner"',
    );
    expect(built).toContain(
      'ExecStart="/Volumes/ci/100%% grove path/ios-1-runner/bin/runsvc.sh"',
    );
  });

  it('doubles a % in Description and escapes nothing else, since it is unquoted', () => {
    const built = buildSystemdUnit(
      spec({ name: 'i"o%s' } as Partial<GroupConfig>, 'Linux'),
    );
    expect(built).toContain('Description=grove runner grove-i"o%%s-1\n');
  });
});

describe('the launchctl argument lists', () => {
  it('addresses the per-user domain by uid', () => {
    expect(LAUNCHCTL_LIST_ARGS).toEqual(['list']);
    expect(launchctlBootstrapArgs('501', '/Users/olivier/x.plist')).toEqual([
      'bootstrap',
      'gui/501',
      '/Users/olivier/x.plist',
    ]);
    expect(launchctlBootoutArgs('501', 'com.cestoliv.grove.ios-1')).toEqual([
      'bootout',
      'gui/501/com.cestoliv.grove.ios-1',
    ]);
    expect(launchctlKickstartArgs('501', 'com.cestoliv.grove.ios-1')).toEqual([
      'kickstart',
      '-k',
      'gui/501/com.cestoliv.grove.ios-1',
    ]);
    // -k SIGKILLs a running job, so the create path asks for a plain start.
    expect(
      launchctlKickstartArgs('501', 'com.cestoliv.grove.ios-1', false),
    ).toEqual(['kickstart', 'gui/501/com.cestoliv.grove.ios-1']);
  });
});

describe('parseLaunchctlList', () => {
  it('reads a running seat, a stopped seat, and nothing else', () => {
    const text = [
      'PID\tStatus\tLabel',
      '4242\t0\tcom.cestoliv.grove.ios-1',
      '-\t0\tcom.cestoliv.grove.ios-2',
      '-\t78\tcom.cestoliv.grove.ios-3',
      '901\t0\tcom.apple.Finder',
      '-\t0\tcom.cestoliv.grove.daemon',
      '',
    ].join('\n');

    expect(parseLaunchctlList(text)).toEqual([
      {
        name: 'grove-ios-1',
        unit: 'com.cestoliv.grove.ios-1',
        state: 'running',
        pid: 4242,
        detail: 'pid 4242',
      },
      {
        name: 'grove-ios-2',
        unit: 'com.cestoliv.grove.ios-2',
        state: 'stopped',
        detail: 'last exit 0',
      },
      {
        name: 'grove-ios-3',
        unit: 'com.cestoliv.grove.ios-3',
        state: 'stopped',
        detail: 'last exit 78',
      },
    ]);
  });

  it('answers empty for output it cannot read', () => {
    expect(parseLaunchctlList('')).toEqual([]);
    expect(parseLaunchctlList('nonsense\n')).toEqual([]);
  });
});

describe('parseSystemctlList', () => {
  it('reads the active and sub state of every grove unit', () => {
    const text = [
      'grove-ios-1.service loaded active running grove runner grove-ios-1',
      'grove-ios-2.service loaded inactive dead grove runner grove-ios-2',
      'grove-ios-3.service loaded failed failed grove runner grove-ios-3',
      'grove-daemon.service loaded active running grove daemon',
      '',
    ].join('\n');

    expect(parseSystemctlList(text)).toEqual([
      {
        name: 'grove-ios-1',
        unit: 'grove-ios-1.service',
        state: 'running',
        detail: 'active running',
      },
      {
        name: 'grove-ios-2',
        unit: 'grove-ios-2.service',
        state: 'stopped',
        detail: 'inactive dead',
      },
      {
        name: 'grove-ios-3',
        unit: 'grove-ios-3.service',
        state: 'stopped',
        detail: 'failed failed',
      },
    ]);
  });

  it('drops a unit whose file is gone, and asks for the plain listing', () => {
    expect(
      parseSystemctlList('grove-ios-9.service not-found inactive dead\n'),
    ).toEqual([]);
    expect(SYSTEMCTL_LIST_ARGS).toEqual([
      '--user',
      'list-units',
      '--type=service',
      '--all',
      '--no-legend',
      '--plain',
      'grove-*.service',
    ]);
  });
});
