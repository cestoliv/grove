import type { Scope } from '../config/index.js';
import type { ForgeRunner } from '../forge/index.js';
import type { DockerContainer, VolumeCheck } from '../stack/index.js';
import type { ClassifiedRunner, ObservedRunner } from './ownership.js';

export interface HostObservation {
  host: string;
  reachable: boolean;
  reason?: string;
  platform?: string;
  arch?: string;
  home?: string;
  containers: DockerContainer[];
  // One entry per group placed on this host, keyed by group name.
  workRoots: Record<string, VolumeCheck>;
}

export interface ObservedForgeRunner {
  runner: ForgeRunner;
  // The scope the runner was listed under, so a later delete knows where
  // to go without consulting the config again.
  scope: Scope;
}

export interface ForgeObservation {
  forge: string;
  reachable: boolean;
  reason?: string;
  runners: ObservedForgeRunner[];
}

export interface ObservedState {
  hosts: HostObservation[];
  forges: ForgeObservation[];
}

export interface FlattenOptions {
  // A caller that decides what to destroy sets this, so silence from a host
  // or a forge never reads as absence. A caller that only reports sets it
  // false, so the operator still sees the last thing grove knew.
  skipUnreachable: boolean;
}

export function flattenObserved(
  observed: ObservedState,
  options: FlattenOptions,
): ObservedRunner[] {
  const seen: ObservedRunner[] = [];
  for (const host of observed.hosts) {
    if (options.skipUnreachable && !host.reachable) {
      continue;
    }
    for (const container of host.containers) {
      seen.push({ name: container.name, host: host.host, container });
    }
  }
  for (const forge of observed.forges) {
    if (options.skipUnreachable && !forge.reachable) {
      continue;
    }
    for (const listed of forge.runners) {
      seen.push({
        name: listed.runner.name,
        forge: forge.forge,
        scope: listed.scope,
        forgeRunner: listed.runner,
      });
    }
  }
  return seen;
}

export function describeWhere(entry: ClassifiedRunner): string {
  return [
    entry.container === undefined ? undefined : `container on ${entry.host}`,
    entry.forgeRunner === undefined ? undefined : `runner at ${entry.forge}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');
}
