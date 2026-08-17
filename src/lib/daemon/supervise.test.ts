import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import type { ObservedState } from '../reconcile/index.js';
import { StateStore } from '../state/index.js';
import { FakeTransport } from '../transport/index.js';
import { superviseFleet } from './supervise.js';

const MINUTE = 60_000;

function config(overrides: Record<string, unknown> = {}): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { mac: { type: 'local', work_root: '/Volumes/ci/grove' } },
    forges: { 'gh-overload': { kind: 'github' } },
    groups: [
      {
        name: 'ios',
        forge: 'gh-overload',
        scope: { level: 'organization', target: 'Overload-coach' },
        placement: { mac: 1 },
        stack: 'docker',
        max_job_duration: 90 * MINUTE,
        ...overrides,
      },
    ],
  } as unknown as GroveConfig;
}

function observed(options: {
  busy?: boolean;
  registered?: boolean;
  running?: boolean;
}): ObservedState {
  const registered = options.registered ?? true;
  const running = options.running ?? true;
  return {
    hosts: [
      {
        host: 'mac',
        reachable: true,
        platform: 'Darwin',
        home: '/Users/olivier',
        containers: running
          ? [
              {
                name: 'grove-ios-1',
                containerId: 'abc',
                state: 'running',
                image: 'runner',
                status: 'Up 2 hours',
                createdAt: 'now',
              },
            ]
          : [],
        workRoots: {},
      },
    ],
    forges: registered
      ? [
          {
            forge: 'gh-overload',
            reachable: true,
            runners: [
              {
                runner: {
                  id: '9',
                  name: 'grove-ios-1',
                  status: 'online',
                  busy: options.busy ?? false,
                  labels: [],
                },
                scope: { level: 'organization', target: 'Overload-coach' },
              },
            ],
          },
        ]
      : [{ forge: 'gh-overload', reachable: true, runners: [] }],
  };
}

let store: StateStore;
let recordId: number;

beforeEach(() => {
  store = StateStore.open(':memory:');
  recordId = store.createRunner({
    group: 'ios',
    index: 1,
    host: 'mac',
    forge: 'gh-overload',
    name: 'grove-ios-1',
  }).id;
});

afterEach(() => {
  store.close();
});

function transports(activity: string): ReadonlyMap<string, FakeTransport> {
  return new Map([
    ['mac', new FakeTransport('mac').on('sh -c', { stdout: activity })],
  ]);
}

async function supervise(
  state: ObservedState,
  now: number,
  activity = 'grove-ios-1\tactive\n',
  planned: Parameters<typeof superviseFleet>[0]['planned'] = [],
) {
  return superviseFleet({
    config: config(),
    observed: state,
    records: store.activeRunners(),
    store,
    transports: transports(activity),
    planned,
    fullIntervalMs: 30 * MINUTE,
    now: () => now,
  });
}

describe('job history', () => {
  it('opens a job when the forge first says busy', async () => {
    await supervise(observed({ busy: true }), 1000);
    expect(store.openJob(recordId)?.startedAt).toBe(1000);
    expect(store.watchFor(recordId).busySince).toBe(1000);
  });

  it('closes it when the forge stops saying busy', async () => {
    await supervise(observed({ busy: true }), 1000);
    await supervise(observed({ busy: false }), 1000 + 5 * MINUTE);
    expect(store.openJob(recordId)).toBeUndefined();
    const [job] = store.jobsFor(recordId);
    expect(job.durationMs).toBe(5 * MINUTE);
    expect(job.outcome).toBe('unknown');
    expect(store.watchFor(recordId).busySince).toBeNull();
  });
});

describe('stuck detection', () => {
  it('restarts when both signals agree', async () => {
    await supervise(observed({ busy: true }), 0);
    const result = await supervise(
      observed({ busy: true }),
      100 * MINUTE,
      'grove-ios-1\tquiet\n',
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe('restart-runner');
    expect(result.actions[0]).toMatchObject({
      host: 'mac',
      name: 'grove-ios-1',
      recordId,
      destructive: true,
    });
    expect((result.actions[0] as { reason: string }).reason).toContain('100m');
    expect((result.actions[0] as { reason: string }).reason).toContain(
      'work dir',
    );
    // The job grove is about to kill ends here, with an outcome that says why.
    expect(store.jobsFor(recordId)[0].outcome).toBe('restarted');
    // And the busy clock goes with it, so nothing is left open behind it.
    expect(store.watchFor(recordId).busySince).toBeNull();
    expect(store.openJob(recordId)).toBeUndefined();
  });

  it('opens a fresh job on the next tick that still sees busy', async () => {
    await supervise(observed({ busy: true }), 0);
    await supervise(
      observed({ busy: true }),
      100 * MINUTE,
      'grove-ios-1\tquiet\n',
    );
    const after = await supervise(observed({ busy: true }), 130 * MINUTE);

    // The new job is measured from here, not from the job grove just killed,
    // so the forge signal does not fire again on the strength of the old one.
    expect(store.openJob(recordId)?.startedAt).toBe(130 * MINUTE);
    expect(store.watchFor(recordId).busySince).toBe(130 * MINUTE);
    expect(after.jobsStarted).toEqual(['grove-ios-1']);
    expect(after.actions).toEqual([]);

    // And when it goes idle, exactly one end is reported for one open job.
    const idle = await supervise(observed({ busy: false }), 140 * MINUTE);
    expect(idle.jobsEnded).toEqual(['grove-ios-1']);
    expect(store.jobsFor(recordId).map((job) => job.outcome)).toEqual([
      'unknown',
      'restarted',
    ]);
  });

  it('reports a suspect when only the forge signal fires', async () => {
    await supervise(observed({ busy: true }), 0);
    const result = await supervise(observed({ busy: true }), 100 * MINUTE);

    expect(result.actions.map((action) => action.kind)).toEqual([
      'report-suspect',
    ]);
    expect(result.suspects[0].fresh).toBe(true);
    expect(result.suspects[0].reason).toContain('100m');
    expect(store.watchFor(recordId).suspectSince).toBe(100 * MINUTE);
  });

  it('reports a suspect when only the host signal fires', async () => {
    await supervise(observed({ busy: true }), 0);
    const result = await supervise(
      observed({ busy: true }),
      10 * MINUTE,
      'grove-ios-1\tquiet\n',
    );
    expect(result.actions.map((action) => action.kind)).toEqual([
      'report-suspect',
    ]);
    expect(result.suspects[0].reason).toContain('work dir');
  });

  it('reports a stale suspect as not fresh, so the log says it once', async () => {
    await supervise(observed({ busy: true }), 0);
    await supervise(observed({ busy: true }), 100 * MINUTE);
    const again = await supervise(observed({ busy: true }), 130 * MINUTE);
    expect(again.suspects[0].fresh).toBe(false);
  });

  it('never restarts a group that names no max_job_duration', async () => {
    const bare = {
      ...config(),
      groups: [{ ...config().groups[0], max_job_duration: undefined }],
    } as GroveConfig;
    await superviseFleet({
      config: bare,
      observed: observed({ busy: true }),
      records: store.activeRunners(),
      store,
      transports: transports('grove-ios-1\tquiet\n'),
      planned: [],
      fullIntervalMs: 30 * MINUTE,
      now: () => 0,
    });
    const result = await superviseFleet({
      config: bare,
      observed: observed({ busy: true }),
      records: store.activeRunners(),
      store,
      transports: transports('grove-ios-1\tquiet\n'),
      planned: [],
      fullIntervalMs: 30 * MINUTE,
      now: () => 500 * MINUTE,
    });
    expect(result.actions.map((action) => action.kind)).toEqual([
      'report-suspect',
    ]);
  });

  it('never acts on an idle seat, however quiet its work dir is', async () => {
    const result = await supervise(
      observed({ busy: false }),
      500 * MINUTE,
      'grove-ios-1\tquiet\n',
    );
    expect(result.actions).toEqual([]);
  });

  it('treats an unreadable work dir as unknown rather than quiet', async () => {
    await supervise(observed({ busy: true }), 0);
    const result = await supervise(
      observed({ busy: true }),
      100 * MINUTE,
      'grove-ios-1\terror\n',
    );
    expect(result.actions.map((action) => action.kind)).toEqual([
      'report-suspect',
    ]);
  });

  // A store with a clock of its own, so the restart history sits at times the
  // test chose rather than at whatever Date.now happens to be.
  function withRestartsAt(times: number[]): StateStore {
    let clock = 0;
    const ticking = StateStore.open(':memory:', { now: () => clock });
    const id = ticking.createRunner({
      group: 'ios',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-ios-1',
    }).id;
    for (const at of times) {
      clock = at;
      ticking.recordEvent(id, 'restarted', 'wedged');
    }
    // Busy since the epoch, so the forge signal is well past 90m at any of
    // the times below.
    ticking.setWatch(id, {
      busySince: 0,
      unregisteredSince: null,
      suspectSince: null,
      suspectReason: null,
    });
    return ticking;
  }

  async function superviseWith(ticking: StateStore, now: number) {
    return superviseFleet({
      config: config(),
      observed: observed({ busy: true }),
      records: ticking.activeRunners(),
      store: ticking,
      transports: transports('grove-ios-1\tquiet\n'),
      planned: [],
      fullIntervalMs: 30 * MINUTE,
      now: () => now,
    });
  }

  it('holds off inside the cooldown', async () => {
    const ticking = withRestartsAt([100 * MINUTE]);
    // Five minutes after the last restart, and the cooldown is ten.
    const result = await superviseWith(ticking, 105 * MINUTE);

    expect(result.actions.map((action) => action.kind)).toEqual([
      'report-suspect',
    ]);
    expect(result.suspects[0].reason).toContain('cooldown');
    ticking.close();
  });

  it('holds off past three restarts in a rolling hour', async () => {
    const ticking = withRestartsAt([100 * MINUTE, 110 * MINUTE, 120 * MINUTE]);
    // Past the cooldown, and all three restarts are inside the last hour.
    const result = await superviseWith(ticking, 135 * MINUTE);

    expect(result.actions.map((action) => action.kind)).toEqual([
      'report-suspect',
    ]);
    expect(result.suspects[0].reason).toContain('3 restarts');
    ticking.close();
  });

  it('restarts again once the hour has rolled past', async () => {
    const ticking = withRestartsAt([100 * MINUTE, 110 * MINUTE, 120 * MINUTE]);
    // The window now starts at 140m, so none of the three counts.
    const result = await superviseWith(ticking, 200 * MINUTE);

    expect(result.actions.map((action) => action.kind)).toEqual([
      'restart-runner',
    ]);
    ticking.close();
  });

  it('leaves a seat the reconciler already claimed alone', async () => {
    await supervise(observed({ busy: true }), 0);
    const result = await supervise(
      observed({ busy: true }),
      100 * MINUTE,
      'grove-ios-1\tquiet\n',
      [
        {
          kind: 'stop-container',
          host: 'mac',
          name: 'grove-ios-1',
          drainTimeoutMs: 1000,
          destructive: true,
        },
      ],
    );
    expect(result.actions).toEqual([]);
  });
});

describe('re-registration', () => {
  it('waits one full tick before acting on a seat the forge stopped listing', async () => {
    const first = await supervise(observed({ registered: false }), 0);
    expect(first.actions).toEqual([]);
    expect(store.watchFor(recordId).unregisteredSince).toBe(0);
  });

  it('stops, removes and recreates the seat against a fresh token', async () => {
    await supervise(observed({ registered: false }), 0);
    const result = await supervise(
      observed({ registered: false }),
      31 * MINUTE,
    );

    expect(result.actions.map((action) => action.kind)).toEqual([
      'stop-container',
      'remove-container',
      'create-runner',
    ]);
    // The same record, so grove never owns a runner it has no row for and
    // never deregisters anything, because the forge lists nothing to delete.
    expect(result.actions[2]).toMatchObject({
      recordId,
      name: 'grove-ios-1',
      group: 'ios',
      index: 1,
      destructive: false,
    });
    expect(result.reregistered).toEqual(['grove-ios-1']);
    expect(store.watchFor(recordId).unregisteredSince).toBeNull();
  });

  it('forgets the condition as soon as the forge lists the seat again', async () => {
    await supervise(observed({ registered: false }), 0);
    await supervise(observed({ registered: true }), 10 * MINUTE);
    expect(store.watchFor(recordId).unregisteredSince).toBeNull();
  });

  it('says nothing about a seat whose container is gone, because that is a create', async () => {
    const result = await supervise(
      observed({ registered: false, running: false }),
      31 * MINUTE,
    );
    expect(result.actions).toEqual([]);
  });

  it('never re-registers a seat on a shared forge, where no sighting means no system id', async () => {
    // GitLab gives a whole group one runner entity, so a seat grove cannot
    // find there means grove has not learned its system id yet, not that the
    // forge has forgotten it.
    const gitlab = {
      ...config(),
      forges: { 'gl-lab': { kind: 'gitlab' } },
      groups: [{ ...config().groups[0], forge: 'gl-lab' }],
    } as unknown as GroveConfig;
    const lab = StateStore.open(':memory:');
    lab.createRunner({
      group: 'ios',
      index: 1,
      host: 'mac',
      forge: 'gl-lab',
      name: 'grove-ios-1',
    });
    const state: ObservedState = {
      hosts: observed({ registered: false }).hosts,
      forges: [{ forge: 'gl-lab', reachable: true, shared: true, runners: [] }],
    };
    const run = async (now: number) =>
      superviseFleet({
        config: gitlab,
        observed: state,
        records: lab.activeRunners(),
        store: lab,
        transports: transports('grove-ios-1\tactive\n'),
        planned: [],
        fullIntervalMs: 30 * MINUTE,
        now: () => now,
      });

    expect((await run(0)).actions).toEqual([]);
    const later = await run(31 * MINUTE);
    expect(later.actions).toEqual([]);
    expect(later.reregistered).toEqual([]);
    lab.close();
  });

  it('never re-registers a seat whose forge did not answer, however long the silence lasts', async () => {
    const blind: ObservedState = {
      ...observed({ registered: false }),
      forges: [
        {
          forge: 'gh-overload',
          reachable: false,
          reason: 'timeout',
          runners: [],
        },
      ],
    };
    expect((await supervise(blind, 0)).actions).toEqual([]);
    const later = await supervise(blind, 31 * MINUTE);
    expect(later.actions).toEqual([]);
    expect(later.reregistered).toEqual([]);
    // Silence never starts the clock, so the interval is always measured
    // against ticks where the forge actually answered.
    expect(store.watchFor(recordId).unregisteredSince).toBeNull();
  });
});

describe('guards', () => {
  it('does nothing when the forge did not answer', async () => {
    const blind: ObservedState = {
      ...observed({ busy: true }),
      forges: [
        {
          forge: 'gh-overload',
          reachable: false,
          reason: 'timeout',
          runners: [],
        },
      ],
    };
    expect((await supervise(blind, 500 * MINUTE)).actions).toEqual([]);
  });

  it('does nothing when the host did not answer', async () => {
    const blind: ObservedState = {
      ...observed({ busy: true }),
      hosts: [
        {
          host: 'mac',
          reachable: false,
          reason: 'ssh timeout',
          containers: [],
          workRoots: {},
        },
      ],
    };
    expect((await supervise(blind, 500 * MINUTE)).actions).toEqual([]);
  });

  it('never wipes a work dir on a disk that is not mounted', async () => {
    const fallen: ObservedState = {
      ...observed({ busy: true }),
      hosts: [
        {
          ...observed({ busy: true }).hosts[0],
          workRoots: {
            ios: {
              guarded: true,
              ok: false,
              reason: 'the disk is not mounted',
            },
          },
        },
      ],
    };
    await superviseFleet({
      config: config(),
      observed: fallen,
      records: store.activeRunners(),
      store,
      transports: transports('grove-ios-1\tquiet\n'),
      planned: [],
      fullIntervalMs: 30 * MINUTE,
      now: () => 0,
    });
    const result = await superviseFleet({
      config: config(),
      observed: fallen,
      records: store.activeRunners(),
      store,
      transports: transports('grove-ios-1\tquiet\n'),
      planned: [],
      fullIntervalMs: 30 * MINUTE,
      now: () => 500 * MINUTE,
    });
    expect(result.actions).toEqual([]);
  });

  it('does nothing when the stack layer on the host errored', async () => {
    await supervise(observed({ busy: true }), 0);
    const blind: ObservedState = {
      ...observed({ busy: true }),
      hosts: [
        {
          ...observed({ busy: true }).hosts[0],
          containers: [],
          containersError: 'docker: command not found',
        },
      ],
    };

    // Silence from the supervisor that holds this seat is not absence. Grove
    // must not read it as a missing container, and it decides nothing about a
    // seat it cannot see.
    const result = await supervise(blind, 500 * MINUTE, 'grove-ios-1\tquiet\n');
    expect(result.actions).toEqual([]);
    expect(result.suspects).toEqual([]);
  });

  it('waits a tick before the host signal counts', async () => {
    // Pass one sets busy_since to now, so the job has had no time to write
    // anything under the work dir yet. A quiet work dir on that same pass says
    // nothing, and reporting it would train the operator to ignore the word.
    const first = await supervise(
      observed({ busy: true }),
      1000,
      'grove-ios-1\tquiet\n',
    );
    expect(first.actions).toEqual([]);
    expect(first.suspects).toEqual([]);
    expect(store.watchFor(recordId).suspectSince).toBeNull();

    // The next full tick compares against a busy clock that predates it, so
    // the signal counts.
    const second = await supervise(
      observed({ busy: true }),
      1000 + 30 * MINUTE,
      'grove-ios-1\tquiet\n',
    );
    expect(second.suspects.map((finding) => finding.name)).toEqual([
      'grove-ios-1',
    ]);
  });
});

describe('an unmeasurable host', () => {
  it('is named when the activity probe answered for nobody', async () => {
    await supervise(observed({ busy: true }), 0);

    // Every seat unknown is one host failure, not one per seat, and the tick
    // turns it into one line the way it does for an unmeasurable prune.
    const result = await supervise(observed({ busy: true }), 100 * MINUTE, '');
    expect(result.unmeasurableHosts).toEqual(['mac']);
  });

  it('is not named when the probe answered', async () => {
    await supervise(observed({ busy: true }), 0);
    const result = await supervise(
      observed({ busy: true }),
      100 * MINUTE,
      'grove-ios-1\tquiet\n',
    );
    expect(result.unmeasurableHosts).toEqual([]);
  });
});
