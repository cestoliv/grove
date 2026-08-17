/**
 * Four statuses, because three of them mean different things to the exit
 * code. `ok` and `skip` both cost nothing, `warn` costs something only under
 * --strict, and `fail` is what makes `grove doctor` exit 1.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export type CheckTargetKind = 'control' | 'host' | 'forge' | 'group';

export interface CheckTarget {
  kind: CheckTargetKind;
  name: string;
}

export interface CheckResult {
  status: CheckStatus;
  summary: string;
  // What within the target this result is about: a work root, a declared
  // scope, a group name. Absent when the check answers once for the target.
  subject?: string;
  detail?: string;
  // Required on a warn and a fail by the helpers below, which is how the
  // spec's "every failure prints the fix" stays true as checks are added.
  fix?: string;
}

export interface CheckReport extends CheckResult {
  id: string;
  target: CheckTarget;
}

/**
 * A check always answers with an array. Several of them answer once per work
 * root or once per declared scope, and a union return type would push that
 * branch into the runner, the renderer and the gate.
 */
export interface Check<C> {
  id: string;
  run(context: C): Promise<CheckResult[]>;
}

interface ResultOptions {
  subject?: string;
  detail?: string;
}

function build(
  status: CheckStatus,
  summary: string,
  fix: string | undefined,
  options: ResultOptions = {},
): CheckResult {
  return {
    status,
    summary,
    ...(options.subject === undefined ? {} : { subject: options.subject }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(fix === undefined ? {} : { fix }),
  };
}

export function ok(summary: string, options?: ResultOptions): CheckResult {
  return build('ok', summary, undefined, options);
}

export function warn(
  summary: string,
  fix: string,
  options?: ResultOptions,
): CheckResult {
  return build('warn', summary, fix, options);
}

export function fail(
  summary: string,
  fix: string,
  options?: ResultOptions,
): CheckResult {
  return build('fail', summary, fix, options);
}

export function skip(
  summary: string,
  options?: Pick<ResultOptions, 'subject'>,
): CheckResult {
  return build('skip', summary, undefined, options);
}

const RANK: Record<CheckStatus, number> = { fail: 3, warn: 2, ok: 1, skip: 0 };

export function worstStatus(statuses: Iterable<CheckStatus>): CheckStatus {
  let worst: CheckStatus = 'skip';
  for (const status of statuses) {
    if (RANK[status] > RANK[worst]) {
      worst = status;
    }
  }
  return worst;
}

export function countStatuses(
  results: readonly CheckResult[],
): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = {
    ok: 0,
    warn: 0,
    fail: 0,
    skip: 0,
  };
  for (const result of results) {
    counts[result.status] += 1;
  }
  return counts;
}
