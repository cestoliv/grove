import { errorMessage } from '../lib/errors.js';
import {
  EXIT_INVALID_CONFIG,
  EXIT_OK,
  EXIT_UNREACHABLE,
} from '../lib/exit-codes.js';
import { DEFAULT_TAIL } from '../lib/log-defaults.js';
import { isManagedName, parseManagedName } from '../lib/naming.js';
import type { FleetContext, OpenFleet, OpenFleetOptions } from './context.js';
import { openFleetOrExit } from './pipeline.js';

export { DEFAULT_TAIL };

export interface LogTarget {
  name: string;
  host: string;
}

export interface LogsCommandOptions extends OpenFleetOptions {
  target?: string;
  follow?: boolean;
  tail?: number;
  openFleet?: OpenFleet;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function matchLogTargets(
  target: string,
  found: LogTarget[],
): LogTarget[] {
  if (isManagedName(target)) {
    return found.filter((entry) => entry.name === target);
  }
  return found.filter(
    (entry) => parseManagedName(entry.name)?.group === target,
  );
}

export async function runLogs(
  options: LogsCommandOptions = {},
): Promise<number> {
  const write =
    options.stdout ?? ((text: string) => process.stdout.write(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));
  const target = options.target ?? '';

  if (target.trim() === '') {
    writeError('grove logs needs a group name or a runner name.');
    return EXIT_INVALID_CONFIG;
  }

  // `logs` reads containers over the transport and never calls a forge, so it
  // must not fail on a token it will not use.
  const opened = await openFleetOrExit(
    { ...options, forges: false },
    writeError,
  );
  if (typeof opened === 'number') {
    return opened;
  }
  const fleet: FleetContext = opened;

  try {
    const found: LogTarget[] = [];
    const unreachable: string[] = [];
    for (const [host, stack] of fleet.stacks) {
      try {
        for (const container of await stack.listContainers()) {
          found.push({ name: container.name, host });
        }
      } catch (error) {
        unreachable.push(`${host}: ${errorMessage(error)}`);
      }
    }
    found.sort((left, right) => left.name.localeCompare(right.name));

    const matches = matchLogTargets(target, found);
    if (matches.length === 0) {
      writeError(
        `no runner matches "${target}". grove sees: ${found.length === 0 ? '(none)' : found.map((entry) => entry.name).join(', ')}`,
      );
      for (const reason of unreachable) {
        writeError(reason);
      }
      return EXIT_UNREACHABLE;
    }

    if (options.follow === true && matches.length > 1) {
      writeError(
        `--follow needs exactly one runner, and "${target}" matches ${matches.length}: ${matches.map((entry) => entry.name).join(', ')}`,
      );
      return EXIT_UNREACHABLE;
    }

    const tail = options.tail ?? DEFAULT_TAIL;
    let logsFailed = false;
    for (const match of matches) {
      if (matches.length > 1) {
        write(`==> ${match.name} on ${match.host} <==\n`);
      }
      const stack = fleet.stacks.get(match.host);
      if (stack === undefined) {
        continue;
      }
      const code = await stack.logs(match.name, {
        tail,
        ...(options.follow === undefined ? {} : { follow: options.follow }),
        onChunk: (chunk) => write(chunk),
      });
      if (code !== 0) {
        logsFailed = true;
        writeError(
          `logs for ${match.name} on ${match.host} failed (exit ${code})`,
        );
      }
    }

    return unreachable.length > 0 || logsFailed ? EXIT_UNREACHABLE : EXIT_OK;
  } finally {
    await fleet.close();
  }
}
