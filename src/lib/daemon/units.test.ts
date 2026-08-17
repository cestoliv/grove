import { describe, expect, it } from 'vitest';
import {
  buildDaemonPlist,
  buildDaemonSpec,
  buildDaemonUnit,
  resolveDaemonCommand,
} from './units.js';

function spec() {
  return buildDaemonSpec({
    home: '/Users/olivier',
    stateDir: '/Users/olivier/Library/Application Support/grove',
    configPath: '/Users/olivier/ci/grove.yaml',
    execPath: '/usr/local/bin/node',
    script: '/usr/local/lib/node_modules/@cestoliv/grove/dist/grove.js',
  });
}

describe('resolveDaemonCommand', () => {
  it('runs the daemon subcommand against an explicit config path', () => {
    expect(
      resolveDaemonCommand({
        execPath: '/usr/local/bin/node',
        script: '/opt/grove/dist/grove.js',
        configPath: '/etc/grove.yaml',
      }),
    ).toEqual({
      execPath: '/usr/local/bin/node',
      args: [
        '/opt/grove/dist/grove.js',
        'daemon',
        'run',
        '--config',
        '/etc/grove.yaml',
      ],
    });
  });

  it('refuses a relative path, because a supervisor has no working directory to resolve it against', () => {
    expect(() =>
      resolveDaemonCommand({
        execPath: 'node',
        script: '/opt/grove/dist/grove.js',
        configPath: '/etc/grove.yaml',
      }),
    ).toThrow(/absolute/);
    expect(() =>
      resolveDaemonCommand({
        execPath: '/usr/local/bin/node',
        script: './dist/grove.js',
        configPath: '/etc/grove.yaml',
      }),
    ).toThrow(/absolute/);
  });

  // A tsx source checkout runs `src/grove.ts`, which plain node cannot load.
  // The supervisor would start the daemon and it would die on every restart.
  it('refuses a script that is not built JavaScript', () => {
    expect(() =>
      resolveDaemonCommand({
        execPath: '/usr/local/bin/node',
        script: '/Users/olivier/dev/grove/src/grove.ts',
        configPath: '/etc/grove.yaml',
      }),
    ).toThrow(/install grove with npm/i);
    expect(() =>
      resolveDaemonCommand({
        execPath: '/usr/local/bin/node',
        script: '/Users/olivier/dev/grove/src/grove.ts',
        configPath: '/etc/grove.yaml',
      }),
    ).toThrow(/grove daemon install/);
  });
});

describe('buildDaemonSpec', () => {
  it('derives every path from the home and the state dir', () => {
    const built = spec();
    expect(built.label).toBe('com.cestoliv.grove.daemon');
    expect(built.unit).toBe('grove-daemon.service');
    expect(built.plistPath).toBe(
      '/Users/olivier/Library/LaunchAgents/com.cestoliv.grove.daemon.plist',
    );
    expect(built.unitPath).toBe(
      '/Users/olivier/.config/systemd/user/grove-daemon.service',
    );
    expect(built.stdoutPath).toBe(
      '/Users/olivier/Library/Application Support/grove/daemon.out.log',
    );
    expect(built.env.GROVE_STATE_DIR).toBe(
      '/Users/olivier/Library/Application Support/grove',
    );
    expect(built.env.PATH).toContain('/opt/homebrew/bin');
  });
});

describe('buildDaemonPlist', () => {
  it('names the node binary, the script and the config as separate arguments', () => {
    const plist = buildDaemonPlist(spec());
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>--config</string>');
    expect(plist).toContain('<string>/Users/olivier/ci/grove.yaml</string>');
  });

  // The daemon is the one grove job a supervisor may resurrect. Runners are
  // not, and their plists carry no KeepAlive at all.
  it('asks launchd to keep the daemon alive', () => {
    const plist = buildDaemonPlist(spec());
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain(
      '<string>/Users/olivier/Library/Application Support/grove/daemon.out.log</string>',
    );
  });

  // The README promises a ten second restart cadence on both platforms. The
  // systemd unit states it, so the plist states it too rather than leaning on
  // launchd's default happening to agree.
  it('states the restart throttle rather than inheriting a platform default', () => {
    const plist = buildDaemonPlist(spec());
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<integer>10</integer>');
  });
});

describe('buildDaemonUnit', () => {
  it('restarts on failure and starts with the user session', () => {
    const unit = buildDaemonUnit(spec());
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=10');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/usr/local/lib/node_modules/@cestoliv/grove/dist/grove.js" "daemon" "run" "--config" "/Users/olivier/ci/grove.yaml"',
    );
    expect(unit).toContain('Environment="GROVE_STATE_DIR=');
  });
});
