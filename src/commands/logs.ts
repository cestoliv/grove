import type { GroupConfig, StackKind } from '../lib/config/index.js';
import { errorMessage } from '../lib/errors.js';
import {
  EXIT_INVALID_CONFIG,
  EXIT_OK,
  EXIT_UNREACHABLE,
} from '../lib/exit-codes.js';
import { DEFAULT_TAIL } from '../lib/log-defaults.js';
import { isManagedName, parseManagedName } from '../lib/naming.js';
import { type HostObservation, observeFleet } from '../lib/reconcile/index.js';
import {
  buildNativeTarget,
  isDarwinPlatform,
  LINGER_HINT,
  NativeStack,
  NO_USER_BUS,
} from '../lib/stack/index.js';
import type { FleetContext, OpenFleet, OpenFleetOptions } from './context.js';
import { openFleetOrExit } from './pipeline.js';

export { DEFAULT_TAIL };

export interface LogTarget {
  name: string;
  host: string;
  stack: StackKind;
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

// A native seat keeps its logs beside its install directory, and grove needs
// the group and the host home to derive that path. A seat whose group left
// the config is a seat grove can no longer place, and saying so beats
// guessing at a path.
async function readNativeLogs(
  fleet: FleetContext,
  observation: HostObservation | undefined,
  match: LogTarget,
  options: { tail: number; follow?: boolean; write: (text: string) => void },
): Promise<number> {
  const parsed = parseManagedName(match.name);
  const group: GroupConfig | undefined = fleet.loaded.config.groups.find(
    (entry) => entry.name === parsed?.group,
  );
  if (parsed === null || group === undefined) {
    throw new Error(
      `${match.name} on ${match.host} belongs to group "${parsed?.group ?? match.name}", which is no longer in the config, so grove cannot find its logs`,
    );
  }
  const transport = fleet.transports.get(match.host);
  const home = observation?.home;
  if (transport === undefined || home === undefined) {
    throw new Error(
      `grove could not read $HOME on host "${match.host}", so it cannot find the logs of ${match.name}`,
    );
  }
  const target = buildNativeTarget({
    group,
    host: fleet.loaded.config.hosts[match.host],
    index: parsed.index,
    home,
  });
  const native = new NativeStack({
    transport,
    host: match.host,
    platform: observation?.platform ?? 'Linux',
    ...(observation?.uid === undefined ? {} : { uid: observation.uid }),
  });
  const isDarwin = isDarwinPlatform(observation?.platform);
  let sawBusError = false;
  const code = await native.logs(target, {
    tail: options.tail,
    ...(options.follow === undefined ? {} : { follow: options.follow }),
    onChunk: (chunk) => {
      if (!isDarwin) {
        sawBusError ||= NO_USER_BUS.test(chunk);
      }
      options.write(chunk);
    },
  });
  if (code !== 0 && sawBusError) {
    throw new Error(
      `${match.host}: journalctl could not reach the user bus for ${match.name}. ${LINGER_HINT}`,
    );
  }
  return code;
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

  // `logs` reads the hosts and never calls a forge, so it must not fail on a
  // token it will not use.
  const opened = await openFleetOrExit(
    { ...options, forges: false },
    writeError,
  );
  if (typeof opened === 'number') {
    return opened;
  }
  const fleet: FleetContext = opened;

  try {
    // No forge client means no forge call, and the two host queries are the
    // ones this command needs anyway.
    const observed = await observeFleet(fleet.loaded.config, {
      transports: fleet.transports,
      forgeClients: new Map(),
      forgeLimit: fleet.forgeLimit,
    });

    const found: LogTarget[] = [];
    // A host grove could not reach at all keeps the command from succeeding.
    const hostErrors: string[] = [];
    // A stack grove could not query on an otherwise reachable host explains a
    // no-match. It never turns a match found elsewhere into a failure.
    const explain: string[] = [];
    const byHost = new Map<string, HostObservation>();
    for (const observation of observed.hosts) {
      byHost.set(observation.host, observation);
      if (!observation.reachable) {
        hostErrors.push(
          `${observation.host}: ${observation.reason ?? 'unreachable'}`,
        );
        continue;
      }
      if (observation.containersError !== undefined) {
        explain.push(observation.containersError);
      }
      if (observation.nativesError !== undefined) {
        explain.push(observation.nativesError);
      }
      for (const container of observation.containers) {
        found.push({
          name: container.name,
          host: observation.host,
          stack: 'docker',
        });
      }
      for (const unit of observation.natives ?? []) {
        found.push({
          name: unit.name,
          host: observation.host,
          stack: 'native',
        });
      }
    }
    found.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.host.localeCompare(right.host),
    );

    const matches = matchLogTargets(target, found);
    if (matches.length === 0) {
      writeError(
        `no runner matches "${target}". grove sees: ${found.length === 0 ? '(none)' : found.map((entry) => entry.name).join(', ')}`,
      );
      for (const reason of [...hostErrors, ...explain]) {
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
      let code: number;
      try {
        if (match.stack === 'native') {
          code = await readNativeLogs(fleet, byHost.get(match.host), match, {
            tail,
            ...(options.follow === undefined ? {} : { follow: options.follow }),
            write,
          });
        } else {
          const stack = fleet.stacks.get(match.host);
          if (stack === undefined) {
            continue;
          }
          code = await stack.logs(match.name, {
            tail,
            ...(options.follow === undefined ? {} : { follow: options.follow }),
            onChunk: (chunk) => write(chunk),
          });
        }
      } catch (error) {
        logsFailed = true;
        writeError(errorMessage(error));
        continue;
      }
      if (code !== 0) {
        logsFailed = true;
        writeError(
          `logs for ${match.name} on ${match.host} failed (exit ${code})`,
        );
      }
    }

    return hostErrors.length > 0 || logsFailed ? EXIT_UNREACHABLE : EXIT_OK;
  } finally {
    await fleet.close();
  }
}
