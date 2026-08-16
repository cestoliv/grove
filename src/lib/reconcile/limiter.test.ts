import { describe, expect, it } from 'vitest';
import { createLimiter } from './limiter.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createLimiter', () => {
  it('never runs more than the limit at once', async () => {
    const limiter = createLimiter(2);
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      limiter(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    expect(peak).toBe(2);
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it('returns the value the task returns', async () => {
    const limiter = createLimiter(1);
    await expect(limiter(async () => 42)).resolves.toBe(42);
  });

  it('releases the slot when a task throws', async () => {
    const limiter = createLimiter(1);
    await expect(
      limiter(async () => Promise.reject(new Error('no'))),
    ).rejects.toThrow('no');
    await expect(limiter(async () => 'ok')).resolves.toBe('ok');
  });
});
