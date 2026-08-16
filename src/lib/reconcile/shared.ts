import type { Scope } from '../config/index.js';
import type { ForgeRunner } from '../forge/index.js';
import { parseSharedName } from '../naming.js';
import type { RunnerRecord } from '../state/index.js';
import type { ForgeObservation, ObservedState } from './observed.js';
import type { ObservedRunner } from './ownership.js';

// One group at one forge. Two forges can host a group of the same name, so
// the pair is what identifies a shared registration across the whole pass.
export function groupForgeKey(group: string, forge: string): string {
  return `${group} ${forge}`;
}

export interface SharedEntity {
  forge: string;
  scope: Scope;
  group: string;
  runner: ForgeRunner;
  // Active records that point at this entity, lowest index first.
  records: RunnerRecord[];
}

export function sharedEntities(
  observation: ForgeObservation,
  records: RunnerRecord[],
): SharedEntity[] {
  const active = records.filter(
    (record) => record.retiredAt === null && record.forge === observation.forge,
  );
  const entities: SharedEntity[] = [];
  for (const listed of observation.runners) {
    const parsed = parseSharedName(listed.runner.name);
    if (parsed === null) {
      continue;
    }
    entities.push({
      forge: observation.forge,
      scope: listed.scope,
      group: parsed.group,
      runner: listed.runner,
      records: active
        .filter(
          (record) =>
            record.forgeRunnerId === listed.runner.id &&
            // The entity describes one group. A record of another group that
            // names this id belongs to nobody here.
            record.group === parsed.group,
        )
        .sort((left, right) => left.index - right.index),
    });
  }
  return entities;
}

export function expandSharedSightings(
  observation: ForgeObservation,
  records: RunnerRecord[],
): ObservedRunner[] {
  const seen: ObservedRunner[] = [];
  for (const entity of sharedEntities(observation, records)) {
    for (const record of entity.records) {
      // system_id is the only field the managers endpoint exposes that tells
      // two managers apart, and grove learns it from the host rather than
      // from GitLab. Until it has, no manager is provably this container.
      const manager =
        record.systemId === null
          ? undefined
          : (entity.runner.managers ?? []).find(
              (candidate) => candidate.systemId === record.systemId,
            );
      seen.push({
        name: record.name,
        forge: entity.forge,
        scope: entity.scope,
        forgeRunner: {
          id: entity.runner.id,
          // The record's name, so everything above this seam keeps working
          // on the one name convention grove already has.
          name: record.name,
          status: manager?.status === 'online' ? 'online' : 'offline',
          busy: manager?.busy === true,
          labels: entity.runner.labels,
          ...(manager === undefined ? {} : { managers: [manager] }),
        },
      });
    }
  }
  return seen;
}

export function orphanSharedEntities(
  observed: ObservedState,
  records: RunnerRecord[],
): SharedEntity[] {
  const orphans: SharedEntity[] = [];
  for (const observation of observed.forges) {
    if (observation.shared !== true || !observation.reachable) {
      continue;
    }
    for (const entity of sharedEntities(observation, records)) {
      if (entity.records.length === 0) {
        orphans.push(entity);
      }
    }
  }
  return orphans;
}
