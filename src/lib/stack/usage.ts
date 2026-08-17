import type { GroveConfig } from '../config/index.js';
import { shellQuote } from '../transport/index.js';
import { buildRunnerDirs } from './docker-args.js';

const KILOBYTE = 1024;

export interface WorkDirTarget {
  name: string;
  workDir: string;
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
 * Every seat the config places on one host, with the work dir it would use.
 * Derived from the config rather than from the records, because that is what
 * an operator asked for and therefore what they want measured, and because a
 * record written before milestone 4 carries no work dir at all.
 */
export function seatWorkDirTargets(
  config: GroveConfig,
  host: string,
  home?: string,
): WorkDirTarget[] {
  const hostConfig = config.hosts[host];
  if (hostConfig === undefined) {
    return [];
  }
  const targets: WorkDirTarget[] = [];
  for (const group of config.groups) {
    // Indexes run 1..count for the whole group, in placement key order, which
    // is what the planner does. A group spanning two hosts therefore gives
    // the second host indexes that continue from the first rather than
    // starting again at 1.
    let index = 0;
    for (const [placed, count] of Object.entries(group.placement)) {
      for (let seat = 0; seat < count; seat += 1) {
        index += 1;
        if (placed !== host) {
          continue;
        }
        const dirs = buildRunnerDirs({
          group,
          host: hostConfig,
          index,
          ...(home === undefined ? {} : { home }),
        });
        targets.push({ name: dirs.name, workDir: dirs.workDir });
      }
    }
  }
  return targets;
}
