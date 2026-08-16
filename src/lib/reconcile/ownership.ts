import type { Scope } from '../config/index.js';
import type { ForgeRunner } from '../forge/index.js';
import { parseManagedName } from '../naming.js';
import type { DockerContainer } from '../stack/index.js';
import type { RunnerRecord } from '../state/index.js';

export type OwnershipClass =
  | 'managed'
  | 'unmanaged'
  | 'record-only'
  | 'foreign';

export interface ObservedRunner {
  name: string;
  host?: string;
  forge?: string;
  container?: DockerContainer;
  forgeRunner?: ForgeRunner;
  scope?: Scope;
}

export interface ClassifiedRunner extends ObservedRunner {
  ownership: OwnershipClass;
  record?: RunnerRecord;
  group?: string;
  index?: number;
}

// Every sighting of one name, split by the place it came from. A container is
// one name on one host and a forge listing is one name at one forge, so two
// hosts can run the same name and two forges can list it. Keeping the places
// apart is what lets a record claim its own and nothing else.
interface NameSightings {
  onHosts: Map<string, ObservedRunner>;
  atForges: Map<string, ObservedRunner>;
  unplaced: ObservedRunner[];
}

function merge(target: ObservedRunner, source: ObservedRunner): void {
  target.host ??= source.host;
  target.forge ??= source.forge;
  target.container ??= source.container;
  target.forgeRunner ??= source.forgeRunner;
  target.scope ??= source.scope;
}

function emptySightings(): NameSightings {
  return { onHosts: new Map(), atForges: new Map(), unplaced: [] };
}

function place(sightings: NameSightings, entry: ObservedRunner): void {
  const bucket =
    entry.host !== undefined
      ? sightings.onHosts
      : entry.forge !== undefined
        ? sightings.atForges
        : undefined;
  if (bucket === undefined) {
    sightings.unplaced.push({ ...entry });
    return;
  }
  const key = (entry.host ?? entry.forge) as string;
  const existing = bucket.get(key);
  if (existing === undefined) {
    bucket.set(key, { ...entry });
    return;
  }
  merge(existing, entry);
}

export function classifyRunners(
  observed: ObservedRunner[],
  records: RunnerRecord[],
): ClassifiedRunner[] {
  const active = new Map<string, RunnerRecord>();
  for (const record of records) {
    if (record.retiredAt === null) {
      active.set(record.name, record);
    }
  }

  const byName = new Map<string, NameSightings>();
  for (const entry of observed) {
    let sightings = byName.get(entry.name);
    if (sightings === undefined) {
      sightings = emptySightings();
      byName.set(entry.name, sightings);
    }
    place(sightings, entry);
  }

  const entries: ClassifiedRunner[] = [];

  for (const name of new Set([...byName.keys(), ...active.keys()])) {
    const sightings = byName.get(name) ?? emptySightings();
    const record = active.get(name);
    const parsed = parseManagedName(name);

    if (record !== undefined) {
      // The record names one host and one forge, and only the sighting in each
      // of those two places is the runner it created. A same-named sighting
      // anywhere else is a collision, so it stays out of this entry and no
      // destructive step ever reads the record's fields off it.
      const onHost = sightings.onHosts.get(record.host);
      const atForge = sightings.atForges.get(record.forge);
      sightings.onHosts.delete(record.host);
      sightings.atForges.delete(record.forge);

      const claimed: ObservedRunner = {
        name,
        host: record.host,
        forge: record.forge,
      };
      if (onHost !== undefined) {
        merge(claimed, onHost);
      }
      if (atForge !== undefined) {
        merge(claimed, atForge);
      }

      entries.push({
        ...claimed,
        // A record with nothing behind it. grove created it, then the runner
        // was renamed or lost. Reported, never removed on its own.
        ownership:
          onHost === undefined && atForge === undefined
            ? 'record-only'
            : parsed === null
              ? 'foreign'
              : 'managed',
        record,
        group: parsed?.group ?? record.group,
        index: parsed?.index ?? record.index,
      });
    }

    const leftOnHosts = [...sightings.onHosts.values()];
    const leftAtForges = [...sightings.atForges.values()];
    const loose: ObservedRunner[] = [...sightings.unplaced];

    // No record ties a leftover container to a leftover forge runner. One of
    // each is the only pairing grove can read without guessing, so anything
    // busier stays split and a removal keeps pointing at the place it saw.
    if (leftOnHosts.length === 1 && leftAtForges.length === 1) {
      const paired = { ...leftOnHosts[0] };
      merge(paired, leftAtForges[0]);
      loose.push(paired);
    } else {
      loose.push(...leftOnHosts, ...leftAtForges);
    }

    for (const entry of loose) {
      entries.push({
        ...entry,
        ownership: parsed === null ? 'foreign' : 'unmanaged',
        group: parsed?.group,
        index: parsed?.index,
      });
    }
  }

  return entries.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      (left.host ?? '').localeCompare(right.host ?? '') ||
      (left.forge ?? '').localeCompare(right.forge ?? ''),
  );
}

export function isDestroyable(
  entry: ClassifiedRunner,
  includeUnmanaged: boolean,
): boolean {
  return (
    entry.ownership === 'managed' ||
    (includeUnmanaged && entry.ownership === 'unmanaged')
  );
}
