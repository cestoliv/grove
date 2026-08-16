import {
  archWarnings,
  type ConfigWarning,
  type ForgeKind,
  type LoadedConfig,
  type Scope,
} from '../config/index.js';
import type { Action, ObservedState } from '../reconcile/index.js';

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
  actions: Action[];
  unreachable: string[];
  degraded: string[];
  ok: boolean;
}

export interface BuildPlanOptions {
  observed: ObservedState;
  actions?: Action[];
  extraWarnings?: ConfigWarning[];
}

export function formatScope(scope: Scope): string {
  return 'target' in scope ? `${scope.level} ${scope.target}` : scope.level;
}

export function buildPlanReport(
  loaded: LoadedConfig,
  options: BuildPlanOptions,
): PlanReport {
  const actions = options.actions ?? [];
  const observedByHost = new Map(
    options.observed.hosts.map((entry) => [entry.host, entry]),
  );

  const hosts: PlanHostRow[] = Object.entries(loaded.config.hosts).map(
    ([name, host]) => {
      const observation = observedByHost.get(name);
      const reachable = observation?.reachable ?? false;
      return {
        name,
        type: host.type,
        target: host.type === 'ssh' ? host.host : 'this machine',
        reachable,
        reason: reachable
          ? undefined
          : (observation?.reason ?? 'not observed on this pass'),
        arch: reachable ? observation?.arch : undefined,
      };
    },
  );

  const archByHost = new Map<string, string>();
  for (const observation of options.observed.hosts) {
    if (observation.reachable && observation.arch !== undefined) {
      archByHost.set(observation.host, observation.arch);
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

  const degraded = [
    ...new Set(
      actions
        .filter((action) => action.kind === 'report-degraded')
        .map((action) => action.target),
    ),
  ].filter((target) => !unreachable.includes(target));

  return {
    configPath: loaded.path,
    hosts,
    groups,
    warnings: [
      ...loaded.warnings,
      ...archWarnings(loaded.config, archByHost),
      ...(options.extraWarnings ?? []),
    ],
    actions,
    unreachable,
    degraded,
    ok: unreachable.length === 0 && degraded.length === 0,
  };
}
