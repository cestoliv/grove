import { posix } from 'node:path';
import {
  type ExecResult,
  firstLine,
  shellQuote,
  type Transport,
} from '../transport/index.js';
import {
  buildConfigArgs,
  buildDownloadArgs,
  buildExtractArgs,
  type NativeRunnerSpec,
  type NativeTarget,
} from './native-args.js';
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  LAUNCHCTL_LIST_ARGS,
  launchctlBootoutArgs,
  launchctlBootstrapArgs,
  launchctlKickstartArgs,
  parseLaunchctlList,
  parseSystemctlList,
  SYSTEMCTL_LIST_ARGS,
} from './native-units.js';
import { type NativeUnit, StackError } from './types.js';

export const LINGER_HINT =
  'Run "loginctl enable-linger" on the host so its systemd user session exists without a login.';

// launchd keeps the job loaded after bootout returns, so grove asks again
// rather than trusting one answer.
const DEFAULT_POLL_INTERVAL_MS = 1000;

// How long grove keeps polling past the drain it asked for. launchd sends
// SIGKILL at the plist's ExitTimeOut, which is that same drain, so a job still
// listed well after it has stopped being a job launchd is willing to let go.
const DEFAULT_STOP_GRACE_MS = 5000;

// launchd has already let the job go. That is the state grove asked for.
const ALREADY_GONE = /No such process|Could not find|not find service/i;
// The label is already bootstrapped in this domain. kickstart still starts it.
const ALREADY_LOADED = /already bootstrapped|Input\/output error/i;
// systemd has no such unit loaded, which is the same answer. Anchored on
// systemd's own phrasings, so an unrelated failure whose message happens to
// contain "not found" is still a failure.
const NO_SUCH_UNIT =
  /Unit .*not (loaded|found)|Unit file .*does not exist|No such unit/i;
// The user bus is missing, which is what lingering fixes.
export const NO_USER_BUS = /Failed to connect to bus|XDG_RUNTIME_DIR/i;

export interface NativeStackOptions {
  transport: Transport;
  host: string;
  // What `uname -s` answered on the host.
  platform: string;
  // What `id -u` answered. launchd addresses its per-user domain by it, and
  // systemd needs it in XDG_RUNTIME_DIR when grove arrives over SSH.
  uid?: string;
  pollIntervalMs?: number;
  // Only a test sets this. It is what keeps the stop-timeout path from taking
  // five real seconds.
  stopGraceMs?: number;
}

export interface NativeLogsOptions {
  tail?: number;
  follow?: boolean;
  onChunk: (chunk: string) => void;
}

export interface PrepareNativeDirsOptions {
  wipeWork: boolean;
  wipeInstall: boolean;
}

// Every call that goes through `run` buffers its output and turns a failure
// into a StackError. The two log readers stream instead, so they call the
// transport directly.
interface RunOptions {
  cwd?: string;
  tolerate?: RegExp;
}

// What `uname -s` answers on a Mac. Every caller that decides between launchd
// and systemd asks this one question, so no two of them can disagree.
export function isDarwinPlatform(platform: string | undefined): boolean {
  return (platform ?? '').trim().toLowerCase() === 'darwin';
}

export async function readUid(
  transport: Transport,
): Promise<string | undefined> {
  try {
    const result = await transport.exec('id', ['-u']);
    const uid = result.stdout.trim();
    return result.code === 0 && /^\d+$/.test(uid) ? uid : undefined;
  } catch {
    // The uid is a convenience, and a host that cannot answer is caught by
    // the probe that runs beside this one.
    return undefined;
  }
}

function assertWorkDir(target: NativeTarget): void {
  const suffix = `/${target.group}-${target.index}`;
  if (!target.workDir.startsWith('/') || !target.workDir.endsWith(suffix)) {
    throw new Error(
      `refusing to wipe ${target.workDir}: it is not the work directory of ${target.name}`,
    );
  }
}

function assertInstallDir(target: NativeTarget): void {
  const suffix = `/${target.group}-${target.index}-runner`;
  if (
    !target.installDir.startsWith('/') ||
    !target.installDir.endsWith(suffix)
  ) {
    throw new Error(
      `refusing to wipe ${target.installDir}: it is not the install directory of ${target.name}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class NativeStack {
  readonly host: string;
  readonly darwin: boolean;

  private readonly transport: Transport;
  private readonly uid?: string;
  private readonly pollIntervalMs: number;
  private readonly stopGraceMs: number;

  constructor(options: NativeStackOptions) {
    this.transport = options.transport;
    this.host = options.host;
    this.darwin = isDarwinPlatform(options.platform);
    this.uid = options.uid;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  private requireUid(): string {
    if (this.uid === undefined) {
      throw new StackError(
        `${this.host}: grove could not read the uid of the runner user, and launchd addresses its per-user domain by uid`,
        this.host,
      );
    }
    return this.uid;
  }

  // systemd and journalctl find the user bus through this, and an SSH session
  // that is not a login session does not set it.
  private userEnv(): Record<string, string> | undefined {
    return this.uid === undefined
      ? undefined
      : { XDG_RUNTIME_DIR: `/run/user/${this.uid}` };
  }

  private async run(
    command: string,
    args: string[],
    what: string,
    options: RunOptions = {},
  ): Promise<ExecResult> {
    const env =
      command === 'systemctl' || command === 'journalctl'
        ? this.userEnv()
        : undefined;
    const result = await this.transport.exec(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(env === undefined ? {} : { env }),
    });
    if (result.code === 0 || options.tolerate?.test(result.stderr) === true) {
      return result;
    }
    // config.sh prints some failures to stdout, so both streams are read.
    const detail =
      firstLine(result.stderr) ||
      firstLine(result.stdout) ||
      `exit ${result.code}`;
    const hint = NO_USER_BUS.test(result.stderr) ? ` ${LINGER_HINT}` : '';
    throw new StackError(
      `${this.host}: ${what} failed: ${detail}${hint}`,
      this.host,
    );
  }

  async listUnits(): Promise<NativeUnit[]> {
    if (this.darwin) {
      const result = await this.run(
        'launchctl',
        LAUNCHCTL_LIST_ARGS,
        'launchctl list',
      );
      return parseLaunchctlList(result.stdout);
    }
    const result = await this.run(
      'systemctl',
      SYSTEMCTL_LIST_ARGS,
      'systemctl --user list-units',
    );
    return parseSystemctlList(result.stdout);
  }

  async prepareDirs(
    target: NativeTarget,
    options: PrepareNativeDirsOptions,
  ): Promise<void> {
    if (options.wipeWork) {
      assertWorkDir(target);
    }
    if (options.wipeInstall) {
      assertInstallDir(target);
    }
    const work = shellQuote(target.workDir);
    const cache = shellQuote(target.cacheDir);
    const install = shellQuote(target.installDir);
    const steps = [
      ...(options.wipeWork ? [`rm -rf ${work}`] : []),
      ...(options.wipeInstall ? [`rm -rf ${install}`] : []),
      `mkdir -p ${work} ${cache} ${install}`,
      // The runner runs as the SSH user itself, and .credentials sits here.
      `chmod 0700 ${install}`,
      // launchd refuses to redirect into a file it cannot open, and on Linux
      // the journal holds the output instead, so this is macOS only.
      ...(this.darwin
        ? [
            `touch ${shellQuote(target.stdoutPath)} ${shellQuote(target.stderrPath)}`,
          ]
        : []),
    ];
    const result = await this.transport.exec('sh', ['-c', steps.join(' && ')]);
    if (result.code !== 0) {
      throw new StackError(
        `${this.host}: cannot prepare ${target.installDir}: ${firstLine(result.stderr) || `exit ${result.code}`}`,
        this.host,
      );
    }
  }

  async install(spec: NativeRunnerSpec): Promise<void> {
    await this.run(
      'curl',
      buildDownloadArgs(spec),
      `downloading actions/runner ${spec.version} for ${spec.os}-${spec.arch}`,
    );
    await this.run('tar', buildExtractArgs(spec), `unpacking ${spec.name}`);
    await this.run('rm', ['-f', spec.tarballPath], `tidying up ${spec.name}`);
    // config.sh resolves its own bin directory relatively and writes .runner
    // beside itself, so it runs from the install dir. The registration token
    // sits in its argument vector, which is why the failure message names
    // only the seat.
    await this.run(
      `${spec.installDir}/config.sh`,
      buildConfigArgs(spec),
      `config.sh for ${spec.name}`,
      { cwd: spec.installDir },
    );
  }

  async create(spec: NativeRunnerSpec): Promise<void> {
    if (this.darwin) {
      const uid = this.requireUid();
      await this.run(
        'mkdir',
        ['-p', posix.dirname(spec.plistPath)],
        `creating ${posix.dirname(spec.plistPath)}`,
      );
      await this.transport.writeFile(spec.plistPath, buildLaunchdPlist(spec));
      // A label left over from an earlier plist would make bootstrap fail, and
      // grove has just rewritten the file underneath it.
      await this.run(
        'launchctl',
        launchctlBootoutArgs(uid, spec.label),
        `launchctl bootout ${spec.label}`,
        { tolerate: ALREADY_GONE },
      );
      // The bootout above returns before launchd has finished unloading a job
      // whose process is still exiting, and the bootstrap then fails with an
      // I/O error. start() has always tolerated that, and so does this.
      await this.run(
        'launchctl',
        launchctlBootstrapArgs(uid, spec.plistPath),
        `launchctl bootstrap ${spec.label}`,
        { tolerate: ALREADY_LOADED },
      );
      // No -k. RunAtLoad has already started the job, and a restart here would
      // SIGKILL a runner that is milliseconds old.
      await this.run(
        'launchctl',
        launchctlKickstartArgs(uid, spec.label, false),
        `launchctl kickstart ${spec.label}`,
      );
      return;
    }
    await this.run(
      'mkdir',
      ['-p', posix.dirname(spec.unitPath)],
      `creating ${posix.dirname(spec.unitPath)}`,
    );
    await this.transport.writeFile(spec.unitPath, buildSystemdUnit(spec));
    await this.run(
      'systemctl',
      ['--user', 'daemon-reload'],
      'systemctl --user daemon-reload',
    );
    await this.run(
      'systemctl',
      ['--user', 'enable', '--now', spec.unit],
      `systemctl --user enable --now ${spec.unit}`,
    );
  }

  async start(target: NativeTarget): Promise<void> {
    if (this.darwin) {
      const uid = this.requireUid();
      await this.run(
        'launchctl',
        launchctlBootstrapArgs(uid, target.plistPath),
        `launchctl bootstrap ${target.label}`,
        { tolerate: ALREADY_LOADED },
      );
      // -k restarts a job that is already running, so one call covers both a
      // loaded-and-idle seat and a seat bootstrap just created.
      await this.run(
        'launchctl',
        launchctlKickstartArgs(uid, target.label),
        `launchctl kickstart ${target.label}`,
      );
      return;
    }
    await this.run(
      'systemctl',
      ['--user', 'start', target.unit],
      `systemctl --user start ${target.unit}`,
    );
  }

  /**
   * `launchctl bootout` and `systemctl stop` both send SIGTERM to the entry
   * point, whose trap turns it into the listener's SIGINT. The listener stops
   * taking work, finishes the job it holds, and exits.
   *
   * grove never kills anything itself. Both supervisors escalate to SIGKILL at
   * the timeout grove wrote into the plist and the unit, and a supervisor kills
   * the whole job rather than the leader a pid names. On macOS grove polls only
   * to learn whether that happened, and reports a failure if it did not.
   */
  async stop(target: NativeTarget, drainTimeoutMs: number): Promise<void> {
    if (this.darwin) {
      const uid = this.requireUid();
      await this.run(
        'launchctl',
        launchctlBootoutArgs(uid, target.label),
        `launchctl bootout ${target.label}`,
        { tolerate: ALREADY_GONE },
      );
      // The drain plus the grace. A zero drain still gets the grace, because
      // ExitTimeOut has a floor of one second and launchd needs a moment to
      // reach it.
      const budgetMs = Math.max(0, drainTimeoutMs) + this.stopGraceMs;
      const deadline = Date.now() + budgetMs;
      for (;;) {
        const units = await this.listUnits();
        const sighting = units.find((unit) => unit.name === target.name);
        // Either the label has gone or launchd is holding it with nothing
        // behind it. The process the drain was waiting on has exited.
        if (sighting === undefined || sighting.pid === undefined) {
          return;
        }
        if (Date.now() >= deadline) {
          break;
        }
        await sleep(this.pollIntervalMs);
      }
      // Reporting a drain here would be a lie, and the caller would go on to
      // delete the install dir under a live runner. A failure leaves the
      // record in place, so the next pass tries again.
      throw new StackError(
        `${this.host}: seat "${target.name}" is still stopping after ${Math.round(budgetMs / 1000)}s; launchd escalates to SIGKILL at ExitTimeOut`,
        this.host,
      );
    }
    if (drainTimeoutMs <= 0) {
      await this.run(
        'systemctl',
        ['--user', 'kill', '--signal=SIGKILL', target.unit],
        `systemctl --user kill ${target.unit}`,
        { tolerate: NO_SUCH_UNIT },
      );
    }
    await this.run(
      'systemctl',
      ['--user', 'stop', target.unit],
      `systemctl --user stop ${target.unit}`,
      { tolerate: NO_SUCH_UNIT },
    );
  }

  async remove(target: NativeTarget): Promise<void> {
    assertInstallDir(target);
    if (this.darwin) {
      const uid = this.requireUid();
      await this.run(
        'launchctl',
        launchctlBootoutArgs(uid, target.label),
        `launchctl bootout ${target.label}`,
        { tolerate: ALREADY_GONE },
      );
      await this.run(
        'rm',
        ['-f', target.plistPath],
        `removing ${target.plistPath}`,
      );
    } else {
      await this.run(
        'systemctl',
        ['--user', 'disable', '--now', target.unit],
        `systemctl --user disable ${target.unit}`,
        { tolerate: NO_SUCH_UNIT },
      );
      await this.run(
        'rm',
        ['-f', target.unitPath],
        `removing ${target.unitPath}`,
      );
      await this.run(
        'systemctl',
        ['--user', 'daemon-reload'],
        'systemctl --user daemon-reload',
      );
    }
    // The credentials the runner registered with die with the forge record
    // grove deletes beside this, so the install dir goes. The work dir stays,
    // exactly as a removed container leaves its work dir behind.
    await this.run(
      'rm',
      ['-rf', target.installDir],
      `removing ${target.installDir}`,
    );
  }

  async logs(
    target: NativeTarget,
    options: NativeLogsOptions,
  ): Promise<number> {
    if (this.darwin) {
      const args = ['-n', String(options.tail ?? 200)];
      if (options.follow === true) {
        args.push('-f');
      }
      args.push(target.stdoutPath, target.stderrPath);
      // Like docker logs, a tail that cannot read a file answers with its own
      // exit code rather than a StackError. The caller decides what a missing
      // log file means.
      const result = await this.transport.exec('tail', args, {
        onStdout: options.onChunk,
        onStderr: options.onChunk,
      });
      return result.code;
    }
    const args = [
      '--user',
      '-u',
      target.unit,
      '-n',
      String(options.tail ?? 200),
      '--no-pager',
    ];
    if (options.follow === true) {
      args.push('-f');
    }
    const env = this.userEnv();
    const result = await this.transport.exec('journalctl', args, {
      ...(env === undefined ? {} : { env }),
      onStdout: options.onChunk,
      onStderr: options.onChunk,
    });
    if (result.code === 127) {
      throw new StackError(
        `${this.host}: journalctl is not installed, so grove cannot read the journal of ${target.unit}. Run "systemctl --user status ${target.unit}", or read the runner's own logs in ${target.diagDir}.`,
        this.host,
      );
    }
    return result.code;
  }
}
