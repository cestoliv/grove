import type { FleetContext } from '../../commands/context.js';
import type { DoctorReport } from './run.js';
import { runChecks } from './run.js';
import { worstStatus } from './types.js';

// One key per host, holding the timestamp of the pass that cleared it. It
// lives in `meta` next to the tick stamps, and losing it costs one extra
// doctor pass on the next apply and nothing else.
export const META_DOCTOR_PREFIX = 'doctor:';

export function doctorMetaKey(host: string): string {
  return `${META_DOCTOR_PREFIX}${host}`;
}

export interface GateOptions {
  fleet: FleetContext;
  now?: () => number;
  probeTimeoutMs?: number;
  // A dry run reports and writes nothing, so it remembers nothing either.
  dryRun?: boolean;
}

export interface GateResult {
  // The hosts this pass looked at. Empty when grove had already checked all
  // of them, which is the common case.
  checked: string[];
  blocked: string[];
  report?: DoctorReport;
}

/**
 * The spec's "host checks run automatically before the first apply against a
 * new host". Only the host family runs, and only for a host grove has no
 * record of. A forge or a group finding is not gated: a broken token fails
 * the apply anyway with an error that names it, and blocking an apply on a
 * group warning would make `privileged: true` unusable.
 */
export async function checkNewHosts(options: GateOptions): Promise<GateResult> {
  const { fleet } = options;
  const now = options.now ?? Date.now;
  const unchecked = Object.keys(fleet.loaded.config.hosts).filter(
    (host) => fleet.store.getMeta(doctorMetaKey(host)) === undefined,
  );
  if (unchecked.length === 0) {
    return { checked: [], blocked: [] };
  }

  const report = await runChecks({
    fleet,
    families: ['host'],
    hosts: unchecked,
    ...(options.probeTimeoutMs === undefined
      ? {}
      : { probeTimeoutMs: options.probeTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const blocked: string[] = [];
  const stamp = String(now());
  for (const host of unchecked) {
    const statuses = report.checks
      .filter((check) => check.target.name === host)
      .map((check) => check.status);
    if (worstStatus(statuses) === 'fail') {
      blocked.push(host);
      continue;
    }
    // Recorded per host rather than per run, so one broken host does not make
    // grove re-check the healthy ones on every apply. A dry run stamps
    // nothing: it is allowed to touch no state at all, and a stamp left behind
    // would make the next real apply skip the host on the strength of a pass
    // nobody acted on.
    if (options.dryRun !== true) {
      fleet.store.setMeta(doctorMetaKey(host), stamp);
    }
  }

  return { checked: unchecked, blocked, report };
}
