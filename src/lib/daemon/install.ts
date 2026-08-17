import {
  isDarwinPlatform,
  LINGER_HINT,
  launchctlBootoutArgs,
  launchctlBootstrapArgs,
  launchctlKickstartArgs,
  launchctlPrintArgs,
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
const ALREADY_LOADED = /already bootstrapped/i;
// What launchd answers while it is still tearing a label down. It is not
// "already loaded", and reading it that way leaves the daemon installed and
// never running, so grove waits and asks again instead.
const TEARING_DOWN = /Input\/output error/i;
// systemd has no such unit loaded, which is the same answer.
const NO_SUCH_UNIT =
  /Unit .*not (loaded|found)|Unit file .*does not exist|No such unit/i;

// `launchctl bootout` returns before launchd has finished with the label, and
// a bootstrap that lands in that window fails. Two seconds of polling covers
// a daemon that is exiting, and the bootstrap retries past it anyway.
const UNLOAD_TRIES = 20;
const POLL_INTERVAL_MS = 100;
const BOOTSTRAP_TRIES = 5;

export interface DaemonInstallOptions {
  transport: Transport;
  // What `uname -s` answered on the control node.
  platform: string;
  // What `id -u` answered. launchd addresses its per-user domain by it.
  uid?: string;
  spec: DaemonUnitSpec;
  // Only a test sets this. It is what keeps the polling paths from taking
  // real seconds.
  sleep?: (ms: number) => Promise<void>;
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

function sleeper(options: DaemonInstallOptions): (ms: number) => Promise<void> {
  return (
    options.sleep ??
    ((ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }))
  );
}

// Whether launchd still holds the label in the domain. `launchctl print`
// changes nothing and exits non-zero once the label is gone.
async function isLoaded(
  options: DaemonInstallOptions,
  commands: string[],
  uid: string,
): Promise<boolean> {
  const args = launchctlPrintArgs(uid, options.spec.label);
  commands.push(['launchctl', ...args].join(' '));
  const result = await options.transport.exec('launchctl', args);
  return result.code === 0;
}

// What the operator does when launchd will not take the plist from grove.
// The message names the file and the exact command, because the error launchd
// prints to a bootstrap it refuses is the only thing that explains why.
function bootstrapHelp(uid: string, path: string): string {
  return `The plist is at ${path}. Run "launchctl bootstrap gui/${uid} ${path}" by hand to read what launchd says about it.`;
}

/**
 * The gap between a bootout that has returned and a label launchd has let go
 * of. grove waits it out rather than bootstrapping into it.
 *
 * Answers whether the label went. A false answer is what tells the bootstrap
 * that an "already bootstrapped" is the old job rather than a race grove lost
 * by a hair, and those two need opposite handling.
 */
async function waitForUnload(
  options: DaemonInstallOptions,
  commands: string[],
  uid: string,
): Promise<boolean> {
  const wait = sleeper(options);
  for (let attempt = 1; attempt <= UNLOAD_TRIES; attempt += 1) {
    if (!(await isLoaded(options, commands, uid))) {
      return true;
    }
    if (attempt < UNLOAD_TRIES) {
      await wait(POLL_INTERVAL_MS);
    }
  }
  return false;
}

async function bootstrap(
  options: DaemonInstallOptions,
  commands: string[],
  uid: string,
  path: string,
  unloaded: boolean,
): Promise<void> {
  const wait = sleeper(options);
  const args = launchctlBootstrapArgs(uid, path);
  const { label } = options.spec;
  for (let attempt = 1; attempt <= BOOTSTRAP_TRIES; attempt += 1) {
    commands.push(['launchctl', ...args].join(' '));
    const result = await options.transport.exec('launchctl', args);
    if (result.code === 0) {
      return;
    }
    if (ALREADY_LOADED.test(result.stderr)) {
      // Whose job holds the label decides what this answer means. grove saw
      // the old one go, so the only job that can hold it now is the one this
      // bootstrap raced, and kickstart starts it either way. If the old job
      // never went, launchd is still running the plist grove replaced, and
      // reporting a load here is how an upgrade silently keeps the old
      // version.
      if (unloaded) {
        return;
      }
      throw new Error(
        `launchctl bootstrap ${label} failed: launchd still holds the job it had before this install, so it is running the plist grove replaced rather than the new one. ${bootstrapHelp(uid, path)}`,
      );
    }
    const detail =
      firstLine(result.stderr) ||
      firstLine(result.stdout) ||
      `exit ${result.code}`;
    if (!TEARING_DOWN.test(result.stderr)) {
      throw new Error(`launchctl bootstrap ${label} failed: ${detail}`);
    }
    if (attempt === BOOTSTRAP_TRIES) {
      throw new Error(
        `launchctl bootstrap ${label} failed ${BOOTSTRAP_TRIES} times: ${detail}. launchd is still holding the old job. ${bootstrapHelp(uid, path)}`,
      );
    }
    await wait(POLL_INTERVAL_MS);
  }
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
    const unloaded = await waitForUnload(options, commands, uid);
    await bootstrap(options, commands, uid, path, unloaded);
    // No -k. RunAtLoad has already started it, and a restart here would kill
    // a daemon that is milliseconds old.
    await run(
      options,
      commands,
      'launchctl',
      launchctlKickstartArgs(uid, spec.label, false),
      `launchctl kickstart ${spec.label}`,
    );
    // Reporting a load grove has not seen is how an install leaves a control
    // node with a plist on disk and nothing watching the fleet.
    if (!(await isLoaded(options, commands, uid))) {
      throw new Error(
        `launchd did not load ${spec.label}, so nothing is watching the fleet. ${bootstrapHelp(uid, path)}`,
      );
    }
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
