import { join } from 'node:path';
import {
  type GroveConfig,
  isListen,
  isLoopback,
  parseListen,
} from '../config/index.js';
import { daemonPlistPath, daemonUnitPath } from '../naming.js';
import { isDarwinPlatform } from '../stack/index.js';
import {
  META_DAEMON_PID,
  STATE_DB_FILE,
  type StateStore,
} from '../state/index.js';
import { firstLine, type Transport } from '../transport/index.js';
import {
  type CheckReport,
  type CheckResult,
  fail,
  ok,
  skip,
  warn,
} from './types.js';

// package.json's engines floor. node:sqlite is unflagged from 22.13, which is
// the whole reason the floor is not 20.
export const MIN_NODE_VERSION = '22.13.0';

export function meetsNodeVersion(actual: string, required: string): boolean {
  const parse = (value: string): number[] | undefined => {
    const parts = value.replace(/^v/, '').split('.').slice(0, 3);
    const numbers = parts.map((part) => Number.parseInt(part, 10));
    return numbers.length === 3 && numbers.every(Number.isInteger)
      ? numbers
      : undefined;
  };
  const left = parse(actual);
  const right = parse(required);
  if (left === undefined || right === undefined) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }
  return true;
}

export interface ControlCheckContext {
  config: GroveConfig;
  configPath: string;
  // The control node's own transport, which is where a command: credential
  // and every CLI delegation runs.
  transport: Transport;
  platform: string;
  home: string;
  stateDir: string;
  store: StateStore;
  nodeVersion: string;
  isPidAlive: (pid: number) => boolean;
  access: (path: string, mode: number) => Promise<void>;
  stat: (path: string) => Promise<{ mode: number }>;
}

export const CONTROL_CHECK_IDS = [
  'control.node',
  'control.state-dir',
  'control.database-mode',
  'control.ssh',
  'control.cli-delegation',
  'control.daemon',
  'control.metrics-listen',
];

// fs.constants.W_OK, spelled out so this file needs no node:fs import beyond
// the injected access/stat functions the context already carries.
const W_OK = 2;

const NODE_FIX = `Install Node ${MIN_NODE_VERSION} or later and run grove under it. node:sqlite, which grove keeps its history in, is behind a flag before 22.13.`;

const STATE_DIR_FIX =
  'Create the directory and give it to the user grove runs as, or point GROVE_STATE_DIR somewhere writable. grove keeps its history, its log and its lockfile there, and cannot run without it.';

const DATABASE_MODE_FIX =
  'Run `chmod 600 <path>`. The database holds the GitLab runner authentication token, which is no less a secret than an SSH private key.';

const SSH_FIX =
  'grove shells out to the ssh binary rather than speaking the protocol itself, so it needs one on the PATH. Install openssh-client, or move those hosts to type: local.';

const GH_DELEGATION_FIX =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text for the user, not interpolation
  'Install the GitHub CLI and run `gh auth login`, or give the forge an auth block with ${ENV_VAR} or command:.';

const GITLAB_DELEGATION_FIX =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text for the user, not interpolation
  'Install the GitLab CLI and run `glab auth login --hostname <host>`, or give the forge an auth block with ${ENV_VAR} or command:.';

const DAEMON_NOT_INSTALLED_FIX =
  'Run `grove daemon install`. Without it nothing converges the fleet between the times you run `grove apply` by hand, and a crashed runner stays down.';

const DAEMON_NOT_RUNNING_FIX =
  'Check `grove daemon status` and the tail of grove.log. The supervisor restarts the daemon ten seconds after a crash, so a daemon that is installed and not running has usually failed to start every time.';

const METRICS_LISTEN_FIX =
  'Bind 127.0.0.1 and put a reverse proxy or an SSH tunnel in front of it if Prometheus runs elsewhere. The endpoint has no authentication and exposes every group name, host name and job count in the fleet. It exposes no credential.';

const METRICS_LISTEN_INVALID_FIX =
  'Set metrics.listen to an address like 127.0.0.1:9130, with an explicit host.';

export async function runControlChecks(
  context: ControlCheckContext,
): Promise<CheckReport[]> {
  const target = { kind: 'control' as const, name: 'control node' };
  const reports: CheckReport[] = [];
  const push = (id: string, result: CheckResult): void => {
    reports.push({ ...result, id, target });
  };

  push(
    'control.node',
    meetsNodeVersion(context.nodeVersion, MIN_NODE_VERSION)
      ? ok(`Node ${context.nodeVersion}`)
      : fail(
          `Node ${context.nodeVersion} is below ${MIN_NODE_VERSION}`,
          NODE_FIX,
        ),
  );

  try {
    await context.access(context.stateDir, W_OK);
    push('control.state-dir', ok(context.stateDir));
  } catch (error) {
    push(
      'control.state-dir',
      fail(
        `${context.stateDir} is not writable: ${error instanceof Error ? error.message : String(error)}`,
        STATE_DIR_FIX,
      ),
    );
  }

  const dbPath = join(context.stateDir, STATE_DB_FILE);
  try {
    const stats = await context.stat(dbPath);
    const mode = stats.mode & 0o777;
    push(
      'control.database-mode',
      (mode & 0o077) === 0
        ? ok(`grove.db is ${mode.toString(8).padStart(3, '0')}`)
        : warn(
            `grove.db is ${mode.toString(8).padStart(3, '0')}, which other users can read`,
            DATABASE_MODE_FIX.replace('<path>', dbPath),
          ),
    );
  } catch {
    push(
      'control.database-mode',
      skip('there is no grove.db yet, so there is no mode to check'),
    );
  }

  const sshHosts = Object.entries(context.config.hosts).filter(
    ([, host]) => host.type === 'ssh',
  );
  if (sshHosts.length === 0) {
    push('control.ssh', skip('every host in the config is local'));
  } else {
    const result = await context.transport.exec('ssh', ['-V']);
    push(
      'control.ssh',
      result.code === 0
        ? // ssh -V writes its version to stderr and exits 0.
          ok(
            firstLine(result.stderr) ||
              firstLine(result.stdout) ||
              'ssh answered',
          )
        : fail(
            `ssh -V exited ${result.code}: ${firstLine(result.stderr)}`,
            `${SSH_FIX} Declared ssh hosts: ${sshHosts.map(([name]) => name).join(', ')}.`,
          ),
    );
  }

  const delegating = Object.entries(context.config.forges).filter(
    ([, forge]) => forge.auth === undefined,
  );
  if (delegating.length === 0) {
    push(
      'control.cli-delegation',
      skip('every forge carries an auth block, so grove delegates to no CLI'),
    );
  } else {
    for (const [name, forge] of delegating) {
      const cli = forge.kind === 'gitlab' ? 'glab' : 'gh';
      const result = await context.transport.exec('sh', [
        '-c',
        `command -v ${cli}`,
      ]);
      push(
        'control.cli-delegation',
        result.code === 0 && result.stdout.trim() !== ''
          ? ok(`${cli} is at ${result.stdout.trim()}`, { subject: name })
          : fail(
              `forge "${name}" has no auth block and ${cli} is not on the PATH`,
              cli === 'gh' ? GH_DELEGATION_FIX : GITLAB_DELEGATION_FIX,
              { subject: name },
            ),
      );
    }
  }

  const unitPath = isDarwinPlatform(context.platform)
    ? daemonPlistPath(context.home)
    : daemonUnitPath(context.home);
  const installed = await context.transport.exec('test', ['-f', unitPath]);
  const rawPid = context.store.getMeta(META_DAEMON_PID);
  const pid = Number(rawPid);
  const running =
    rawPid !== undefined &&
    Number.isInteger(pid) &&
    pid > 0 &&
    context.isPidAlive(pid);
  push(
    'control.daemon',
    installed.code !== 0
      ? warn(`no unit at ${unitPath}`, DAEMON_NOT_INSTALLED_FIX)
      : running
        ? ok(`installed at ${unitPath}, running as pid ${pid}`)
        : warn(
            `installed at ${unitPath}, and no control loop is running`,
            DAEMON_NOT_RUNNING_FIX,
          ),
  );

  const metrics = context.config.metrics;
  if (metrics === undefined) {
    push(
      'control.metrics-listen',
      skip('metrics.listen is not set, so the exporter is off'),
    );
  } else if (!isListen(metrics.listen)) {
    push(
      'control.metrics-listen',
      fail(
        `metrics.listen "${metrics.listen}" is not a valid address`,
        METRICS_LISTEN_INVALID_FIX,
      ),
    );
  } else {
    const address = parseListen(metrics.listen);
    push(
      'control.metrics-listen',
      isLoopback(address.host)
        ? ok(`the exporter binds ${metrics.listen}`)
        : warn(
            `the exporter binds ${metrics.listen}, which is not loopback`,
            METRICS_LISTEN_FIX,
          ),
    );
  }

  return reports;
}
