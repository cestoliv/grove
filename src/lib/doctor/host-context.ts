import type { GroupConfig, GroveConfig, HostConfig } from '../config/index.js';
import { resolveInstallRoot, resolveWorkRoot } from '../naming.js';
import { expandHome } from '../paths.js';
import { HOME_COMMAND } from '../reconcile/index.js';
import {
  type HostStorage,
  readHostStorage,
  readUid,
  seatWorkDirTargets,
  type WorkDirTarget,
} from '../stack/index.js';
import {
  type ExecResult,
  type HostProbe,
  PROBE_TIMEOUT_MS,
  probeHost,
  type Transport,
} from '../transport/index.js';
import { type DiskUsage, dfArgs, parseDf } from './disk.js';

// Which key put the path here. The three root checks read the same host the
// same way for both, and only the words they use differ.
export type RootKind = 'work' | 'install';

export interface WorkRootTarget {
  root: string;
  groups: string[];
  kind: RootKind;
}

/**
 * What the host pass learned, kept because the group checks need it and
 * because asking a host the same question twice over SSH is the whole reason
 * this context exists.
 */
export interface HostFacts {
  host: string;
  reachable: boolean;
  platform?: string;
  arch?: string;
  home?: string;
  uid?: string;
  // Keyed by the expanded work root, so a group check can compare
  // max_work_size against the disk that would hold it.
  freeBytes: Record<string, number>;
  storage?: HostStorage;
}

export interface HostCheckContext {
  host: string;
  hostConfig: HostConfig;
  config: GroveConfig;
  transport: Transport;
  // Every group the config places on this host, in config order.
  groups: GroupConfig[];
  now: () => number;
  probeTimeoutMs: number;
  facts: HostFacts;
  probe(): Promise<HostProbe>;
  home(): Promise<string | undefined>;
  uid(): Promise<string | undefined>;
  // `docker version --format {{.Server.Version}}`, which answers the client
  // question and the daemon question in one call.
  dockerServer(): Promise<ExecResult>;
  disk(root: string): Promise<DiskUsage | undefined>;
  workRoots(): Promise<WorkRootTarget[]>;
  // Every distinct install root a native group places here, minus the ones a
  // work root already covers. Empty unless a group sets install_root.
  installRoots(): Promise<WorkRootTarget[]>;
  seats(): Promise<WorkDirTarget[]>;
  // The image store and the work dirs, in the two reads `status` makes.
  storage(): Promise<HostStorage>;
  once<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface HostContextInput {
  host: string;
  config: GroveConfig;
  transport: Transport;
  now?: () => number;
  probeTimeoutMs?: number;
}

export function hostWorkRoots(
  config: GroveConfig,
  host: string,
  home?: string,
): WorkRootTarget[] {
  const hostConfig = config.hosts[host];
  if (hostConfig === undefined) {
    return [];
  }
  const env =
    home === undefined ? undefined : ({ HOME: home } as NodeJS.ProcessEnv);
  const byRoot = new Map<string, WorkRootTarget>();
  for (const group of config.groups) {
    if (group.placement[host] === undefined) {
      continue;
    }
    const root = expandHome(resolveWorkRoot(hostConfig, group), env);
    const target = byRoot.get(root) ?? { root, groups: [], kind: 'work' };
    target.groups.push(group.name);
    byRoot.set(root, target);
  }
  return [...byRoot.values()];
}

/**
 * The install roots the host also has to hold. A native group that names no
 * install_root installs under its work root, which the work-root targets
 * already carry, so only a group that moved its install off the work root
 * shows up here. That is the macOS case: launchd refuses to execute a program
 * on an external volume, so the runner lives on the boot disk while the work
 * dir stays on the big one.
 */
export function hostInstallRoots(
  config: GroveConfig,
  host: string,
  home?: string,
): WorkRootTarget[] {
  const hostConfig = config.hosts[host];
  if (hostConfig === undefined) {
    return [];
  }
  const env =
    home === undefined ? undefined : ({ HOME: home } as NodeJS.ProcessEnv);
  const covered = new Set(
    hostWorkRoots(config, host, home).map((target) => target.root),
  );
  const byRoot = new Map<string, WorkRootTarget>();
  for (const group of config.groups) {
    if (group.placement[host] === undefined || group.stack !== 'native') {
      continue;
    }
    const root = expandHome(resolveInstallRoot(hostConfig, group), env);
    if (covered.has(root)) {
      continue;
    }
    const target = byRoot.get(root) ?? { root, groups: [], kind: 'install' };
    target.groups.push(group.name);
    byRoot.set(root, target);
  }
  return [...byRoot.values()];
}

export const DOCKER_VERSION_ARGS = [
  'version',
  '--format',
  '{{.Server.Version}}',
];

export function createHostContext(input: HostContextInput): HostCheckContext {
  const { host, config, transport } = input;
  const pending = new Map<string, Promise<unknown>>();
  const facts: HostFacts = { host, reachable: false, freeBytes: {} };

  function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = pending.get(key);
    if (existing !== undefined) {
      return existing as Promise<T>;
    }
    const started = fn();
    pending.set(key, started);
    return started;
  }

  const context: HostCheckContext = {
    host,
    hostConfig: config.hosts[host],
    config,
    transport,
    groups: config.groups.filter(
      (group) => group.placement[host] !== undefined,
    ),
    now: input.now ?? Date.now,
    probeTimeoutMs: input.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
    facts,
    once,
    probe: () =>
      once('probe', async () => {
        const probe = await probeHost(host, transport, context.probeTimeoutMs);
        facts.reachable = probe.reachable;
        if (probe.platform !== undefined) {
          facts.platform = probe.platform;
        }
        if (probe.arch !== undefined) {
          facts.arch = probe.arch;
        }
        return probe;
      }),
    home: () =>
      once('home', async () => {
        try {
          const result = await transport.exec('sh', ['-c', HOME_COMMAND]);
          const answer = result.stdout.trim();
          // Every path grove derives from the home is absolute, and no
          // transport expands a tilde, so anything else is no home at all.
          const home =
            result.code === 0 && answer.startsWith('/') ? answer : undefined;
          if (home !== undefined) {
            facts.home = home;
          }
          return home;
        } catch {
          return undefined;
        }
      }),
    uid: () =>
      once('uid', async () => {
        const uid = await readUid(transport);
        if (uid !== undefined) {
          facts.uid = uid;
        }
        return uid;
      }),
    dockerServer: () =>
      once('docker-server', async () => {
        try {
          return await transport.exec('docker', DOCKER_VERSION_ARGS);
        } catch (error) {
          // A transport that throws is the same answer as a docker that is
          // not there, and the check reads the message either way.
          return {
            code: 127,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    disk: (root: string) =>
      once(`df:${root}`, async () => {
        try {
          const result = await transport.exec('df', dfArgs(root));
          const usage = result.code === 0 ? parseDf(result.stdout) : undefined;
          if (usage !== undefined) {
            facts.freeBytes[root] = usage.freeBytes;
          }
          return usage;
        } catch {
          return undefined;
        }
      }),
    workRoots: async () => hostWorkRoots(config, host, await context.home()),
    installRoots: async () =>
      hostInstallRoots(config, host, await context.home()),
    seats: async () => seatWorkDirTargets(config, host, await context.home()),
    storage: () =>
      once('storage', async () => {
        const storage = await readHostStorage(
          transport,
          host,
          await context.seats(),
          {
            // A host with only native groups on it has no Docker to ask, and
            // asking would turn "no Docker here" into a finding.
            docker: context.groups.some((group) => group.stack === 'docker'),
          },
        );
        facts.storage = storage;
        return storage;
      }),
  };

  return context;
}
