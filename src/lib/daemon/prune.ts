import { errorMessage } from '../errors.js';
import { assertRunnerWorkDir } from '../naming.js';
import { shellQuote, type Transport } from '../transport/index.js';

const KILOBYTE = 1024;

// A work dir is `<work_root>/<group>-<index>`, which is the only shape grove
// ever deletes inside. Anything else is somebody's home directory or a root.
const WORK_DIR_SHAPE = /^\/(?:[^/]+\/)+[^/]+-[1-9][0-9]*$/;

export interface WorkDirTarget {
  name: string;
  workDir: string;
}

export interface PruneTarget extends WorkDirTarget {
  limitBytes: number;
  // The caller already drops every seat the forge says is busy. Stating it
  // again here is a second lock on the same door, and it is required so that
  // a caller has to decide rather than forget: a busy seat is never measured,
  // never listed and never pruned, whatever its size.
  busy: boolean;
}

export interface WorkEntry {
  name: string;
  bytes: number;
}

export interface PruneResult {
  name: string;
  workDir: string;
  usedBytes: number;
  limitBytes: number;
  removed: string[];
  freedBytes: number;
  error?: string;
}

export interface PruneSummary {
  // False only when the host itself could not be measured, which is what
  // separates "grove does not know how full these dirs are" from "they all
  // fit". Both produce no results, and only one of them is worth a warning.
  measured: boolean;
  results: PruneResult[];
}

/** One `du -sk` per seat, in one exec for the whole host. */
export function buildUsageScript(targets: WorkDirTarget[]): string {
  const positional = targets
    .flatMap((target) => [shellQuote(target.name), shellQuote(target.workDir)])
    .join(' ');
  return [
    `set -- ${positional}`,
    'while [ "$#" -gt 0 ]; do',
    '  if [ -d "$2" ]; then',
    // The trailing `/.` names the directory itself. `[ -d ]` follows a symlink
    // but `du -s` on a symlink operand measures the link and answers 0, and a
    // mac seat on an external volume is usually a symlinked work dir. A zero
    // there is indistinguishable from an empty dir, so max_work_size would do
    // nothing and warn about nothing. `/.` does not follow symlinks inside the
    // tree, and the name in the output comes from `$1`, so it never reaches
    // grove.
    `    printf '%s\\t%s\\n' "$1" "$(du -sk -- "$2/." 2>/dev/null | cut -f1)"`,
    '  fi',
    '  shift 2',
    'done',
  ].join('\n');
}

export function parseUsage(text: string): Map<string, number> {
  const used = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [name, kilobytes] = line.split('\t');
    if (name === undefined || kilobytes === undefined || name === '') {
      continue;
    }
    const value = Number(kilobytes.trim());
    if (!Number.isFinite(value) || kilobytes.trim() === '') {
      continue;
    }
    used.set(name, value * KILOBYTE);
  }
  return used;
}

/**
 * The top level of one work dir, oldest first, with a size each. Dotted
 * entries are not listed, which is deliberate: grove deletes build output it
 * can name, never hidden state something else left behind.
 */
export function buildEntriesScript(workDir: string): string {
  return [
    `cd ${shellQuote(workDir)} || exit 1`,
    'ls -1tr | while IFS= read -r entry; do',
    '  size=$(du -sk -- "$entry" 2>/dev/null | cut -f1)',
    // An entry `du` cannot read still gets a line, at size 0. Dropping the
    // line would hide the entry from the removal pass, and grove would then
    // never get the directory under its ceiling. Counting it as 0 keeps it in
    // the oldest-first order and only makes grove delete one entry too many,
    // which is the safe direction for a size limit the operator asked for.
    `  printf '%s\\t%s\\n' "\${size:-0}" "$entry"`,
    'done',
  ].join('\n');
}

export function parseEntries(text: string): WorkEntry[] {
  const entries: WorkEntry[] = [];
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) {
      continue;
    }
    const bytes = Number(line.slice(0, tab).trim());
    const name = line.slice(tab + 1);
    // `ls -1tr` does not print dotted entries, so one here means the host
    // answered something grove did not ask for. It is dropped rather than
    // offered for removal, because grove deletes build output it can name and
    // never hidden state something else left behind.
    if (!Number.isFinite(bytes) || name === '' || name.startsWith('.')) {
      continue;
    }
    entries.push({ name, bytes: bytes * KILOBYTE });
  }
  return entries;
}

/**
 * Oldest first, until the directory fits. A work dir whose single entry is
 * over the ceiling loses that entry, because leaving it would mean the limit
 * the operator set does nothing.
 */
export function selectForRemoval(
  entries: WorkEntry[],
  usedBytes: number,
  limitBytes: number,
): WorkEntry[] {
  const chosen: WorkEntry[] = [];
  let remaining = usedBytes;
  for (const entry of entries) {
    if (remaining <= limitBytes) {
      break;
    }
    chosen.push(entry);
    remaining -= entry.bytes;
  }
  return chosen;
}

export function buildRemoveArgs(workDir: string, names: string[]): string[] {
  if (!WORK_DIR_SHAPE.test(workDir) || workDir.split('/').includes('..')) {
    throw new Error(
      `refusing to prune ${workDir}: it is not the work directory of a grove seat`,
    );
  }
  for (const name of names) {
    // A name that is empty, holds a separator or opens with a dot is either a
    // way out of the work dir or hidden state grove did not create. `.` and
    // `..` are covered by the dot, which is why they are not named again.
    if (name === '' || name.startsWith('.') || name.includes('/')) {
      throw new Error(
        `refusing to prune ${JSON.stringify(name)} in ${workDir}: it is not a direct child`,
      );
    }
  }
  return ['-rf', '--', ...names.map((name) => `${workDir}/${name}`)];
}

function emptyResult(target: PruneTarget): PruneResult {
  return {
    name: target.name,
    workDir: target.workDir,
    usedBytes: 0,
    limitBytes: target.limitBytes,
    removed: [],
    freedBytes: 0,
  };
}

/**
 * Measure every seat on one host, then prune the ones over their ceiling. The
 * caller has already dropped every seat the forge says is busy, because
 * deleting the tree a job is building in is worse than a full disk.
 *
 * Nothing here throws. A seat grove cannot measure, list, validate or remove
 * becomes a `PruneResult` carrying an `error`, because one bad seat must not
 * stop the pruning of the others or the tick around them.
 */
export async function pruneWorkDirs(
  transport: Transport,
  targets: PruneTarget[],
): Promise<PruneSummary> {
  const results: PruneResult[] = [];
  const prunable: PruneTarget[] = [];
  for (const target of targets) {
    if (target.busy) {
      continue;
    }
    try {
      assertRunnerWorkDir(target.workDir, target.name);
      prunable.push(target);
    } catch (error) {
      // A work dir that does not belong to its seat is reported and left
      // alone. It is not even measured, so nothing grove does can touch it.
      results.push({ ...emptyResult(target), error: errorMessage(error) });
    }
  }
  if (prunable.length === 0) {
    // Nothing to measure is not the same as a failed measurement.
    return { measured: true, results };
  }

  let used: Map<string, number>;
  try {
    const measured = await transport.exec('sh', [
      '-c',
      buildUsageScript(prunable),
    ]);
    if (measured.code !== 0) {
      // A host that cannot be measured is not pruned. Storage is the one
      // thing grove can safely leave for the next tick.
      return { measured: false, results };
    }
    used = parseUsage(measured.stdout);
  } catch {
    return { measured: false, results };
  }

  for (const target of prunable) {
    const usedBytes = used.get(target.name);
    if (usedBytes === undefined || usedBytes <= target.limitBytes) {
      continue;
    }
    const base: PruneResult = { ...emptyResult(target), usedBytes };
    try {
      const listed = await transport.exec('sh', [
        '-c',
        buildEntriesScript(target.workDir),
      ]);
      if (listed.code !== 0) {
        results.push({ ...base, error: 'the work dir could not be listed' });
        continue;
      }
      const chosen = selectForRemoval(
        parseEntries(listed.stdout),
        usedBytes,
        target.limitBytes,
      );
      if (chosen.length === 0) {
        continue;
      }
      const args = buildRemoveArgs(
        target.workDir,
        chosen.map((entry) => entry.name),
      );
      const removed = await transport.exec('rm', args);
      if (removed.code !== 0) {
        results.push({ ...base, error: `rm exited ${removed.code}` });
        continue;
      }
      results.push({
        ...base,
        removed: chosen.map((entry) => entry.name),
        freedBytes: chosen.reduce((sum, entry) => sum + entry.bytes, 0),
      });
    } catch (error) {
      results.push({ ...base, error: errorMessage(error) });
    }
  }
  return { measured: true, results };
}
