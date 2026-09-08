import type { GroupConfig, GroveConfig, Scope } from '../config/index.js';
import { errorMessage } from '../errors.js';
import type { ForgeClient } from '../forge/index.js';
import { parseManagedName } from '../naming.js';
import {
  buildRunnerDirs,
  checkWorkRootVolume,
  type DockerContainer,
  DockerStack,
  NativeStack,
  type NativeUnit,
  type SystemIdTarget,
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

// The home and the uid in one round trip, because over SSH the round trip
// costs far more than either command. `|| true` keeps the exit code that of
// the shell rather than that of `id`, so a host without `id` still reports a
// home. Line one is the home, line two is the uid.
export const HOST_FACTS_COMMAND = `${HOME_COMMAND}; printf '\\n'; id -u 2>/dev/null || true`;

export interface ObserveOptions {
  transports: ReadonlyMap<string, Transport>;
  forgeClients: ReadonlyMap<string, ForgeClient>;
  probeTimeoutMs?: number;
  // Task 18 builds the real limiter (reconcile/limiter.ts) and passes it in
  // so every forge call in a reconcile pass is queued behind one cap. Absent
  // a caller, a listRunners call just runs.
  forgeLimit?: <T>(fn: () => Promise<T>) => Promise<T>;
  // The fast tick is liveness only, so it asks no forge anything. The host
  // half of the pass stays whole, because the absent-disk guard runs before
  // every start and a start is the only thing a fast tick does.
  skipForges?: boolean;
  // Called as each host and each forge lands, so a caller that renders
  // progressively does not wait for the slowest one. The returned state still
  // holds everything, so a caller that ignores these sees no difference.
  onHost?: (observation: HostObservation) => void;
  onForge?: (observation: ForgeObservation) => void;
}

function unreachable(host: string, reason: string): HostObservation {
  return { host, reachable: false, reason, containers: [], workRoots: {} };
}

// A stable dedup key for a scope, so grove lists a scope once even when two
// groups target the same level and target.
function scopeKey(scope: Scope): string {
  return 'target' in scope ? `${scope.level}:${scope.target}` : scope.level;
}

// Groups grove can act on today: a Docker group, or a native group on a
// GitHub forge. A pass that will call a forge also needs that forge's client
// to exist, and a group whose client is missing is silently absent from this
// list, which is what keeps `logs` working with no token at all. A pass that
// will call no forge (skipForges) needs no client to decide that a group is
// grove's to look at.
function manageableGroups(
  config: GroveConfig,
  forgeClients: ReadonlyMap<string, ForgeClient>,
  skipForges: boolean,
): GroupConfig[] {
  return config.groups.filter(
    (group) =>
      (skipForges || forgeClients.has(group.forge)) &&
      (group.stack === 'docker' ||
        config.forges[group.forge]?.kind === 'github'),
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

  // One try/catch for the reads that decide whether grove understood this
  // host at all: the home, the volume guard, and the GitLab system ids. A
  // rejection there means grove cannot trust what it saw, which is exactly
  // when deleting a forge record would be wrong. The two stack queries below
  // sit outside it, because a host that runs one stack and not the other is
  // a normal host rather than a broken one.
  try {
    const factsResult = await transport.exec('sh', ['-c', HOST_FACTS_COMMAND]);
    const [homeAnswer = '', uidAnswer = ''] = factsResult.stdout.split('\n');
    // Everything grove derives from the home is an absolute path a supervisor
    // reads, and no transport expands a tilde or a relative path. A host that
    // answers with anything else has no home grove can use.
    const home = homeAnswer.trim().startsWith('/')
      ? homeAnswer.trim()
      : undefined;
    // The uid is a convenience, and a host that cannot answer is caught by
    // the probe that ran before this.
    const uid = /^\d+$/.test(uidAnswer.trim()) ? uidAnswer.trim() : undefined;

    const stack = new DockerStack({ transport, host: name });
    const native = new NativeStack({
      transport,
      host: name,
      platform: probe.platform ?? 'Linux',
      ...(uid === undefined ? {} : { uid }),
    });

    // Nothing here reads anything the others write, so the host answers all
    // of them in one round trip's worth of wall clock rather than one each.
    const [containerRead, nativeRead, workRootReads] = await Promise.all([
      stack.listContainers().then(
        (value) => ({ value }),
        (error: unknown) => ({ error: errorMessage(error) }),
      ),
      native.listUnits().then(
        (value) => ({ value }),
        (error: unknown) => ({ error: errorMessage(error) }),
      ),
      Promise.all(
        groups.map(async (group) => {
          const dirs = buildRunnerDirs({
            group,
            host: config.hosts[name],
            index: 1,
            home,
          });
          return [
            group.name,
            await checkWorkRootVolume(
              transport,
              probe.platform ?? 'Linux',
              dirs.workDir,
            ),
          ] as const;
        }),
      ),
    ]);

    const containers: DockerContainer[] =
      'value' in containerRead ? containerRead.value : [];
    const containersError =
      'error' in containerRead ? containerRead.error : undefined;
    const natives: NativeUnit[] | undefined =
      'value' in nativeRead ? nativeRead.value : undefined;
    const nativesError = 'error' in nativeRead ? nativeRead.error : undefined;
    const workRoots: Record<string, VolumeCheck> =
      Object.fromEntries(workRootReads);

    // gitlab-runner writes .runner_system_id next to config.toml at first
    // start, and the managers endpoint has no field that names a container,
    // so this file is the only thing that maps one to the other.
    const gitlabGroups = new Map(
      groups
        .filter((group) => config.forges[group.forge]?.kind === 'gitlab')
        .map((group) => [group.name, group] as const),
    );
    const targets: SystemIdTarget[] = [];
    for (const container of containers) {
      const parsed = parseManagedName(container.name);
      const group =
        parsed === null ? undefined : gitlabGroups.get(parsed.group);
      if (parsed === null || group === undefined) {
        continue;
      }
      const dirs = buildRunnerDirs({
        group,
        host: config.hosts[name],
        index: parsed.index,
        home,
      });
      targets.push({ name: container.name, configDir: dirs.configDir });
    }
    const systemIds = await stack.readSystemIds(targets);

    return {
      host: name,
      reachable: true,
      ...(probe.platform === undefined ? {} : { platform: probe.platform }),
      ...(probe.arch === undefined ? {} : { arch: probe.arch }),
      ...(home === undefined ? {} : { home }),
      ...(uid === undefined ? {} : { uid }),
      containers,
      ...(containersError === undefined ? {} : { containersError }),
      ...(natives === undefined ? {} : { natives }),
      ...(nativesError === undefined ? {} : { nativesError }),
      workRoots,
      ...(Object.keys(systemIds).length === 0 ? {} : { systemIds }),
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
    // forgeLimit is what caps how hard grove hits a forge, so asking for
    // every scope at once queues them there rather than serialising them
    // here. The dedup still walks the scopes in config order.
    const listed = await Promise.all(
      scopes.map(
        async (scope) =>
          [scope, await forgeLimit(() => client.listRunners(scope))] as const,
      ),
    );
    for (const [scope, found] of listed) {
      for (const runner of found) {
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
      shared: client.sharedRegistration,
      reason: errorMessage(error),
      runners: [],
    };
  }
  return {
    forge: name,
    reachable: true,
    shared: client.sharedRegistration,
    runners,
  };
}

export async function observeFleet(
  config: GroveConfig,
  options: ObserveOptions,
): Promise<ObservedState> {
  const skipForges = options.skipForges === true;
  const groups = manageableGroups(config, options.forgeClients, skipForges);
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
  // Kept unawaited until the forge pass is in flight too. Which forges to ask
  // comes from the config alone, so an SSH round trip never has to finish
  // before an HTTP one can start.
  const hosts = Promise.all(
    hostNames.map(async (name) => {
      const transport = options.transports.get(name);
      const observation =
        transport === undefined
          ? unreachable(name, 'no transport was opened')
          : await observeHost(
              name,
              config,
              transport,
              groupsByHost.get(name) ?? [],
              options.probeTimeoutMs,
            );
      options.onHost?.(observation);
      return observation;
    }),
  );

  // An empty array is what the planner reads as "no forge was observed on
  // this pass", which already blocks every create and every removal. That is
  // exactly the fast tick's contract.
  const forgeNames = skipForges ? [] : [...scopesByForge.keys()];
  const forges = Promise.all(
    forgeNames.map(async (name) => {
      const observation = await observeForge(
        name,
        // skipForges is false here, and manageableGroups required the client
        // to be present for every group that fed scopesByForge in that case.
        options.forgeClients.get(name) as ForgeClient,
        scopesByForge.get(name) ?? [],
        forgeLimit,
      );
      options.onForge?.(observation);
      return observation;
    }),
  );

  return { hosts: await hosts, forges: await forges };
}
