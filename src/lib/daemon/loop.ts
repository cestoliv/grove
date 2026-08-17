import type { TickKind } from './tick.js';

// One minute of slack past the fast tick. ssh keeps the master socket open
// for ControlPersist seconds after the last call, so anything shorter than
// the tick interval reconnects on every tick and the spec's one connection
// per host stops being one connection.
const CONTROL_PERSIST_SLACK_SECONDS = 60;

export function controlPersistFor(fastIntervalMs: number): string {
  return String(
    Math.ceil(fastIntervalMs / 1000) + CONTROL_PERSIST_SLACK_SECONDS,
  );
}

export interface TickIntervals {
  fastMs: number;
  fullMs: number;
}

export interface DaemonLoopOptions {
  // Read on every pass rather than captured once, so an edit to `tick` in the
  // config applies from the next tick and not from the next restart.
  intervals: () => TickIntervals;
  runTick: (kind: TickKind) => Promise<void>;
  signal: AbortSignal;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown, kind: TickKind) => void;
}

export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    // Deliberately not unref'd. The timer is what keeps the daemon process
    // alive between ticks.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One chain rather than two timers. The loop sleeps until whichever tick is
 * due first, runs it, and schedules from the moment that tick finished. So a
 * tick that overruns delays the next one instead of stacking behind it, and a
 * full tick replaces the fast tick it coincides with.
 */
export async function runDaemonLoop(options: DaemonLoopOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;

  // Both due immediately, so the first tick is a full one and an install
  // converges the fleet now rather than in half an hour.
  let nextFast = now();
  let nextFull = now();

  while (!options.signal.aborted) {
    const delay = Math.min(nextFast, nextFull) - now();
    if (delay > 0) {
      await wait(delay, options.signal);
    }
    if (options.signal.aborted) {
      return;
    }

    const kind: TickKind = now() >= nextFull ? 'full' : 'fast';
    try {
      await options.runTick(kind);
    } catch (error) {
      // A daemon that dies on one bad pass is the failure mode the daemon
      // exists to prevent.
      options.onError?.(error, kind);
    }

    const after = now();
    const { fastMs, fullMs } = options.intervals();
    nextFast = after + fastMs;
    if (kind === 'full') {
      nextFull = after + fullMs;
    }
  }
}
