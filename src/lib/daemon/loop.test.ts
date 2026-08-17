import { describe, expect, it } from 'vitest';
import { controlPersistFor, runDaemonLoop, waitFor } from './loop.js';

describe('controlPersistFor', () => {
  // ssh closes the master ControlPersist seconds after the last call. A
  // window shorter than the fast tick means a fresh connection every tick,
  // which is the opposite of what the spec asks for.
  it('outlives the fast tick', () => {
    expect(controlPersistFor(120_000)).toBe('180');
    expect(controlPersistFor(30_000)).toBe('90');
  });

  it('rounds a fractional interval up', () => {
    expect(controlPersistFor(1500)).toBe('62');
  });
});

const MINUTE = 60_000;

interface Harness {
  kinds: string[];
  startedAt: number[];
  controller: AbortController;
  run: (stopAfter: number, tickCostMs?: number) => Promise<void>;
}

function harness(fastMs = 2 * MINUTE, fullMs = 30 * MINUTE): Harness {
  let clock = 0;
  const kinds: string[] = [];
  const startedAt: number[] = [];
  const controller = new AbortController();

  return {
    kinds,
    startedAt,
    controller,
    async run(stopAfter, tickCostMs = 0) {
      await runDaemonLoop({
        intervals: () => ({ fastMs, fullMs }),
        signal: controller.signal,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
        runTick: async (kind) => {
          kinds.push(kind);
          startedAt.push(clock);
          clock += tickCostMs;
          if (kinds.length >= stopAfter) {
            controller.abort();
          }
        },
      });
    },
  };
}

describe('runDaemonLoop', () => {
  it('runs a full tick at once, so an install converges now', async () => {
    const test = harness();
    await test.run(1);
    expect(test.kinds).toEqual(['full']);
    expect(test.startedAt).toEqual([0]);
  });

  it('alternates on the two cadences the config names', async () => {
    const test = harness();
    await test.run(4);
    expect(test.kinds).toEqual(['full', 'fast', 'fast', 'fast']);
    expect(test.startedAt).toEqual([0, 2 * MINUTE, 4 * MINUTE, 6 * MINUTE]);
  });

  it('replaces the coinciding fast tick with the full one', async () => {
    const test = harness(10 * MINUTE, 30 * MINUTE);
    await test.run(5);
    expect(test.kinds).toEqual(['full', 'fast', 'fast', 'full', 'fast']);
    expect(test.startedAt).toEqual([
      0,
      10 * MINUTE,
      20 * MINUTE,
      30 * MINUTE,
      40 * MINUTE,
    ]);
  });

  it('lets a tick that overruns delay the next one rather than stack', async () => {
    const test = harness();
    await test.run(3, 5 * MINUTE);
    // Each tick takes five minutes and the next is scheduled two minutes
    // after it finished, so ticks start seven minutes apart.
    expect(test.startedAt).toEqual([0, 7 * MINUTE, 14 * MINUTE]);
  });

  it('logs a tick that threw and keeps going', async () => {
    let clock = 0;
    const controller = new AbortController();
    const errors: string[] = [];
    let calls = 0;

    await runDaemonLoop({
      intervals: () => ({ fastMs: MINUTE, fullMs: 30 * MINUTE }),
      signal: controller.signal,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      onError: (error) => errors.push(String(error)),
      runTick: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('atlas exploded');
        }
        if (calls >= 3) {
          controller.abort();
        }
      },
    });

    expect(errors).toEqual(['Error: atlas exploded']);
    expect(calls).toBe(3);
  });

  it('reads the intervals again on every tick, so an edit applies at once', async () => {
    let clock = 0;
    let fastMs = 10 * MINUTE;
    const controller = new AbortController();
    const startedAt: number[] = [];

    await runDaemonLoop({
      intervals: () => ({ fastMs, fullMs: 30 * MINUTE }),
      signal: controller.signal,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      runTick: async () => {
        startedAt.push(clock);
        fastMs = MINUTE;
        if (startedAt.length >= 3) {
          controller.abort();
        }
      },
    });

    expect(startedAt).toEqual([0, MINUTE, 2 * MINUTE]);
  });

  it('does nothing at all when it starts already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await runDaemonLoop({
      intervals: () => ({ fastMs: MINUTE, fullMs: MINUTE }),
      signal: controller.signal,
      runTick: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(0);
  });
});

describe('waitFor', () => {
  it('returns as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const waited = waitFor(60_000, controller.signal);
    controller.abort();
    await expect(waited).resolves.toBeUndefined();
  });
});
