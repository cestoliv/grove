import { describe, expect, it } from 'vitest';
import type { DockerContainer } from '../stack/index.js';
import type { RunnerRecord } from '../state/index.js';
import { classifyRunners, isDestroyable } from './ownership.js';

function container(name: string): DockerContainer {
  return {
    name,
    containerId: 'abc',
    state: 'running',
    image: 'x',
    status: 'Up 1 hour',
    createdAt: 'now',
  };
}

function record(name: string, id = 1): RunnerRecord {
  return {
    id,
    group: 'overload-arm',
    index: 1,
    host: 'mac',
    forge: 'gh-overload',
    forgeRunnerId: null,
    systemId: null,
    name,
    createdAt: 0,
    retiredAt: null,
  };
}

describe('classifyRunners', () => {
  it('calls a runner managed when the name and the record agree', () => {
    const [entry] = classifyRunners(
      [
        {
          name: 'grove-overload-arm-1',
          host: 'mac',
          container: container('grove-overload-arm-1'),
        },
      ],
      [record('grove-overload-arm-1')],
    );
    expect(entry.ownership).toBe('managed');
    expect(entry.group).toBe('overload-arm');
    expect(entry.index).toBe(1);
    expect(entry.record?.id).toBe(1);
  });

  it('calls a matching name with no record unmanaged', () => {
    const [entry] = classifyRunners(
      [
        {
          name: 'grove-overload-arm-1',
          host: 'mac',
          container: container('grove-overload-arm-1'),
        },
      ],
      [],
    );
    expect(entry.ownership).toBe('unmanaged');
  });

  it('calls a name that does not match foreign', () => {
    const [entry] = classifyRunners(
      [{ name: 'ci-runner-7', forge: 'gh-overload' }],
      [],
    );
    expect(entry.ownership).toBe('foreign');
  });

  it('calls a record with nothing behind it record-only', () => {
    const [entry] = classifyRunners([], [record('grove-overload-arm-1')]);
    expect(entry.ownership).toBe('record-only');
    expect(entry.host).toBe('mac');
    expect(entry.forge).toBe('gh-overload');
  });

  it('ignores a retired record', () => {
    const retired = { ...record('grove-overload-arm-1'), retiredAt: 10 };
    const entries = classifyRunners(
      [
        {
          name: 'grove-overload-arm-1',
          host: 'mac',
          container: container('grove-overload-arm-1'),
        },
      ],
      [retired],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].ownership).toBe('unmanaged');
  });

  it('merges the container and the forge runner for one name', () => {
    const [entry] = classifyRunners(
      [
        {
          name: 'grove-overload-arm-1',
          host: 'mac',
          container: container('grove-overload-arm-1'),
        },
        {
          name: 'grove-overload-arm-1',
          forge: 'gh-overload',
          scope: { level: 'organization', target: 'Overload-coach' },
          forgeRunner: {
            id: '11',
            name: 'grove-overload-arm-1',
            status: 'online',
            busy: false,
            labels: [],
          },
        },
      ],
      [record('grove-overload-arm-1')],
    );
    expect(entry.container?.containerId).toBe('abc');
    expect(entry.forgeRunner?.id).toBe('11');
    expect(entry.host).toBe('mac');
    expect(entry.forge).toBe('gh-overload');
  });

  it('keeps a record to the container on the host it names', () => {
    const entries = classifyRunners(
      [
        {
          name: 'grove-overload-arm-1',
          host: 'atlas',
          container: container('grove-overload-arm-1'),
        },
        {
          name: 'grove-overload-arm-1',
          host: 'mac',
          container: container('grove-overload-arm-1'),
        },
      ],
      [record('grove-overload-arm-1')],
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => [entry.host, entry.ownership])).toEqual([
      ['atlas', 'unmanaged'],
      ['mac', 'managed'],
    ]);
    expect(entries[0].record).toBeUndefined();
    expect(entries[1].record?.id).toBe(1);
  });

  it('keeps a record to the sighting at the forge it names', () => {
    const sighting = (forge: string, id: string) => ({
      name: 'grove-overload-arm-1',
      forge,
      scope: { level: 'organization', target: 'Overload-coach' } as const,
      forgeRunner: {
        id,
        name: 'grove-overload-arm-1',
        status: 'online' as const,
        busy: false,
        labels: [],
      },
    });
    const entries = classifyRunners(
      [sighting('gh-other', '999'), sighting('gh-overload', '11')],
      [record('grove-overload-arm-1')],
    );

    expect(entries).toHaveLength(2);
    const managed = entries.find((entry) => entry.ownership === 'managed');
    const unmanaged = entries.find((entry) => entry.ownership === 'unmanaged');
    expect(managed).toMatchObject({ forge: 'gh-overload' });
    expect(managed?.forgeRunner?.id).toBe('11');
    expect(unmanaged).toMatchObject({ forge: 'gh-other' });
    expect(unmanaged?.forgeRunner?.id).toBe('999');
  });

  it('reports a record whose name is only seen elsewhere as record-only', () => {
    const entries = classifyRunners(
      [
        {
          name: 'grove-overload-arm-1',
          host: 'atlas',
          container: container('grove-overload-arm-1'),
        },
      ],
      [record('grove-overload-arm-1')],
    );

    expect(entries.map((entry) => entry.ownership)).toEqual([
      'unmanaged',
      'record-only',
    ]);
    expect(entries[1]).toMatchObject({ host: 'mac', forge: 'gh-overload' });
  });

  it('sorts colliding entries by host and forge so a plan reads the same twice', () => {
    const entries = classifyRunners(
      [
        { name: 'grove-overload-arm-1', host: 'mac' },
        { name: 'grove-overload-arm-1', host: 'atlas' },
      ],
      [],
    );
    expect(entries.map((entry) => entry.host)).toEqual(['atlas', 'mac']);
  });

  it('sorts by name so a plan reads the same twice', () => {
    const entries = classifyRunners(
      [
        { name: 'grove-overload-arm-2', host: 'mac' },
        { name: 'grove-overload-arm-1', host: 'mac' },
      ],
      [],
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      'grove-overload-arm-1',
      'grove-overload-arm-2',
    ]);
  });
});

describe('isDestroyable', () => {
  it('allows managed always and unmanaged only on request', () => {
    const managed = classifyRunners(
      [{ name: 'grove-overload-arm-1', host: 'mac' }],
      [record('grove-overload-arm-1')],
    )[0];
    const unmanaged = classifyRunners(
      [{ name: 'grove-overload-arm-1', host: 'mac' }],
      [],
    )[0];
    const foreign = classifyRunners([{ name: 'other' }], [])[0];

    expect(isDestroyable(managed, false)).toBe(true);
    expect(isDestroyable(unmanaged, false)).toBe(false);
    expect(isDestroyable(unmanaged, true)).toBe(true);
    expect(isDestroyable(foreign, true)).toBe(false);
  });
});
