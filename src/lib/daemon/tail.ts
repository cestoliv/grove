import { open, stat as statPath } from 'node:fs/promises';

// How much of the end of the file the first read looks at. A log sitting at
// the rollover threshold is 50 MB, and reading all of it to print twenty
// lines would be a waste of a good idea.
export const TAIL_WINDOW_BYTES = 256 * 1024;

// fs.watch behaves differently on macOS and Linux and misses writes on a
// network filesystem. Half a second of latency on a log a human is reading is
// invisible, so grove polls.
export const TAIL_POLL_INTERVAL_MS = 500;

/**
 * The last `lines` complete lines. A window read from the end of a file can
 * start mid-line, so a leading partial is dropped whenever there is more
 * than one line to choose from. When the window holds `lines` or fewer
 * lines, a leading partial may survive rather than be dropped for nothing.
 */
export function lastLines(text: string, lines: number): string {
  if (text === '') {
    return '';
  }
  const trailing = text.endsWith('\n');
  const all = text.split('\n');
  if (trailing) {
    all.pop();
  }
  const kept = all.slice(Math.max(0, all.length - lines));
  if (kept.length === 0) {
    return '';
  }
  return `${kept.join('\n')}${trailing ? '\n' : ''}`;
}

export interface TailOptions {
  lines: number;
  follow?: boolean;
  write: (text: string) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  windowBytes?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// A plain `options.signal?.aborted` check narrows across the `await` in the
// poll loop below, so TypeScript treats it as permanently false even though
// the signal can flip mid-await. Routing it through a function call sidesteps
// that narrowing.
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function tailFile(
  path: string,
  options: TailOptions,
): Promise<void> {
  const windowBytes = options.windowBytes ?? TAIL_WINDOW_BYTES;
  const pollIntervalMs = options.pollIntervalMs ?? TAIL_POLL_INTERVAL_MS;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch {
    throw new Error(
      `no daemon log at ${path}. Run "grove daemon install" to start the control loop, or "grove daemon status" to see whether it is running.`,
    );
  }

  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - windowBytes);
    const length = stat.size - start;
    let position = stat.size;
    if (length > 0) {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      // A window that did not start at the beginning may open mid-line, and
      // lastLines drops that partial for us.
      options.write(lastLines(buffer.toString('utf8'), options.lines));
    }

    if (options.follow !== true) {
      return;
    }

    while (!isAborted(options.signal)) {
      await sleep(pollIntervalMs);
      if (isAborted(options.signal)) {
        return;
      }

      const handleStat = await handle.stat();

      // DaemonLog rolls by renaming grove.log to grove.log.1 and creating a
      // fresh grove.log, not by truncating in place. The open handle keeps
      // reading the renamed file, whose size never moves again, so a
      // size-only check misses this. Stat the path itself and compare
      // identity with the open handle to catch it. The path can briefly
      // resolve to nothing between the rename and the new file landing;
      // treat that as "no rotation yet" and check again next poll.
      let pathStat: Awaited<ReturnType<typeof statPath>> | undefined;
      try {
        pathStat = await statPath(path);
      } catch {
        pathStat = undefined;
      }
      const rotated =
        pathStat !== undefined &&
        (pathStat.ino !== handleStat.ino || pathStat.dev !== handleStat.dev);

      if (rotated) {
        // Drain whatever the old file still holds beyond what was already
        // read before switching to the new one, so nothing written just
        // before the rename is lost.
        if (handleStat.size > position) {
          const length = handleStat.size - position;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, position);
          options.write(buffer.toString('utf8'));
        }
        await handle.close();
        handle = await open(path, 'r');
        position = 0;
      }

      const next = await handle.stat();
      if (next.size < position) {
        // Same-inode shrink: something replaced the file's contents in
        // place (as a truncating rewrite does) rather than renaming it.
        await handle.close();
        handle = await open(path, 'r');
        position = 0;
        continue;
      }
      if (next.size === position) {
        continue;
      }
      const length = next.size - position;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      position = next.size;
      options.write(buffer.toString('utf8'));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}
