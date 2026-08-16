import {
  archWarnings,
  type ConfigWarning,
  type ForgeKind,
  type LoadedConfig,
  type Scope,
} from '../config/index.js';
import {
  type ConnectFn,
  connect as defaultConnect,
  type HostProbe,
  probeHosts,
  type Transport,
} from '../transport/index.js';

export interface PlanPlacementRow {
  host: string;
  count: number;
}

export interface PlanHostRow {
  name: string;
  type: 'local' | 'ssh';
  target: string;
  reachable: boolean;
  reason?: string;
  arch?: string;
}

export interface PlanGroupRow {
  name: string;
  forge: string;
  forgeKind: ForgeKind;
  scope: string;
  stack: 'docker' | 'native';
  arch?: string;
  placement: PlanPlacementRow[];
  total: number;
}

export interface PlanReport {
  configPath: string;
  hosts: PlanHostRow[];
  groups: PlanGroupRow[];
  warnings: ConfigWarning[];
  unreachable: string[];
  ok: boolean;
}

export interface BuildPlanOptions {
  connect?: ConnectFn;
  probeTimeoutMs?: number;
}

export function formatScope(scope: Scope): string {
  return 'target' in scope ? `${scope.level} ${scope.target}` : scope.level;
}

export async function buildPlanReport(
  loaded: LoadedConfig,
  options: BuildPlanOptions = {},
): Promise<PlanReport> {
  const connectFn = options.connect ?? defaultConnect;
  const transports = new Map<string, Transport>();
  for (const [name, host] of Object.entries(loaded.config.hosts)) {
    transports.set(name, connectFn(name, host));
  }

  let probes: HostProbe[] = [];
  try {
    probes = await probeHosts(transports, options.probeTimeoutMs);
  } finally {
    await Promise.all(
      [...transports.values()].map((transport) =>
        transport.close().catch(() => undefined),
      ),
    );
  }

  const probeByHost = new Map(probes.map((probe) => [probe.host, probe]));
  const hosts: PlanHostRow[] = Object.entries(loaded.config.hosts).map(
    ([name, host]) => {
      const probe = probeByHost.get(name);
      const reachable = probe?.reachable ?? false;
      return {
        name,
        type: host.type,
        target: host.type === 'ssh' ? host.host : 'this machine',
        reachable,
        reason: reachable ? undefined : (probe?.reason ?? 'not probed'),
        arch: reachable ? probe?.arch : undefined,
      };
    },
  );

  const archByHost = new Map<string, string>();
  for (const probe of probes) {
    if (probe.arch !== undefined) {
      archByHost.set(probe.host, probe.arch);
    }
  }

  const groups: PlanGroupRow[] = loaded.config.groups.map((group) => {
    const placement = Object.entries(group.placement).map(([host, count]) => ({
      host,
      count,
    }));
    return {
      name: group.name,
      forge: group.forge,
      forgeKind: loaded.config.forges[group.forge].kind,
      scope: formatScope(group.scope),
      stack: group.stack,
      arch: group.arch,
      placement,
      total: placement.reduce((sum, entry) => sum + entry.count, 0),
    };
  });

  const unreachable = hosts
    .filter((host) => !host.reachable)
    .map((host) => host.name);

  return {
    configPath: loaded.path,
    hosts,
    groups,
    warnings: [...loaded.warnings, ...archWarnings(loaded.config, archByHost)],
    unreachable,
    ok: unreachable.length === 0,
  };
}
