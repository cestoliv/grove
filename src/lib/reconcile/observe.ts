import type { GroupConfig, GroveConfig, Scope } from '../config/index.js';
import { errorMessage } from '../errors.js';
import type { ForgeClient } from '../forge/index.js';
import {
  buildRunnerDirs,
  checkWorkRootVolume,
  type DockerContainer,
  DockerStack,
  type VolumeCheck,
} from '../stack/index.js';
import { probeHost, type Transport } from '../transport/index.js';
import type {
  ForgeObservation,
  HostObservation,
  ObservedForgeRunner,
  ObservedState,
} from './observed.js';

export const HOME_COMMAND = 'printf %s "$HOME"';

export interface ObserveOptions {
  transports: ReadonlyMap<string, Transport>;
  forgeClients: ReadonlyMap<string, ForgeClient>;
  probeTimeoutMs?: number;
  // Task 18 builds the real limiter (reconcile/limiter.ts) and passes it in
  // so every forge call in a reconcile pass is queued behind one cap. Absent
  // a caller, a listRunners call just runs.
  forgeLimit?: <T>(fn: () => Promise<T>) => Promise<T>;
}

function unreachable(host: string, reason: string): HostObservation {
  return { host, reachable: false, reason, containers: [], workRoots: {} };
}

// A stable dedup key for a scope, so grove lists a scope once even when two
// groups target the same level and target.
function scopeKey(scope: Scope): string {
  return 'target' in scope ? `${scope.level}:${scope.target}` : scope.level;
}

// Groups grove can act on today: Docker stack, GitHub forge, and a forge
// client was built for them.
function manageableGroups(
  config: GroveConfig,
  forgeClients: ReadonlyMap<string, ForgeClient>,
): GroupConfig[] {
  return config.groups.filter(
    (group) =>
      group.stack === 'docker' &&
      config.forges[group.forge]?.kind === 'github' &&
      forgeClients.has(group.forge),
  );
}

async function observeHost(
  name: string,
  config: GroveConfig,
  transport: Transport,
  groups: GroupConfig[],
  probeTimeoutMs?: number,
): Promise<HostObservation> {
  const probe = await probeHost(name, transport, probeTimeoutMs);
  if (!probe.reachable) {
    return unreachable(name, probe.reason ?? 'unreachable');
  }

  // One try/catch for everything past the probe. A rejection from any exec
  // here (home read, docker ps, or a stat behind the volume guard) means
  // grove cannot trust what it saw on this host, which is exactly when
  // deleting a forge record would be wrong. Other hosts stay unaffected,
  // because each runs through its own observeHost call.
  try {
    const homeResult = await transport.exec('sh', ['-c', HOME_COMMAND]);
    const home =
      homeResult.code === 0 && homeResult.stdout.trim() !== ''
        ? homeResult.stdout.trim()
        : undefined;

    const stack = new DockerStack({ transport, host: name });
    const containers: DockerContainer[] = await stack.listContainers();

    const workRoots: Record<string, VolumeCheck> = {};
    for (const group of groups) {
      const dirs = buildRunnerDirs({
        group,
        host: config.hosts[name],
        index: 1,
        home,
      });
      workRoots[group.name] = await checkWorkRootVolume(
        transport,
        probe.platform ?? 'Linux',
        dirs.workDir,
      );
    }

    return {
      host: name,
      reachable: true,
      ...(probe.platform === undefined ? {} : { platform: probe.platform }),
      ...(probe.arch === undefined ? {} : { arch: probe.arch }),
      ...(home === undefined ? {} : { home }),
      containers,
      workRoots,
    };
  } catch (error) {
    return unreachable(name, errorMessage(error));
  }
}

async function observeForge(
  name: string,
  client: ForgeClient,
  scopes: Scope[],
  forgeLimit: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<ForgeObservation> {
  const runners: ObservedForgeRunner[] = [];
  const seen = new Set<string>();
  try {
    for (const scope of scopes) {
      for (const runner of await forgeLimit(() => client.listRunners(scope))) {
        if (seen.has(runner.id)) {
          continue;
        }
        seen.add(runner.id);
        runners.push({ runner, scope });
      }
    }
  } catch (error) {
    return {
      forge: name,
      reachable: false,
      reason: errorMessage(error),
      runners: [],
    };
  }
  return { forge: name, reachable: true, runners };
}

export async function observeFleet(
  config: GroveConfig,
  options: ObserveOptions,
): Promise<ObservedState> {
  const groups = manageableGroups(config, options.forgeClients);
  const forgeLimit = options.forgeLimit ?? (<T>(fn: () => Promise<T>) => fn());

  const groupsByHost = new Map<string, GroupConfig[]>();
  for (const group of groups) {
    for (const host of Object.keys(group.placement)) {
      const list = groupsByHost.get(host) ?? [];
      list.push(group);
      groupsByHost.set(host, list);
    }
  }

  const scopesByForge = new Map<string, Scope[]>();
  for (const group of groups) {
    const list = scopesByForge.get(group.forge) ?? [];
    if (!list.some((scope) => scopeKey(scope) === scopeKey(group.scope))) {
      list.push(group.scope);
    }
    scopesByForge.set(group.forge, list);
  }

  const hostNames = Object.keys(config.hosts);
  const hosts = await Promise.all(
    hostNames.map((name) => {
      const transport = options.transports.get(name);
      if (transport === undefined) {
        return Promise.resolve(unreachable(name, 'no transport was opened'));
      }
      return observeHost(
        name,
        config,
        transport,
        groupsByHost.get(name) ?? [],
        options.probeTimeoutMs,
      );
    }),
  );

  const forgeNames = [...scopesByForge.keys()];
  const forges = await Promise.all(
    forgeNames.map((name) =>
      observeForge(
        name,
        // manageableGroups already proved the client is there.
        options.forgeClients.get(name) as ForgeClient,
        scopesByForge.get(name) ?? [],
        forgeLimit,
      ),
    ),
  );

  return { hosts, forges };
}
