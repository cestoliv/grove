import type { Scope, StackKind } from '../config/index.js';
import type { ForgeRunner } from '../forge/index.js';
import type {
  DockerContainer,
  NativeUnit,
  VolumeCheck,
} from '../stack/index.js';
import type { RunnerRecord } from '../state/index.js';
import type { ClassifiedRunner, ObservedRunner } from './ownership.js';
import { expandSharedSightings } from './shared.js';

export interface HostObservation {
  host: string;
  reachable: boolean;
  reason?: string;
  platform?: string;
  arch?: string;
  home?: string;
  // What `id -u` answered. launchd keys its per-user domain on it, and
  // systemd finds the user bus through it when grove arrives over SSH.
  uid?: string;
  containers: DockerContainer[];
  // Why `docker ps` did not answer on a host that is otherwise reachable. A
  // Mac that runs only native runners has no Docker, and calling that host
  // unreachable would stop grove converging the seats it can see.
  containersError?: string;
  // Every native seat the supervisor listed, absent on a host grove could not
  // ask.
  natives?: NativeUnit[];
  nativesError?: string;
  // One entry per group placed on this host, keyed by group name.
  workRoots: Record<string, VolumeCheck>;
  // Keyed by container name. Present for a GitLab container that has run at
  // least once, absent everywhere else.
  systemIds?: Record<string, string>;
}

// Silence from one stack is not silence from the host. A caller that knows
// which stack a seat runs on asks about that one, and nothing else blocks it.
export function hostStackError(
  observation: HostObservation,
  stack: StackKind,
): string | undefined {
  return stack === 'native'
    ? observation.nativesError
    : observation.containersError;
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
  // true when one runner entity covers a whole group, as GitLab does.
  shared?: boolean;
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
  // A shared forge lists one entity for a whole group, and only the records
  // say which container each manager belongs to. Without them, a shared
  // forge contributes nothing, which is the safe answer.
  records?: RunnerRecord[];
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
    for (const unit of host.natives ?? []) {
      seen.push({ name: unit.name, host: host.host, native: unit });
    }
  }
  for (const forge of observed.forges) {
    if (options.skipUnreachable && !forge.reachable) {
      continue;
    }
    if (forge.shared === true) {
      seen.push(...expandSharedSightings(forge, options.records ?? []));
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
    entry.native === undefined ? undefined : `unit on ${entry.host}`,
    entry.forgeRunner === undefined ? undefined : `runner at ${entry.forge}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');
}
