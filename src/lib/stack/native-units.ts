import {
  runnerNameFromLaunchdLabel,
  runnerNameFromSystemdUnit,
} from '../naming.js';
import {
  escapeXml,
  plistString,
  systemdEnvironment,
  systemdQuoted,
  systemdSpecifiers,
} from '../unit-format.js';
import type { NativeRunnerSpec } from './native-args.js';
import type { NativeUnit } from './types.js';

export const LAUNCHCTL_LIST_ARGS = ['list'];

export const SYSTEMCTL_LIST_ARGS = [
  '--user',
  'list-units',
  '--type=service',
  '--all',
  '--no-legend',
  // Without --plain systemd prefixes a failed unit with a bullet, which would
  // shift every column by one.
  '--plain',
  'grove-*.service',
];

export function launchctlBootstrapArgs(
  uid: string,
  plistPath: string,
): string[] {
  return ['bootstrap', `gui/${uid}`, plistPath];
}

export function launchctlBootoutArgs(uid: string, label: string): string[] {
  return ['bootout', `gui/${uid}/${label}`];
}

// The one question launchd answers about a label without changing anything.
// It exits non-zero when the label is not loaded in the domain, which is how
// grove tells a finished bootout from one launchd is still working through.
export function launchctlPrintArgs(uid: string, label: string): string[] {
  return ['print', `gui/${uid}/${label}`];
}

// `-k` restarts a job that is already running, which is what a start wants.
// A create has just bootstrapped the job and RunAtLoad started it, so asking
// for a restart there would SIGKILL a runner that is milliseconds old and can
// leave a stale session at the forge.
export function launchctlKickstartArgs(
  uid: string,
  label: string,
  restart = true,
): string[] {
  return restart
    ? ['kickstart', '-k', `gui/${uid}/${label}`]
    : ['kickstart', `gui/${uid}/${label}`];
}

// The drain timeout in whole seconds, floored at 1. launchd's ExitTimeOut and
// systemd's TimeoutStopSec both take a seconds count, and both supervisors
// need the same number, since it is the same drain grove is honouring on
// either platform.
function exitTimeoutSeconds(drainTimeoutMs: number): number {
  return Math.max(1, Math.round(drainTimeoutMs / 1000));
}

export function buildLaunchdPlist(spec: NativeRunnerSpec): string {
  // The runner reads this to know it was started by a service manager rather
  // than by hand, exactly as upstream's own plist sets it. It goes last, so
  // no raw.env can unset it.
  const environment = Object.entries({
    ...spec.env,
    ACTIONS_RUNNER_SVC: '1',
  })
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
    `    <string>${escapeXml(spec.serviceScript)}</string>`,
    '  </array>',
    plistString('WorkingDirectory', spec.installDir),
    plistString('StandardOutPath', spec.stdoutPath),
    plistString('StandardErrorPath', spec.stderrPath),
    // No KeepAlive. grove owns crash recovery, and its fast tick is what
    // brings a dead runner back, so nothing resurrects one behind its back.
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // launchd's Standard default drops a background job's CPU priority and
    // throttles its I/O. A 40 minute Xcode build is exactly the workload that
    // pays for that, and upstream's own plist asks for Interactive too.
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    // launchd's default ExitTimeOut is 20s and SIGKILLs whatever is still
    // running past it, which would cut a draining job short. The drain
    // timeout is the one grove and the runner agreed to honour instead.
    '  <key>ExitTimeOut</key>',
    `  <integer>${exitTimeoutSeconds(spec.drainTimeoutMs)}</integer>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    environment,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function buildSystemdUnit(spec: NativeRunnerSpec): string {
  const environment = Object.entries(spec.env).map(([name, value]) =>
    systemdEnvironment(name, value),
  );
  return [
    '[Unit]',
    `Description=${systemdSpecifiers(`grove runner ${spec.name}`)}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${systemdQuoted(spec.installDir)}`,
    `ExecStart=${systemdQuoted(spec.serviceScript)}`,
    // grove owns crash recovery, exactly as it does on macOS and in Docker.
    'Restart=no',
    // Without this systemd signals the whole cgroup on stop, so the listener,
    // the worker and the job's own children all get SIGTERM at once. Only the
    // entry point should be signalled, because its trap is what turns that
    // into the listener's unbounded finish-the-job SIGINT.
    'KillMode=process',
    `TimeoutStopSec=${exitTimeoutSeconds(spec.drainTimeoutMs)}`,
    ...environment,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function parseLaunchctlList(text: string): NativeUnit[] {
  const units: NativeUnit[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) {
      continue;
    }
    const [pidField, statusField, label] = fields;
    const name = runnerNameFromLaunchdLabel(label);
    if (name === null) {
      continue;
    }
    const pid = Number(pidField);
    if (Number.isInteger(pid) && pid > 0) {
      units.push({
        name,
        unit: label,
        state: 'running',
        pid,
        detail: `pid ${pid}`,
      });
      continue;
    }
    // launchd keeps a job loaded after it exits and remembers the exit status,
    // which is exactly the crash grove's fast tick is meant to notice.
    units.push({
      name,
      unit: label,
      state: 'stopped',
      detail: `last exit ${statusField}`,
    });
  }
  return units;
}

export function parseSystemctlList(text: string): NativeUnit[] {
  const units: NativeUnit[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) {
      continue;
    }
    const [unit, load, active, sub] = fields;
    const name = runnerNameFromSystemdUnit(unit);
    // A unit whose file is gone is not a seat that exists, whatever systemd
    // still remembers about it.
    if (name === null || load === 'not-found') {
      continue;
    }
    units.push({
      name,
      unit,
      state: active === 'active' && sub === 'running' ? 'running' : 'stopped',
      detail: `${active} ${sub}`,
    });
  }
  return units;
}

// Re-exported so `stack/index.ts` keeps offering the name it always has.
export { escapeXml };
