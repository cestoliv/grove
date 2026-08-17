import { posix } from 'node:path';
import {
  DAEMON_LABEL,
  DAEMON_UNIT,
  daemonPlistPath,
  daemonUnitPath,
} from '../naming.js';
import {
  escapeXml,
  plistString,
  systemdEnvironment,
  systemdQuoted,
  systemdSpecifiers,
} from '../unit-format.js';
import { DAEMON_STDERR_FILE, DAEMON_STDOUT_FILE } from './paths.js';

// launchd and a non-login systemd user session both hand a job a minimal
// PATH. grove shells out to ssh, docker, launchctl and systemctl, and a
// daemon that cannot find ssh looks exactly like a fleet that is down.
export const DAEMON_PATH =
  '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';

// Long enough that a daemon failing on a bad credential does not spin, short
// enough that a transient failure costs one tick at most.
export const DAEMON_RESTART_SECONDS = 10;

export interface DaemonCommand {
  execPath: string;
  args: string[];
}

/**
 * What the supervisor executes. Both paths are absolute and neither is a
 * shell string, because a supervisor resolves nothing: there is no PATH
 * lookup for `node`, no working directory for `./dist/grove.js`, and no shell
 * to split a command line.
 */
export function resolveDaemonCommand(input: {
  execPath: string;
  script: string;
  configPath: string;
}): DaemonCommand {
  for (const [what, value] of [
    ['the node binary', input.execPath],
    ['the grove script', input.script],
    ['the config path', input.configPath],
  ] as const) {
    if (!value.startsWith('/')) {
      throw new Error(
        `${what} must be an absolute path for a launchd agent or a systemd unit, and grove resolved "${value}"`,
      );
    }
  }
  // A source checkout runs `src/grove.ts` under tsx, and the plain node the
  // supervisor invokes cannot load it. The daemon would then die on every
  // restart, which reads as a broken fleet rather than a bad install.
  if (!input.script.endsWith('.js')) {
    throw new Error(
      `the grove script must be built JavaScript, and grove resolved "${input.script}". Install grove with npm, then run \`grove daemon install\` from the installed binary.`,
    );
  }
  return {
    execPath: input.execPath,
    args: [input.script, 'daemon', 'run', '--config', input.configPath],
  };
}

export interface DaemonSpecInput {
  home: string;
  stateDir: string;
  configPath: string;
  execPath: string;
  script: string;
  env?: Record<string, string>;
}

export interface DaemonUnitSpec {
  label: string;
  unit: string;
  command: DaemonCommand;
  plistPath: string;
  unitPath: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  env: Record<string, string>;
  restartSeconds: number;
}

export function buildDaemonSpec(input: DaemonSpecInput): DaemonUnitSpec {
  return {
    label: DAEMON_LABEL,
    unit: DAEMON_UNIT,
    command: resolveDaemonCommand(input),
    plistPath: daemonPlistPath(input.home),
    unitPath: daemonUnitPath(input.home),
    workingDirectory: input.stateDir,
    stdoutPath: posix.join(input.stateDir, DAEMON_STDOUT_FILE),
    stderrPath: posix.join(input.stateDir, DAEMON_STDERR_FILE),
    env: {
      PATH: DAEMON_PATH,
      // Always written, so an installed daemon reads the same directory the
      // installing shell did even when launchd's environment differs.
      GROVE_STATE_DIR: input.stateDir,
      ...input.env,
    },
    restartSeconds: DAEMON_RESTART_SECONDS,
  };
}

export function buildDaemonPlist(spec: DaemonUnitSpec): string {
  const args = [spec.command.execPath, ...spec.command.args]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join('\n');
  const environment = Object.entries(spec.env)
    .map(
      ([name, value]) =>
        `    <key>${escapeXml(name)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    plistString('Label', spec.label),
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    plistString('WorkingDirectory', spec.workingDirectory),
    plistString('StandardOutPath', spec.stdoutPath),
    plistString('StandardErrorPath', spec.stderrPath),
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // The daemon is the one grove job a supervisor may resurrect. A runner
    // never is, because grove owns crash recovery for runners and nothing
    // may bring one back behind its back.
    '  <key>KeepAlive</key>',
    '  <true/>',
    // Stated rather than inherited. launchd's default happens to be ten
    // seconds, and the README promises ten seconds on both platforms, so the
    // promise should not depend on a platform default staying put.
    '  <key>ThrottleInterval</key>',
    `  <integer>${spec.restartSeconds}</integer>`,
    // A control loop that sleeps most of the time has no claim on the
    // foreground scheduler, unlike the runners it supervises.
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    environment,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function buildDaemonUnit(spec: DaemonUnitSpec): string {
  const exec = [spec.command.execPath, ...spec.command.args]
    .map(systemdQuoted)
    .join(' ');
  return [
    '[Unit]',
    `Description=${systemdSpecifiers('grove control loop')}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${systemdQuoted(spec.workingDirectory)}`,
    `ExecStart=${exec}`,
    // grove owns crash recovery for runners. systemd owns it for grove.
    'Restart=on-failure',
    `RestartSec=${spec.restartSeconds}`,
    // No StandardOutput redirect. The journal already holds it, and the
    // daemon writes its own append-only log either way.
    ...Object.entries(spec.env).map(([name, value]) =>
      systemdEnvironment(name, value),
    ),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
