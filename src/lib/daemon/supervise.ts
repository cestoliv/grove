import type { GroupConfig, GroveConfig } from '../config/index.js';
import { activityStampFor } from '../naming.js';
import {
  type Action,
  classifyRunners,
  flattenObserved,
  type HostObservation,
  hostStackError,
  isReport,
  type ObservedState,
} from '../reconcile/index.js';
import { buildRunnerDirs, DEFAULT_DRAIN_TIMEOUT_MS } from '../stack/index.js';
import type { RunnerRecord, StateStore } from '../state/index.js';
import type { Transport } from '../transport/index.js';
import {
  type ActivityState,
  type ActivityTarget,
  readActivity,
} from './activity.js';

// A genuine long build must survive a wrong guess, so a restart is followed
// by a quiet period and a fleet cannot restart one seat forever.
export const RESTART_COOLDOWN_MS = 10 * 60_000;
export const MAX_RESTARTS_PER_HOUR = 3;
export const RESTART_WINDOW_MS = 60 * 60_000;

export interface SuspectFinding {
  name: string;
  host: string;
  reason: string;
  // True the first time this seat became a suspect. The log writes a line
  // once rather than every thirty minutes for as long as it lasts.
  fresh: boolean;
}

export interface SuperviseOptions {
  config: GroveConfig;
  observed: ObservedState;
  records: RunnerRecord[];
  store: StateStore;
  transports: ReadonlyMap<string, Transport>;
  // What the reconciler already decided this pass. A seat named there is that
  // pass's business, and two decisions about one seat is how a fleet fights
  // itself.
  planned: Action[];
  fullIntervalMs: number;
  now?: () => number;
}

export interface SuperviseResult {
  actions: Action[];
  suspects: SuspectFinding[];
  jobsStarted: string[];
  jobsEnded: string[];
  reregistered: string[];
  // Hosts whose activity probe answered for nobody, so every busy seat on
  // them is unknown and stuck detection is off there until it is fixed. One
  // entry per host, because that is one failure rather than one per seat.
  unmeasurableHosts: string[];
}

interface Candidate {
  record: RunnerRecord;
  group: GroupConfig;
  host: HostObservation;
  workDir: string;
  busy: boolean;
  registered: boolean;
  present: boolean;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

export async function superviseFleet(
  options: SuperviseOptions,
): Promise<SuperviseResult> {
  const now = options.now?.() ?? Date.now();
  const { config, observed, store } = options;
  const hosts = new Map(observed.hosts.map((entry) => [entry.host, entry]));
  const forges = new Map(observed.forges.map((entry) => [entry.forge, entry]));
  const groups = new Map(config.groups.map((group) => [group.name, group]));
  const claimed = new Set(
    options.planned
      .filter((action) => !isReport(action) && 'name' in action)
      .map((action) => (action as { name: string }).name),
  );
  const active = options.records.filter((record) => record.retiredAt === null);

  const candidates: Candidate[] = [];
  for (const entry of classifyRunners(
    flattenObserved(observed, { skipUnreachable: true, records: active }),
    active,
  )) {
    const record = entry.record;
    if (entry.ownership !== 'managed' || record === undefined) {
      continue;
    }
    if (claimed.has(record.name)) {
      continue;
    }
    const group = groups.get(record.group);
    const hostConfig = config.hosts[record.host];
    const host = hosts.get(record.host);
    if (group === undefined || hostConfig === undefined) {
      // The group or the host left the config, which is a scale-down and
      // therefore the reconciler's business rather than the supervisor's.
      continue;
    }
    if (host === undefined || !host.reachable) {
      continue;
    }
    // Silence from the supervisor that holds this seat is not absence.
    if (hostStackError(host, record.stack) !== undefined) {
      continue;
    }
    // A work root that fell back to the boot disk is never wiped, and a
    // restart wipes.
    const guard = host.workRoots[group.name];
    if (guard !== undefined && !guard.ok) {
      continue;
    }
    const forge = forges.get(record.forge);
    if (forge === undefined || !forge.reachable) {
      // Every decision below needs the forge, so an unanswered forge is a
      // tick with no supervision rather than a guess.
      continue;
    }

    candidates.push({
      record,
      group,
      host,
      workDir: buildRunnerDirs({
        group,
        host: hostConfig,
        index: record.index,
        ...(host.home === undefined ? {} : { home: host.home }),
      }).workDir,
      busy: entry.forgeRunner?.busy === true,
      registered: entry.forgeRunner !== undefined,
      present: entry.container !== undefined || entry.native !== undefined,
    });
  }

  const actions: Action[] = [];
  const suspects: SuspectFinding[] = [];
  const jobsStarted: string[] = [];
  const jobsEnded: string[] = [];
  const reregistered: string[] = [];

  // Pass one moves the watch forward and writes job history. It runs before
  // any decision, so a decision reads a watch that already knows about this
  // tick.
  const busyByHost = new Map<string, ActivityTarget[]>();
  for (const candidate of candidates) {
    const { record } = candidate;
    const watch = store.watchFor(record.id);

    if (candidate.busy && watch.busySince === null) {
      store.startJob(record.id, now);
      jobsStarted.push(record.name);
    }
    if (!candidate.busy && watch.busySince !== null) {
      store.endJob(record.id, 'unknown', now);
      jobsEnded.push(record.name);
    }

    const unregisteredSince = candidate.registered
      ? null
      : (watch.unregisteredSince ?? now);

    store.setWatch(record.id, {
      busySince: candidate.busy ? (watch.busySince ?? now) : null,
      unregisteredSince,
      suspectSince: watch.suspectSince,
      suspectReason: watch.suspectReason,
    });

    if (candidate.busy) {
      const list = busyByHost.get(record.host) ?? [];
      list.push({
        name: record.name,
        workDir: candidate.workDir,
        stampPath: activityStampFor(candidate.workDir),
      });
      busyByHost.set(record.host, list);
    }
  }

  // Pass two asks each host about the work dirs of its busy seats, one exec
  // per host.
  const activity = new Map<string, ActivityState>();
  const unmeasurableHosts: string[] = [];
  await Promise.all(
    [...busyByHost].map(async ([host, targets]) => {
      const transport = options.transports.get(host);
      if (transport === undefined) {
        return;
      }
      const answers = await readActivity(transport, targets);
      // Every seat unknown means the probe itself failed, not that every job
      // stalled at once. The caller says so, because a probe that is safe and
      // silent leaves an operator thinking stuck detection is watching.
      if ([...answers.values()].every((state) => state === 'error')) {
        unmeasurableHosts.push(host);
      }
      for (const [name, state] of answers) {
        activity.set(name, state);
      }
    }),
  );
  unmeasurableHosts.sort();

  // Pass three decides.
  for (const candidate of candidates) {
    const { record, group } = candidate;
    const watch = store.watchFor(record.id);

    // A seat that is up and unregistered is a different condition from a
    // stuck one, and it is checked first because a restart would not help.
    const shared = forges.get(record.forge)?.shared === true;
    if (candidate.present && !candidate.registered && !shared) {
      if (
        watch.unregisteredSince !== null &&
        now - watch.unregisteredSince >= options.fullIntervalMs
      ) {
        const drainTimeoutMs = group.drain_timeout ?? DEFAULT_DRAIN_TIMEOUT_MS;
        const stack = record.stack === 'native' ? { stack: record.stack } : {};
        actions.push(
          {
            kind: 'stop-container',
            host: record.host,
            name: record.name,
            ...stack,
            recordId: record.id,
            drainTimeoutMs,
            destructive: true,
          },
          {
            kind: 'remove-container',
            host: record.host,
            name: record.name,
            ...stack,
            recordId: record.id,
            destructive: true,
          },
          {
            // The same record, so ownership never lapses, and no deregister,
            // because the forge lists nothing to delete.
            kind: 'create-runner',
            host: record.host,
            forge: record.forge,
            group: record.group,
            index: record.index,
            name: record.name,
            ...stack,
            recordId: record.id,
            destructive: false,
          },
        );
        store.endJob(record.id, 'unknown', now);
        store.setWatch(record.id, {
          busySince: null,
          unregisteredSince: null,
          suspectSince: null,
          suspectReason: null,
        });
        reregistered.push(record.name);
      }
      continue;
    }

    if (!candidate.busy) {
      if (watch.suspectSince !== null) {
        store.setWatch(record.id, {
          busySince: watch.busySince,
          unregisteredSince: watch.unregisteredSince,
          suspectSince: null,
          suspectReason: null,
        });
      }
      continue;
    }

    const busyMs = watch.busySince === null ? 0 : now - watch.busySince;
    const maxJobDurationMs = group.max_job_duration;
    const forgeSignal =
      maxJobDurationMs !== undefined && busyMs > maxJobDurationMs;
    // A busy clock set on this very pass means the job has had no time to
    // write anything under the work dir yet, so a quiet dir says nothing. One
    // false suspect per job start is how an operator learns to ignore the
    // word.
    const hostSignal =
      watch.busySince !== null &&
      watch.busySince < now &&
      activity.get(record.name) === 'quiet';

    if (!forgeSignal && !hostSignal) {
      if (watch.suspectSince !== null) {
        store.setWatch(record.id, {
          busySince: watch.busySince,
          unregisteredSince: watch.unregisteredSince,
          suspectSince: null,
          suspectReason: null,
        });
      }
      continue;
    }

    const forgeReason =
      maxJobDurationMs === undefined
        ? 'the group sets no max_job_duration, so grove has no forge signal'
        : `the forge has said busy for ${minutes(busyMs)} against a max_job_duration of ${minutes(maxJobDurationMs)}`;
    const hostReason = hostSignal
      ? `nothing under the work dir ${candidate.workDir} changed since the previous full tick`
      : `the work dir ${candidate.workDir} reads as ${activity.get(record.name) ?? 'unknown'}`;

    if (forgeSignal && hostSignal) {
      const since = store.lastEventAt(record.id, 'restarted');
      const recent = store.countEventsSince(
        record.id,
        'restarted',
        now - RESTART_WINDOW_MS,
      );
      const blocked =
        since !== undefined && now - since < RESTART_COOLDOWN_MS
          ? `grove restarted it ${minutes(now - since)} ago and the cooldown is ${minutes(RESTART_COOLDOWN_MS)}`
          : recent >= MAX_RESTARTS_PER_HOUR
            ? `grove has already made ${recent} restarts in the last hour, which is the ceiling`
            : undefined;

      if (blocked === undefined) {
        const reason = `${forgeReason}, and ${hostReason}`;
        actions.push({
          kind: 'restart-runner',
          host: record.host,
          name: record.name,
          ...(record.stack === 'native' ? { stack: record.stack } : {}),
          recordId: record.id,
          reason,
          destructive: true,
        });
        // The job grove is about to kill ends here, with an outcome that says
        // why, and the busy clock is cleared with it. The next full tick that
        // still sees busy opens a fresh job and starts the clock again, so an
        // open job and a non-null busy_since always travel together and no
        // later tick reports an end for a job that was already closed.
        store.endJob(record.id, 'restarted', now);
        store.setWatch(record.id, {
          busySince: null,
          unregisteredSince: null,
          suspectSince: null,
          suspectReason: null,
        });
        continue;
      }

      const reason = `both stuck signals agree, but ${blocked}`;
      suspects.push({
        name: record.name,
        host: record.host,
        reason,
        fresh: watch.suspectSince === null,
      });
      actions.push({
        kind: 'report-suspect',
        host: record.host,
        name: record.name,
        reason,
        destructive: false,
      });
      store.setWatch(record.id, {
        busySince: watch.busySince,
        unregisteredSince: watch.unregisteredSince,
        suspectSince: watch.suspectSince ?? now,
        suspectReason: reason,
      });
      continue;
    }

    // One signal. Surfaced, and acted on by nothing, because killing a
    // healthy 40 minute build costs more than a wedged runner does.
    const reason = forgeSignal
      ? `${forgeReason}, but ${hostReason}`
      : `${hostReason}, but ${forgeReason}`;
    suspects.push({
      name: record.name,
      host: record.host,
      reason,
      fresh: watch.suspectSince === null,
    });
    actions.push({
      kind: 'report-suspect',
      host: record.host,
      name: record.name,
      reason,
      destructive: false,
    });
    store.setWatch(record.id, {
      busySince: watch.busySince,
      unregisteredSince: watch.unregisteredSince,
      suspectSince: watch.suspectSince ?? now,
      suspectReason: reason,
    });
  }

  return {
    actions,
    suspects,
    jobsStarted,
    jobsEnded,
    reregistered,
    unmeasurableHosts,
  };
}
