import { describe, expect, it } from 'vitest';
import type { Scope } from '../config/index.js';
import type { DockerContainer } from '../stack/index.js';
import type { RunnerRecord } from '../state/index.js';
import {
  describeWhere,
  type ForgeObservation,
  flattenObserved,
  type ObservedState,
} from './observed.js';
import type { ClassifiedRunner } from './ownership.js';

const SCOPE = { level: 'organization', target: 'Overload-coach' } as const;

const CONTAINER: DockerContainer = {
  name: 'grove-overload-arm-1',
  containerId: 'grove-overload-arm-1',
  state: 'running',
  image: 'ghcr.io/actions/actions-runner:latest',
  status: 'Up 1 hour',
  createdAt: 'now',
};

const FORGE_RUNNER = {
  id: '12',
  name: 'grove-overload-arm-1',
  status: 'online' as const,
  busy: false,
  labels: [],
};

function state(hostReachable: boolean, forgeReachable: boolean): ObservedState {
  return {
    hosts: [
      {
        host: 'mac',
        reachable: hostReachable,
        containers: [CONTAINER],
        workRoots: {},
      },
    ],
    forges: [
      {
        forge: 'gh-overload',
        reachable: forgeReachable,
        runners: [{ scope: SCOPE, runner: FORGE_RUNNER }],
      },
    ],
  };
}

describe('flattenObserved', () => {
  it('emits one entry per container and one per forge runner', () => {
    const seen = flattenObserved(state(true, true), { skipUnreachable: true });
    expect(seen).toEqual([
      { name: 'grove-overload-arm-1', host: 'mac', container: CONTAINER },
      {
        name: 'grove-overload-arm-1',
        forge: 'gh-overload',
        scope: SCOPE,
        forgeRunner: FORGE_RUNNER,
      },
    ]);
  });

  it('drops what a silent host and a silent forge would have reported', () => {
    const seen = flattenObserved(state(false, false), {
      skipUnreachable: true,
    });
    expect(seen).toEqual([]);
  });

  it('keeps the stale view when the caller only reports', () => {
    const seen = flattenObserved(state(false, false), {
      skipUnreachable: false,
    });
    expect(seen.map((entry) => entry.name)).toEqual([
      'grove-overload-arm-1',
      'grove-overload-arm-1',
    ]);
  });
});

describe('describeWhere', () => {
  function classified(overrides: Partial<ClassifiedRunner>): ClassifiedRunner {
    return {
      name: 'grove-overload-arm-1',
      ownership: 'unmanaged',
      ...overrides,
    };
  }

  it('names the host when only a container was seen', () => {
    expect(
      describeWhere(classified({ host: 'mac', container: CONTAINER })),
    ).toBe('container on mac');
  });

  it('names the forge when only a forge runner was seen', () => {
    expect(
      describeWhere(
        classified({ forge: 'gh-overload', forgeRunner: FORGE_RUNNER }),
      ),
    ).toBe('runner at gh-overload');
  });

  it('names both when the runner sits in both places', () => {
    expect(
      describeWhere(
        classified({
          host: 'mac',
          container: CONTAINER,
          forge: 'gh-overload',
          forgeRunner: FORGE_RUNNER,
        }),
      ),
    ).toBe('container on mac, runner at gh-overload');
  });

  it('says nothing about a record with nothing behind it', () => {
    expect(describeWhere(classified({ ownership: 'record-only' }))).toBe('');
  });
});

describe('flattenObserved, a forge that shares one entity', () => {
  const scope: Scope = { level: 'instance' };

  const shared: ForgeObservation = {
    forge: 'gl-chevro',
    reachable: true,
    shared: true,
    runners: [
      {
        runner: {
          id: '48',
          name: 'grove-chevro-dind',
          status: 'online',
          busy: false,
          labels: ['docker'],
          managers: [
            { systemId: 's_aaaaaaaaaaaa', status: 'online', busy: false },
          ],
        },
        scope,
      },
    ],
  };

  const record: RunnerRecord = {
    id: 1,
    group: 'chevro-dind',
    index: 1,
    host: 'atlas',
    forge: 'gl-chevro',
    forgeRunnerId: '48',
    systemId: 's_aaaaaaaaaaaa',
    name: 'grove-chevro-dind-1',
    createdAt: 1,
    retiredAt: null,
  };

  it('names the sighting after the record, not after the entity', () => {
    const seen = flattenObserved(
      { hosts: [], forges: [shared] },
      { skipUnreachable: true, records: [record] },
    );
    expect(seen.map((entry) => entry.name)).toEqual(['grove-chevro-dind-1']);
  });

  it('sees nothing at a shared forge when it is given no record', () => {
    const seen = flattenObserved(
      { hosts: [], forges: [shared] },
      { skipUnreachable: true },
    );
    expect(seen).toEqual([]);
  });
});
