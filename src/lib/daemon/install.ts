import {
  isDarwinPlatform,
  LINGER_HINT,
  launchctlBootoutArgs,
  launchctlBootstrapArgs,
  launchctlKickstartArgs,
  NO_USER_BUS,
} from '../stack/index.js';
import { firstLine, type Transport } from '../transport/index.js';
import {
  buildDaemonPlist,
  buildDaemonUnit,
  type DaemonUnitSpec,
} from './units.js';

// launchd has already let the job go, which is the state a bootout asks for.
const ALREADY_GONE = /No such process|Could not find|not find service/i;
// The label is already bootstrapped. kickstart still starts it.
const ALREADY_LOADED = /already bootstrapped|Input\/output error/i;
// systemd has no such unit loaded, which is the same answer.
const NO_SUCH_UNIT =
  /Unit .*not (loaded|found)|Unit file .*does not exist|No such unit/i;

export interface DaemonInstallOptions {
  transport: Transport;
  // What `uname -s` answered on the control node.
  platform: string;
  // What `id -u` answered. launchd addresses its per-user domain by it.
  uid?: string;
  spec: DaemonUnitSpec;
}

export interface DaemonInstallResult {
  path: string;
  label: string;
  commands: string[];
}

export function daemonUnitPathFor(
  spec: DaemonUnitSpec,
  platform: string,
): string {
  return isDarwinPlatform(platform) ? spec.plistPath : spec.unitPath;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

async function run(
  options: DaemonInstallOptions,
  commands: string[],
  command: string,
  args: string[],
  what: string,
  tolerate?: RegExp,
): Promise<void> {
  commands.push([command, ...args].join(' '));
  const result = await options.transport.exec(command, args);
  if (result.code === 0 || tolerate?.test(result.stderr) === true) {
    return;
  }
  const detail =
    firstLine(result.stderr) ||
    firstLine(result.stdout) ||
    `exit ${result.code}`;
  const hint = NO_USER_BUS.test(result.stderr) ? ` ${LINGER_HINT}` : '';
  throw new Error(`${what} failed: ${detail}${hint}`);
}

function requireUid(options: DaemonInstallOptions): string {
  if (options.uid === undefined) {
    throw new Error(
      'grove could not read the uid of this user, and launchd addresses its per-user domain by uid',
    );
  }
  return options.uid;
}

export async function installDaemon(
  options: DaemonInstallOptions,
): Promise<DaemonInstallResult> {
  const { spec } = options;
  const commands: string[] = [];
  const path = daemonUnitPathFor(spec, options.platform);

  if (isDarwinPlatform(options.platform)) {
    const uid = requireUid(options);
    // writeFile over SSH is `cat > path` and creates no parent, so the
    // directory is made first, exactly as a native seat's plist is.
    await run(
      options,
      commands,
      'mkdir',
      ['-p', parentOf(path)],
      `creating ${parentOf(path)}`,
    );
    await options.transport.writeFile(path, buildDaemonPlist(spec));
    await run(
      options,
      commands,
      'launchctl',
      launchctlBootoutArgs(uid, spec.label),
      `launchctl bootout ${spec.label}`,
      ALREADY_GONE,
    );
    await run(
      options,
      commands,
      'launchctl',
      launchctlBootstrapArgs(uid, path),
      `launchctl bootstrap ${spec.label}`,
      ALREADY_LOADED,
    );
    // No -k. RunAtLoad has already started it, and a restart here would kill
    // a daemon that is milliseconds old.
    await run(
      options,
      commands,
      'launchctl',
      launchctlKickstartArgs(uid, spec.label, false),
      `launchctl kickstart ${spec.label}`,
    );
    return { path, label: spec.label, commands };
  }

  await run(
    options,
    commands,
    'mkdir',
    ['-p', parentOf(path)],
    `creating ${parentOf(path)}`,
  );
  await options.transport.writeFile(path, buildDaemonUnit(spec));
  await run(
    options,
    commands,
    'systemctl',
    ['--user', 'daemon-reload'],
    'systemctl --user daemon-reload',
  );
  // enable as well as start, so lingering brings the daemon back after a
  // reboot without anybody logging in.
  await run(
    options,
    commands,
    'systemctl',
    ['--user', 'enable', '--now', spec.unit],
    `systemctl --user enable --now ${spec.unit}`,
  );
  return { path, label: spec.unit, commands };
}

export async function uninstallDaemon(
  options: DaemonInstallOptions,
): Promise<DaemonInstallResult> {
  const { spec } = options;
  const commands: string[] = [];
  const path = daemonUnitPathFor(spec, options.platform);

  if (isDarwinPlatform(options.platform)) {
    const uid = requireUid(options);
    await run(
      options,
      commands,
      'launchctl',
      launchctlBootoutArgs(uid, spec.label),
      `launchctl bootout ${spec.label}`,
      ALREADY_GONE,
    );
    await run(options, commands, 'rm', ['-f', path], `removing ${path}`);
    return { path, label: spec.label, commands };
  }

  await run(
    options,
    commands,
    'systemctl',
    ['--user', 'disable', '--now', spec.unit],
    `systemctl --user disable ${spec.unit}`,
    NO_SUCH_UNIT,
  );
  await run(options, commands, 'rm', ['-f', path], `removing ${path}`);
  await run(
    options,
    commands,
    'systemctl',
    ['--user', 'daemon-reload'],
    'systemctl --user daemon-reload',
  );
  return { path, label: spec.unit, commands };
}

/**
 * Whether the file the supervisor reads is there. That is a weaker question
 * than whether the daemon is running, and the lockfile answers the stronger
 * one, so the two are reported side by side rather than conflated.
 */
export async function readDaemonInstalled(
  options: DaemonInstallOptions,
): Promise<boolean> {
  const path = daemonUnitPathFor(options.spec, options.platform);
  const result = await options.transport.exec('test', ['-f', path]);
  return result.code === 0;
}
