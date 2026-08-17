import {
  type FleetContext,
  type OpenFleet,
  type OpenFleetOptions,
  openFleet,
} from '../../commands/context.js';
import {
  type ConfigWarning,
  DEFAULT_HISTORY_RETENTION_MS,
  type GroveConfig,
  type LoadedConfig,
  loadConfig,
} from '../config/index.js';
import { errorMessage } from '../errors.js';
import {
  META_LAST_FAST_TICK_MS,
  META_LAST_FULL_TICK_MS,
  type MetricsState,
  snapshotFromStatus,
} from '../metrics/index.js';
import { parseManagedName } from '../naming.js';
import {
  type Action,
  describeAction,
  type ExecutionResult,
  executeActions,
  isReport,
  type ObservedState,
  observeFleet,
  persistSystemIds,
  reconcile,
} from '../reconcile/index.js';
import {
  buildRunnerDirs,
  rawStackWarnings,
  readHostStorage,
  seatWorkDirTargets,
} from '../stack/index.js';
import {
  type LivenessState,
  META_LAST_FAST_TICK,
  META_LAST_FULL_TICK,
  type StateStore,
} from '../state/index.js';
import {
  buildStatusReport,
  hostLivenessFor,
  livenessFor,
  type StatusReport,
  type StatusRow,
} from '../status/report.js';
import type { Transport } from '../transport/index.js';
import type { DaemonLog } from './log.js';
import { type PruneTarget, pruneWorkDirs } from './prune.js';
import { type SuperviseResult, superviseFleet } from './supervise.js';

export type TickKind = 'fast' | 'full';

export interface TickSummary {
  kind: TickKind;
  applied: number;
  failed: number;
  skipped: number;
  restarted: string[];
  suspects: string[];
  reregistered: string[];
  prunedEntries: number;
  prunedHistory: number;
  unreachableHosts: string[];
  unreachableForges: string[];
  durationMs: number;
}

export interface TickOptions {
  fleet: FleetContext;
  kind: TickKind;
  log: DaemonLog;
  now?: () => number;
  nativePollIntervalMs?: number;
  // Present only when the config sets metrics.listen. The tick publishes what
  // it observed into it, so a scrape costs no SSH.
  metrics?: MetricsState;
}

// Frozen, because a fast tick hands this straight to the code that reads a
// full tick's result and one mutation would leak into every later tick.
const EMPTY_SUPERVISION: SuperviseResult = Object.freeze({
  actions: [],
  suspects: [],
  jobsStarted: [],
  jobsEnded: [],
  reregistered: [],
  unmeasurableHosts: [],
});

// Which hosts and forges were already down when the previous tick ended. It
// lives in `meta` rather than in memory so a daemon restart does not
// re-announce a failure the operator has already read.
const META_UNREACHABLE_HOSTS = 'unreachable_hosts';
const META_UNREACHABLE_FORGES = 'unreachable_forges';

const BYTES_PER_GIB = 1024 ** 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function gigabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_GIB).toFixed(1)} GB`;
}

// What a log line is about. Names first, because that is what an operator
// greps for, and a host or a group only when there is no name to give.
function subjectOf(action: Action): string {
  if ('name' in action) {
    return action.name;
  }
  if ('target' in action) {
    return action.target;
  }
  if ('group' in action) {
    return action.group;
  }
  return '';
}

function readNameSet(store: StateStore, key: string): Set<string> {
  const raw = store.getMeta(key);
  if (raw === undefined) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((name): name is string => typeof name === 'string')
        : [],
    );
  } catch {
    // A hand-edited or truncated value is not worth a failed tick. The set
    // rebuilds itself from this pass.
    return new Set();
  }
}

/**
 * One line per transition, not one per tick. A host that stays down for a day
 * is one warn and one info rather than 720 warns, which is the difference
 * between a log an operator reads and one they filter out.
 *
 * `seen` is what this pass actually looked at. A name it did not look at
 * keeps whatever state it had, which is what stops a fast tick, that asks no
 * forge anything, from reporting every down forge as recovered.
 */
function logReachability(
  store: StateStore,
  log: DaemonLog,
  key: string,
  subject: 'host' | 'forge',
  down: Map<string, string>,
  seen: Set<string>,
  known: Set<string>,
): void {
  const previous = readNameSet(store, key);
  for (const [name, reason] of down) {
    if (!previous.has(name)) {
      log.warn(name, `${subject} did not answer: ${reason}`);
    }
  }
  const carried: string[] = [];
  for (const name of previous) {
    if (down.has(name)) {
      continue;
    }
    if (seen.has(name)) {
      log.info(name, `${subject} answered again`);
      continue;
    }
    // Not looked at this pass, so its state is unchanged, unless the config
    // dropped it and there is nothing left to recover.
    if (known.has(name)) {
      carried.push(name);
    }
  }
  store.setMeta(key, JSON.stringify([...down.keys(), ...carried].sort()));
}

async function pruneFleetWorkDirs(
  fleet: FleetContext,
  observed: ObservedState,
  report: StatusReport,
  log: DaemonLog,
): Promise<number> {
  const config = fleet.loaded.config;
  const groups = new Map(
    config.groups
      .filter((group) => group.max_work_size !== undefined)
      .map((group) => [group.name, group] as const),
  );
  if (groups.size === 0) {
    return 0;
  }
  const hosts = new Map(observed.hosts.map((entry) => [entry.host, entry]));
  const byHost = new Map<string, PruneTarget[]>();

  for (const row of report.rows) {
    const group = groups.get(row.group);
    const host = hosts.get(row.host);
    const hostConfig = config.hosts[row.host];
    const parsed = parseManagedName(row.runner);
    if (
      group === undefined ||
      group.max_work_size === undefined ||
      host === undefined ||
      !host.reachable ||
      hostConfig === undefined ||
      parsed === null ||
      row.ownership !== 'managed'
    ) {
      continue;
    }
    // Never on a seat whose forge did not answer, because then grove cannot
    // tell whether there is a job in it. A seat the forge called busy travels
    // on with `busy: true`, so one place decides what a busy seat gets.
    if (row.forgeStatus === 'unknown') {
      continue;
    }
    const dirs = buildRunnerDirs({
      group,
      host: hostConfig,
      index: parsed.index,
      ...(host.home === undefined ? {} : { home: host.home }),
    });
    const list = byHost.get(row.host) ?? [];
    list.push({
      name: row.runner,
      workDir: dirs.workDir,
      limitBytes: group.max_work_size,
      busy: row.forgeStatus === 'busy',
    });
    byHost.set(row.host, list);
  }

  const pruned = await Promise.all(
    [...byHost].map(async ([host, targets]) => {
      const transport = fleet.transports.get(host);
      if (transport === undefined) {
        return 0;
      }
      const summary = await pruneWorkDirs(transport, targets);
      if (!summary.measured) {
        // One line for the host, not one per seat, because a host that cannot
        // be measured failed once and every seat on it is the same failure.
        log.warn(
          host,
          'the work dirs of this host could not be measured, so nothing was pruned on it',
        );
      }
      let removed = 0;
      for (const result of summary.results) {
        if (result.error !== undefined) {
          log.warn(
            result.name,
            `could not prune ${result.workDir}: ${result.error}`,
          );
          continue;
        }
        removed += result.removed.length;
        log.info(
          result.name,
          `pruned ${result.removed.length} entries, freeing ${gigabytes(result.freedBytes)} from ${result.workDir}, which held ${gigabytes(result.usedBytes)} against a max_work_size of ${gigabytes(result.limitBytes)}`,
        );
      }
      return removed;
    }),
  );
  return pruned.reduce((sum, count) => sum + count, 0);
}

/**
 * What a tick may hand the executor.
 *
 * A fast tick may execute `start-container` and nothing else. That is the
 * whole of what "no forge call on a fast tick" means, because a create mints
 * a registration token. The planner already refuses a create for a forge it
 * did not observe, and a fast tick observes none, but naming the one allowed
 * kind here keeps the invariant local: a later planner change fails closed
 * rather than open. Filtering on `destructive` would not, since an ordinary
 * create is not destructive.
 *
 * A full tick executes everything the planner and the supervisor asked for,
 * minus the reports, which are findings rather than work.
 */
export function selectTickWork(
  kind: TickKind,
  planned: readonly Action[],
  supervised: readonly Action[],
): Action[] {
  return kind === 'full'
    ? [...planned, ...supervised].filter((action) => !isReport(action))
    : planned.filter((action) => action.kind === 'start-container');
}

export async function runTick(options: TickOptions): Promise<TickSummary> {
  const started = options.now?.() ?? Date.now();
  const { fleet, kind, log } = options;
  const full = kind === 'full';
  const config = fleet.loaded.config;

  const observed = await observeFleet(config, {
    transports: fleet.transports,
    forgeClients: fleet.forgeClients,
    forgeLimit: fleet.forgeLimit,
    // Liveness only on the fast tick. Forge calls are the rate-limited
    // resource, so they run on the slow cadence.
    skipForges: !full,
  });

  const hostsByName = new Map(
    observed.hosts.map((entry) => [entry.host, entry]),
  );
  const forgesByName = new Map(
    observed.forges.map((entry) => [entry.forge, entry]),
  );

  const downHosts = new Map(
    observed.hosts
      .filter((host) => !host.reachable)
      .map((host) => [host.host, host.reason ?? 'unreachable'] as const),
  );
  logReachability(
    fleet.store,
    log,
    META_UNREACHABLE_HOSTS,
    'host',
    downHosts,
    new Set(hostsByName.keys()),
    new Set(Object.keys(config.hosts)),
  );
  const downForges = new Map(
    observed.forges
      .filter((forge) => !forge.reachable)
      .map(
        (forge) => [forge.forge, forge.reason ?? 'no reason given'] as const,
      ),
  );
  logReachability(
    fleet.store,
    log,
    META_UNREACHABLE_FORGES,
    'forge',
    downForges,
    new Set(forgesByName.keys()),
    new Set(Object.keys(config.forges)),
  );
  const unreachableHosts = [...downHosts.keys()];
  const unreachableForges = [...downForges.keys()];

  if (full) {
    persistSystemIds(observed, fleet.store.activeRunners(), fleet.store);
  }

  const planned = reconcile(config, observed, fleet.store.activeRunners(), {
    registrations: fleet.store.activeGroupRegistrations(),
  });

  const supervision = full
    ? await superviseFleet({
        config,
        observed,
        records: fleet.store.activeRunners(),
        store: fleet.store,
        transports: fleet.transports,
        planned,
        fullIntervalMs: config.tick.full,
        now: () => started,
      })
    : EMPTY_SUPERVISION;

  for (const finding of supervision.suspects) {
    // Once per transition, not once per tick, so a long suspicion is one line
    // rather than one every thirty minutes.
    if (finding.fresh) {
      log.warn(finding.name, `suspect on ${finding.host}: ${finding.reason}`);
    }
  }

  for (const host of supervision.unmeasurableHosts) {
    // One line for the host, not one per seat, the way an unmeasurable prune
    // reads. The direction is safe, since an unknown work dir never restarts
    // anything, but it is silently safe and stuck detection is off on that
    // host until it is fixed.
    log.warn(host, `activity unmeasurable on ${host}`);
  }

  const work = selectTickWork(kind, planned, supervision.actions);

  const result: ExecutionResult =
    work.length === 0
      ? { applied: [], failed: [], skipped: [] }
      : await executeActions(work, {
          config,
          hosts: hostsByName,
          stacks: fleet.stacks,
          transports: fleet.transports,
          forgeClients: fleet.forgeClients,
          store: fleet.store,
          resolveRunnerVersion: fleet.runnerVersion,
          ...(options.nativePollIntervalMs === undefined
            ? {}
            : { nativePollIntervalMs: options.nativePollIntervalMs }),
        });

  for (const action of result.applied) {
    log.info(subjectOf(action), describeAction(action));
  }
  for (const failure of result.failed) {
    log.error(
      subjectOf(failure.action),
      `${describeAction(failure.action)}: ${failure.error}`,
    );
  }
  for (const action of result.skipped) {
    log.warn(
      subjectOf(action),
      `skipped after an earlier failure: ${describeAction(action)}`,
    );
  }

  // History, never a decision. One sample per managed seat per tick, which is
  // what makes utilisation and restart frequency answerable later.
  const report = buildStatusReport(
    fleet.loaded,
    observed,
    fleet.store.activeRunners(),
  );
  // One reading of a row, shared by the liveness sample and the exporter
  // snapshot, so the two can never disagree about what a seat was doing. A
  // full tick whose forge did not answer knows exactly what a fast tick knows,
  // so it reads the row the same way rather than calling a running seat
  // offline over a forge outage.
  const readingOf = (row: StatusRow): LivenessState => {
    const forge = forgesByName.get(row.forge);
    return full && forge?.reachable === true
      ? livenessFor(row)
      : hostLivenessFor(row);
  };

  for (const row of report.rows) {
    if (row.recordId === undefined) {
      continue;
    }
    const host = hostsByName.get(row.host);
    // A host that did not answer said nothing about this seat. `missing` is a
    // claim, and silence is not one, so the tick records no sample at all.
    if (host === undefined || !host.reachable) {
      continue;
    }
    fleet.store.recordLiveness(row.recordId, readingOf(row));
  }

  if (options.metrics !== undefined) {
    options.metrics.setSnapshot(
      snapshotFromStatus(report, config, {
        at: started,
        liveness: readingOf,
      }),
    );
    if (full) {
      // One `docker system df` and one work-dir script per reachable host,
      // every thirty minutes. A fast tick keeps the last measurement.
      const storage = await Promise.all(
        observed.hosts
          .filter((host) => host.reachable)
          .map((host) =>
            readHostStorage(
              // A reachable host always has a transport: openFleet opens one
              // per declared host and observeFleet only reports declared ones.
              fleet.transports.get(host.host) as Transport,
              host.host,
              seatWorkDirTargets(config, host.host, host.home),
              {
                docker: config.groups.some(
                  (group) =>
                    group.stack === 'docker' &&
                    group.placement[host.host] !== undefined,
                ),
              },
            ),
          ),
      );
      options.metrics.setStorage(storage);
    }
  }

  let prunedEntries = 0;
  let prunedHistory = 0;
  if (full) {
    prunedEntries = await pruneFleetWorkDirs(fleet, observed, report, log);
    const retentionMs =
      config.history?.retentionMs ?? DEFAULT_HISTORY_RETENTION_MS;
    const pruned = fleet.store.pruneHistory(started - retentionMs);
    prunedHistory = pruned.events + pruned.liveness + pruned.jobs;
    if (prunedHistory > 0) {
      log.info(
        '',
        `pruned ${pruned.events} events, ${pruned.liveness} liveness samples and ${pruned.jobs} jobs older than ${Math.round(retentionMs / MS_PER_DAY)} days`,
      );
    }
  }

  const durationMs = (options.now?.() ?? Date.now()) - started;
  // A full tick replaces the fast tick it coincides with, so it stamps both.
  fleet.store.setMeta(META_LAST_FAST_TICK, String(started));
  fleet.store.setMeta(META_LAST_FAST_TICK_MS, String(durationMs));
  if (full) {
    fleet.store.setMeta(META_LAST_FULL_TICK, String(started));
    fleet.store.setMeta(META_LAST_FULL_TICK_MS, String(durationMs));
  }

  const appliedCreates = new Set(
    result.applied
      .filter((action) => action.kind === 'create-runner')
      .map((action) => action.name),
  );

  const summary: TickSummary = {
    kind,
    applied: result.applied.length,
    failed: result.failed.length,
    skipped: result.skipped.length,
    // What happened, not what was planned. A restart the executor failed is a
    // failure, and a summary that counted it would tell the operator grove
    // fixed a seat it did not fix.
    restarted: result.applied
      .filter((action) => action.kind === 'restart-runner')
      .map((action) => action.name),
    suspects: supervision.suspects.map((finding) => finding.name),
    // A re-registration is done when its create landed. The stop and the
    // remove before it are how grove gets there, not the outcome.
    reregistered: supervision.reregistered.filter((name) =>
      appliedCreates.has(name),
    ),
    prunedEntries,
    prunedHistory,
    unreachableHosts,
    unreachableForges,
    durationMs,
  };

  // The log records events, not a heartbeat. A fast tick that found nothing
  // writes nothing, and `meta.last_fast_tick` is what says the daemon is
  // alive. `grove status` and `grove daemon status` both print it.
  if (full || summary.applied > 0 || summary.failed > 0) {
    log.info(
      '',
      `${kind} tick: ${summary.applied} applied, ${summary.failed} failed, ${durationMs}ms`,
    );
  }

  return summary;
}

/**
 * What `openFleet` would build from a config: the hosts it opens a transport
 * for and the forges it resolves a token for. A group edit leaves it alone,
 * which is what keeps a `command:` credential from being re-run every tick.
 *
 * A reordered key inside one host block changes the signature and costs one
 * reopen. That is cheaper than a deep comparison nobody would trust.
 */
export function fleetSignature(config: GroveConfig): string {
  const hosts = Object.keys(config.hosts)
    .sort()
    .map((name) => `host ${name} ${JSON.stringify(config.hosts[name])}`);
  const forges = Object.keys(config.forges)
    .sort()
    .map((name) => `forge ${name} ${JSON.stringify(config.forges[name])}`);
  // A group naming a forge no group named before means a client grove has not
  // built yet, so the set of wanted forges is part of the signature too.
  const wanted = [
    ...new Set(
      config.groups
        .filter(
          (group) =>
            group.stack === 'docker' ||
            config.forges[group.forge]?.kind === 'github',
        )
        .map((group) => group.forge),
    ),
  ].sort();
  // The fast interval is what `openFleet` turns into the ControlPersist
  // window it asks SSH for, so a shorter or longer tick has to reopen the
  // transports for the window to follow it.
  return [
    ...hosts,
    ...forges,
    `wanted ${wanted.join(',')}`,
    `fast ${config.tick.fast}`,
  ].join('\n');
}

export interface RefreshOptions extends OpenFleetOptions {
  openFleet?: OpenFleet;
}

export interface RefreshResult {
  fleet: FleetContext;
  reopened: boolean;
  error?: string;
}

/**
 * Reload the config before a tick. An edit takes effect within one tick
 * rather than at the next restart, and a config that stops parsing keeps the
 * last good one, because a daemon that stops converging over a typo is worse
 * than one that keeps converging on yesterday's file.
 */
export async function refreshFleet(
  current: FleetContext,
  options: RefreshOptions,
): Promise<RefreshResult> {
  let loaded: LoadedConfig;
  let rawWarnings: ConfigWarning[];
  try {
    loaded = await loadConfig({
      ...(options.config === undefined ? {} : { path: options.config }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    rawWarnings = rawStackWarnings(loaded.config);
  } catch (error) {
    return { fleet: current, reopened: false, error: errorMessage(error) };
  }

  if (fleetSignature(loaded.config) === fleetSignature(current.loaded.config)) {
    current.loaded = loaded;
    current.rawWarnings = rawWarnings;
    return { fleet: current, reopened: false };
  }

  let next: FleetContext;
  try {
    // The new context opens before the old one closes, so a failure here
    // leaves the daemon with working connections rather than none.
    next = await (options.openFleet ?? openFleet)(options);
  } catch (error) {
    return { fleet: current, reopened: false, error: errorMessage(error) };
  }
  await current.close().catch(() => undefined);
  return { fleet: next, reopened: true };
}
