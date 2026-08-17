import { shellQuote, type Transport } from '../transport/index.js';

/**
 * What the host says about one seat's work dir since the previous full tick.
 *
 * `quiet` is the only answer that feeds a restart. Everything else means
 * grove could not tell, and grove never kills a running job on an answer it
 * does not have.
 */
export type ActivityState =
  | 'active'
  | 'quiet'
  | 'error'
  | 'no-dir'
  | 'no-stamp';

const STATES = new Set<string>([
  'active',
  'quiet',
  'error',
  'no-dir',
  'no-stamp',
]);

// Printed by the script when `find` itself failed, so a walk that never ran
// cannot arrive as an empty stdout and read as a quiet work dir. `find` prints
// absolute paths under the work dir, so no real entry can collide with it.
// Carried already shell-quoted, since it lands in the script on both sides of
// a comparison.
const FIND_FAILED = "'__grove_find_failed__'";

/**
 * A work dir on a mount that stopped answering must not hold the tick open,
 * because every later host waits behind it. A minute is far past what a walk
 * that ends on its first entry can honestly need.
 */
export const ACTIVITY_TIMEOUT_MS = 60_000;

export interface ActivityTarget {
  name: string;
  workDir: string;
  // A sibling of the work dir, so `grove apply --clean` cannot take it.
  stampPath: string;
}

/**
 * One script for every seat on a host, in the shape `readSystemIds` already
 * uses: the paths ride in as positional parameters, so nothing is quoted
 * twice and no path ever reaches the shell as part of the program text.
 *
 * `find -H` is POSIX and follows a work dir that is a symlink, which is how a
 * mac seat on an external volume usually looks. It follows the operand only,
 * so a symlink inside the tree still costs nothing.
 *
 * `-newer` is POSIX. `head -n 1` closes the pipe at the first newer file,
 * which ends the walk on the first entry without depending on `-quit`, an
 * extension a host's find may not have. `head` swallows find's exit status, so
 * a failed walk announces itself on stdout instead, and grove reads that as
 * unknown rather than as a quiet work dir.
 */
export function buildActivityScript(targets: ActivityTarget[]): string {
  const positional = targets
    .flatMap((target) => [
      shellQuote(target.name),
      shellQuote(target.workDir),
      shellQuote(target.stampPath),
    ])
    .join(' ');
  return [
    `set -- ${positional}`,
    'while [ "$#" -gt 0 ]; do',
    '  if [ ! -d "$2" ]; then',
    `    printf '%s\\t%s\\n' "$1" no-dir`,
    '  elif [ ! -f "$3" ]; then',
    `    printf '%s\\t%s\\n' "$1" no-stamp`,
    '    touch "$3"',
    '  else',
    `    out=$({ find -H "$2" -newer "$3" -print 2>/dev/null || printf '%s\\n' ${FIND_FAILED}; } | head -n 1)`,
    `    if [ "$out" = ${FIND_FAILED} ]; then`,
    `      printf '%s\\t%s\\n' "$1" error`,
    '    elif [ -n "$out" ]; then',
    `      printf '%s\\t%s\\n' "$1" active`,
    '    else',
    `      printf '%s\\t%s\\n' "$1" quiet`,
    '    fi',
    // Touched after the answer, so the window each verdict covers is exactly
    // the gap between two full ticks. A stamp grove cannot write must not
    // decide the whole host's verdict, nor leak its message into the answer,
    // so its failure is swallowed here and reported by `readActivity` instead.
    '    touch "$3" 2>/dev/null || true',
    '  fi',
    '  shift 3',
    'done',
  ].join('\n');
}

export function parseActivityOutput(text: string): Map<string, ActivityState> {
  const seen = new Map<string, ActivityState>();
  for (const line of text.split('\n')) {
    // Exactly two fields. A line with a third means a name carried a tab, and
    // grove cannot tell which piece names the seat.
    const fields = line.split('\t');
    if (fields.length !== 2) {
      continue;
    }
    const [name, state] = fields as [string, string];
    const trimmed = state.trim();
    if (name === '' || !STATES.has(trimmed)) {
      continue;
    }
    seen.set(name, trimmed as ActivityState);
  }
  return seen;
}

export async function readActivity(
  transport: Transport,
  targets: ActivityTarget[],
): Promise<Map<string, ActivityState>> {
  if (targets.length === 0) {
    return new Map();
  }
  const unknown = new Map<string, ActivityState>(
    targets.map((target) => [target.name, 'error' as ActivityState]),
  );
  let stdout: string;
  try {
    const result = await transport.exec(
      'sh',
      ['-c', buildActivityScript(targets)],
      { timeoutMs: ACTIVITY_TIMEOUT_MS },
    );
    // A timeout arrives here as a non-zero code, so a probe that was killed
    // partway keeps every seat unknown, including the ones it had answered
    // before the deadline.
    if (result.code !== 0) {
      return unknown;
    }
    stdout = result.stdout;
  } catch {
    // A host that dropped the connection has told grove nothing, and nothing
    // is not the same as quiet.
    return unknown;
  }
  const parsed = parseActivityOutput(stdout);
  // A seat the host did not mention keeps its unknown, so a truncated answer
  // cannot turn into a restart.
  for (const [name, state] of parsed) {
    unknown.set(name, state);
  }
  return unknown;
}
