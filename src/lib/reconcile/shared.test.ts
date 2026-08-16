import { describe, expect, it } from 'vitest';
import type { Scope } from '../config/index.js';
import type { ForgeRunner } from '../forge/index.js';
import type { RunnerRecord } from '../state/index.js';
import type { ForgeObservation, ObservedState } from './observed.js';
import {
  expandSharedSightings,
  orphanSharedEntities,
  sharedEntities,
} from './shared.js';

const scope: Scope = { level: 'instance' };

function record(overrides: Partial<RunnerRecord> = {}): RunnerRecord {
  return {
    id: 1,
    group: 'chevro-dind',
    index: 1,
    host: 'atlas',
    forge: 'gl-chevro',
    forgeRunnerId: '48',
    systemId: null,
    name: 'grove-chevro-dind-1',
    createdAt: 1,
    retiredAt: null,
    ...overrides,
  };
}

function entity(overrides: Partial<ForgeRunner> = {}): ForgeRunner {
  return {
    id: '48',
    name: 'grove-chevro-dind',
    status: 'online',
    busy: false,
    labels: ['docker', 'dind'],
    managers: [],
    ...overrides,
  };
}

function observation(runners: ForgeRunner[]): ForgeObservation {
  return {
    forge: 'gl-chevro',
    reachable: true,
    shared: true,
    runners: runners.map((runner) => ({ runner, scope })),
  };
}

describe('sharedEntities', () => {
  it('leaves out a record of another group that points at this entity', () => {
    const found = sharedEntities(observation([entity()]), [
      record(),
      // Same id, other group. Attaching it would mislabel the sighting in
      // status, so the entity's own group is what decides.
      record({ id: 5, group: 'other-group', name: 'grove-other-group-1' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].records.map((row) => row.name)).toEqual([
      'grove-chevro-dind-1',
    ]);
  });

  it('gathers the records that point at one entity, lowest index first', () => {
    const found = sharedEntities(observation([entity()]), [
      record({ id: 3, index: 3, name: 'grove-chevro-dind-3' }),
      record({ id: 1, index: 1, name: 'grove-chevro-dind-1' }),
      record({ id: 9, forgeRunnerId: '99', name: 'grove-other-1' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].group).toBe('chevro-dind');
    expect(found[0].records.map((row) => row.index)).toEqual([1, 3]);
  });

  it('ignores an entity whose description grove did not write', () => {
    expect(
      sharedEntities(observation([entity({ name: 'somebody-else' })]), []),
    ).toEqual([]);
  });

  it('ignores a record at another forge with the same entity id', () => {
    const found = sharedEntities(observation([entity()]), [
      record({ forge: 'gl-other' }),
    ]);
    expect(found[0].records).toEqual([]);
  });

  it('ignores a retired record', () => {
    const found = sharedEntities(observation([entity()]), [
      record({ retiredAt: 5 }),
    ]);
    expect(found[0].records).toEqual([]);
  });
});

describe('expandSharedSightings', () => {
  it('names one sighting per record and takes its status from the manager', () => {
    const seen = expandSharedSightings(
      observation([
        entity({
          managers: [
            { systemId: 's_aaaaaaaaaaaa', status: 'online', busy: true },
            { systemId: 'r_bbbbbbbbbbbb', status: 'stale', busy: false },
          ],
        }),
      ]),
      [
        record({ id: 1, systemId: 's_aaaaaaaaaaaa' }),
        record({
          id: 2,
          index: 2,
          name: 'grove-chevro-dind-2',
          systemId: 'r_bbbbbbbbbbbb',
        }),
      ],
    );

    expect(seen).toEqual([
      {
        name: 'grove-chevro-dind-1',
        forge: 'gl-chevro',
        scope,
        forgeRunner: {
          id: '48',
          name: 'grove-chevro-dind-1',
          status: 'online',
          busy: true,
          labels: ['docker', 'dind'],
          managers: [
            { systemId: 's_aaaaaaaaaaaa', status: 'online', busy: true },
          ],
        },
      },
      {
        name: 'grove-chevro-dind-2',
        forge: 'gl-chevro',
        scope,
        forgeRunner: {
          id: '48',
          name: 'grove-chevro-dind-2',
          status: 'offline',
          busy: false,
          labels: ['docker', 'dind'],
          managers: [
            { systemId: 'r_bbbbbbbbbbbb', status: 'stale', busy: false },
          ],
        },
      },
    ]);
  });

  it('still sees the runner when grove has not learned its system id yet', () => {
    const [seen] = expandSharedSightings(
      observation([
        entity({
          managers: [
            { systemId: 's_aaaaaaaaaaaa', status: 'online', busy: false },
          ],
        }),
      ]),
      [record()],
    );
    expect(seen.name).toBe('grove-chevro-dind-1');
    expect(seen.forgeRunner?.status).toBe('offline');
    expect(seen.forgeRunner?.managers).toBeUndefined();
  });

  it('emits nothing for an entity no record claims', () => {
    expect(expandSharedSightings(observation([entity()]), [])).toEqual([]);
  });

  it('leaves a manager grove cannot place out of the sightings', () => {
    const seen = expandSharedSightings(
      observation([
        entity({
          managers: [
            { systemId: 's_aaaaaaaaaaaa', status: 'online', busy: false },
            { systemId: 's_orphaned000', status: 'online', busy: false },
          ],
        }),
      ]),
      [record({ systemId: 's_aaaaaaaaaaaa' })],
    );
    expect(seen).toHaveLength(1);
  });
});

describe('orphanSharedEntities', () => {
  function state(forges: ForgeObservation[]): ObservedState {
    return { hosts: [], forges };
  }

  it('finds an entity grove named that no record claims', () => {
    const orphans = orphanSharedEntities(
      state([
        observation([entity(), entity({ id: '90', name: 'grove-gone' })]),
      ]),
      [record()],
    );
    expect(orphans.map((orphan) => orphan.group)).toEqual(['gone']);
  });

  it('says nothing about a forge that did not answer', () => {
    const silent: ForgeObservation = {
      ...observation([entity()]),
      reachable: false,
    };
    expect(orphanSharedEntities(state([silent]), [])).toEqual([]);
  });

  it('says nothing about a forge that registers one runner at a time', () => {
    const github: ForgeObservation = {
      forge: 'gh-overload',
      reachable: true,
      runners: [
        {
          runner: {
            id: '1',
            name: 'grove-overload-arm-1',
            status: 'online',
            busy: false,
            labels: [],
          },
          scope,
        },
      ],
    };
    expect(orphanSharedEntities(state([github]), [])).toEqual([]);
  });
});
