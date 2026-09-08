import { join } from 'node:path';
import { isPidAlive } from '../lib/daemon/lock.js';
import { DAEMON_LOCK_FILE, daemonLockPath } from '../lib/daemon/paths.js';
import { EXIT_OK, EXIT_UNREACHABLE } from '../lib/exit-codes.js';
import {
  type QueueReport,
  readQueue,
  runnersByGroup,
} from '../lib/queue/index.js';
import {
  type HostObservation,
  type ObservedState,
  observeFleet,
  persistSystemIds,
} from '../lib/reconcile/index.js';
import {
  type HostStorage,
  readHostStorage,
  seatWorkDirTargets,
} from '../lib/stack/index.js';
import {
  META_DAEMON_PID,
  META_LAST_FAST_TICK,
  META_LAST_FULL_TICK,
  type StateStore,
} from '../lib/state/index.js';
import { type CurrentJob, readCurrentJob } from '../lib/status/current-job.js';
import { type LiveScreen, startLiveScreen } from '../lib/status/live.js';
import { renderStatusReport } from '../lib/status/render.js';
import {
  buildStatusReport,
  type DaemonStatus,
  jobKey,
  livenessFor,
  type StatusReport,
  type SuspectRow,
} from '../lib/status/report.js';
import type { Transport } from '../lib/transport/index.js';
import type { FleetContext } from './context.js';
import { openFleetOrExit } from './pipeline.js';
import type { PlanCommandOptions } from './plan.js';

export interface StatusCommandOptions extends PlanCommandOptions {
  json?: boolean;
  isPidAlive?: (pid: number) => boolean;
  // Redraw the report in place as each host, forge and storage read lands.
  // Left unset it follows the terminal: on for an interactive `grove status`,
  // off for a pipe, for `--json` and for every test, which all take the
  // single final print instead.
  live?: boolean;
  liveStdout?: (text: string) => void;
  liveColumns?: number;
  liveRows?: number;
  liveIntervalMs?: number;
  // The sweep costs one forge call per active repository or project, so
  // `--no-queue` buys back a fast status.
  queue?: boolean;
}

function readTick(store: StateStore, key: string): number | undefined {
  const value = store.getMeta(key);
  if (value === undefined) {
    return undefined;
  }
  const ts = Number(value);
  return Number.isFinite(ts) ? ts : undefined;
}

function wantsLive(options: StatusCommandOptions): boolean {
  // `--json` is machine output and never redraws, whatever the terminal is.
  return (
    options.json !== true &&
    (options.live ??
      (options.stdout === undefined && process.stdout.isTTY === true))
  );
}

function suspectsFor(store: StateStore): SuspectRow[] {
  const suspects: SuspectRow[] = [];
  for (const record of store.activeRunners()) {
    const watch = store.watchFor(record.id);
    if (watch.suspectSince === null || watch.suspectReason === null) {
      continue;
    }
    suspects.push({
      runner: record.name,
      host: record.host,
      since: watch.suspectSince,
      reason: watch.suspectReason,
    });
  }
  return suspects;
}

function daemonStatusFor(
  store: StateStore,
  options: StatusCommandOptions,
): DaemonStatus {
  const lockPath =
    options.stateDir === undefined
      ? daemonLockPath({ env: options.env ?? process.env })
      : join(options.stateDir, DAEMON_LOCK_FILE);
  const alive = options.isPidAlive ?? isPidAlive;
  // The daemon publishes its own pid for as long as the loop runs. The
  // reconciler lock cannot answer this, because apply and teardown share it
  // and the daemon takes it per tick rather than for its whole life.
  const daemonPid = readTick(store, META_DAEMON_PID);
  const running =
    daemonPid !== undefined && Number.isInteger(daemonPid) && daemonPid > 0;
  const lastFastTick = readTick(store, META_LAST_FAST_TICK);
  const lastFullTick = readTick(store, META_LAST_FULL_TICK);
  return {
    lockPath,
    ...(running ? { pid: daemonPid, command: 'daemon' } : {}),
    alive: running && alive(daemonPid),
    ...(lastFastTick === undefined ? {} : { lastFastTick }),
    ...(lastFullTick === undefined ? {} : { lastFullTick }),
  };
}

export async function runStatus(
  options: StatusCommandOptions = {},
): Promise<number> {
  const write = options.stdout ?? ((text: string) => console.log(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));

  const opened = await openFleetOrExit(options, writeError);
  if (typeof opened === 'number') {
    return opened;
  }
  const fleet: FleetContext = opened;

  // Everything the daemon and the suspect sections need is a local database
  // read, so both are known before the first host is asked anything and both
  // are on screen from the very first frame.
  const daemon = daemonStatusFor(fleet.store, options);
  const suspects = suspectsFor(fleet.store);

  const hostOrder = Object.keys(fleet.loaded.config.hosts);
  const seenHosts = new Map<string, HostObservation>();
  const seenStorage = new Map<string, HostStorage>();
  const awaitedStorage = new Set<string>();
  const storageReads: Promise<unknown>[] = [];
  const jobs = new Map<string, CurrentJob>();
  const awaitedJobs = new Set<string>();
  const partial: ObservedState = { hosts: [], forges: [] };
  let awaitingForges = true;
  let awaitingQueue = options.queue !== false;
  let queue: QueueReport | undefined;
  let screen: LiveScreen | undefined;

  // Two commands per reachable host: the image store and the work dirs.
  // An unreachable host contributes no row, because the closing line
  // already names it and a row of dashes adds nothing.
  const readStorage = (host: HostObservation): void => {
    if (!host.reachable) {
      return;
    }
    awaitedStorage.add(host.host);
    storageReads.push(
      readHostStorage(
        fleet.transports.get(host.host) as Transport,
        host.host,
        seatWorkDirTargets(fleet.loaded.config, host.host, host.home),
        {
          docker: fleet.loaded.config.groups.some(
            (group) =>
              group.stack === 'docker' &&
              group.placement[host.host] !== undefined,
          ),
        },
      ).then((measured) => {
        seenStorage.set(host.host, measured);
        awaitedStorage.delete(host.host);
        arrived();
      }),
    );
  };

  // Config order, never arrival order, so a table drawn mid-flight puts its
  // rows where the finished one will put them.
  const inOrder = <T>(seen: Map<string, T>): T[] =>
    hostOrder.flatMap((name) => {
      const value = seen.get(name);
      return value === undefined ? [] : [value];
    });

  const outstanding = (): string[] => [
    ...hostOrder
      .filter((name) => !seenHosts.has(name))
      .map((name) => `host ${name}`),
    ...(awaitingForges ? ['the forges'] : []),
    ...hostOrder
      .filter((name) => awaitedStorage.has(name))
      .map((name) => `storage on ${name}`),
    ...[...awaitedJobs].map((name) => `the job on ${name}`),
    ...(awaitingQueue ? ['the queue'] : []),
  ];

  // Records change only when this run persists a system id, so the frames
  // share one read rather than querying at every spinner tick.
  const records = fleet.store.activeRunners();
  let draft: StatusReport | undefined;
  let finished: string | undefined;

  const frame = (spinner: string): string => {
    if (finished !== undefined) {
      return finished;
    }
    draft ??= buildStatusReport(
      fleet.loaded,
      { hosts: inOrder(seenHosts), forges: partial.forges },
      records,
      {
        suspects,
        daemon,
        storage: inOrder(seenStorage),
        jobs,
        ...(queue === undefined ? {} : { queue }),
      },
    );
    return renderStatusReport(draft, {
      ...(options.color === undefined ? {} : { color: options.color }),
      pending: outstanding(),
      spinner,
    });
  };

  // Something landed: the next frame rebuilds instead of reusing the last.
  const arrived = (): void => {
    draft = undefined;
    screen?.refresh();
  };

  try {
    if (wantsLive(options)) {
      screen = startLiveScreen({
        write: options.liveStdout ?? ((text) => process.stdout.write(text)),
        render: frame,
        columns: options.liveColumns ?? process.stdout.columns,
        rows: options.liveRows ?? process.stdout.rows,
        ...(options.liveIntervalMs === undefined
          ? {}
          : { intervalMs: options.liveIntervalMs }),
      });
    }

    const observed = await observeFleet(fleet.loaded.config, {
      transports: fleet.transports,
      forgeClients: fleet.forgeClients,
      forgeLimit: fleet.forgeLimit,
      ...(options.probeTimeoutMs === undefined
        ? {}
        : { probeTimeoutMs: options.probeTimeoutMs }),
      // A host's storage is measured the moment that host answers, rather
      // than once every host has, so the slowest `du` overlaps every other
      // host's round trips instead of following them.
      onHost: (host) => {
        seenHosts.set(host.host, host);
        readStorage(host);
        arrived();
      },
      onForge: (forge) => {
        partial.forges.push(forge);
        arrived();
      },
    });
    awaitingForges = false;
    // Before the records are read, so a manager grove just learned about
    // shows up in this run rather than the next one.
    persistSystemIds(observed, fleet.store.activeRunners(), fleet.store);
    // Which seats are busy is known only once the forges have answered, so
    // the log tails start here rather than with the host reads. One command
    // per busy seat, and none at all for an idle fleet.
    const fresh = fleet.store.activeRunners();
    const jobReads = buildStatusReport(fleet.loaded, observed, fresh, {
      suspects,
      daemon,
    })
      .rows.filter((row) => row.forgeStatus === 'busy')
      .map((row) => {
        const transport = fleet.transports.get(row.host);
        const observation = seenHosts.get(row.host);
        if (transport === undefined || observation?.reachable !== true) {
          return Promise.resolve();
        }
        const group = fleet.loaded.config.groups.find(
          (entry) => entry.name === row.group,
        );
        awaitedJobs.add(row.runner);
        arrived();
        return readCurrentJob({
          transport,
          host: row.host,
          runner: row.runner,
          stack: row.stack,
          ...(group === undefined ? {} : { group }),
          hostConfig: fleet.loaded.config.hosts[row.host],
          ...(observation.home === undefined ? {} : { home: observation.home }),
          ...(observation.platform === undefined
            ? {}
            : { platform: observation.platform }),
          ...(observation.uid === undefined ? {} : { uid: observation.uid }),
        }).then((job) => {
          if (job !== undefined) {
            jobs.set(jobKey(row.host, row.runner), job);
          }
          awaitedJobs.delete(row.runner);
          arrived();
        });
      });

    // Costs one forge call per active repository or project, so it runs
    // alongside the storage and job reads rather than after them, and lands
    // in `queue` the moment it resolves so a mid-flight frame can show it
    // without waiting on a slow host.
    const queueRead: Promise<unknown> =
      options.queue === false
        ? Promise.resolve(undefined)
        : readQueue({
            config: fleet.loaded.config,
            forgeClients: fleet.forgeClients,
            runnersByGroup: runnersByGroup(observed, fresh),
            limit: fleet.forgeLimit,
          }).then((result) => {
            queue = result;
            awaitingQueue = false;
            arrived();
          });

    await Promise.all([queueRead, ...storageReads, ...jobReads]);

    const report = buildStatusReport(fleet.loaded, observed, fresh, {
      suspects,
      daemon,
      storage: inOrder(seenStorage),
      jobs,
      ...(queue === undefined ? {} : { queue }),
    });

    // History, never a decision. A sample per managed runner per run.
    for (const row of report.rows) {
      if (row.recordId !== undefined) {
        fleet.store.recordLiveness(row.recordId, livenessFor(row));
      }
    }

    const text =
      options.json === true
        ? JSON.stringify(report, null, 2)
        : renderStatusReport(report, {
            ...(options.color === undefined ? {} : { color: options.color }),
          });
    if (screen === undefined) {
      write(text);
    } else {
      // The last frame is the finished report, so the block already on screen
      // is replaced by it rather than joined by a second copy of it.
      finished = text;
      screen.stop();
      screen = undefined;
    }
    return report.ok ? EXIT_OK : EXIT_UNREACHABLE;
  } finally {
    screen?.stop();
    await fleet.close();
  }
}
