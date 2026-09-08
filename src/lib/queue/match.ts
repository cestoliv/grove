import type { GroupConfig } from '../config/index.js';
import type { ForgeRunner, QueuedJob } from '../forge/index.js';

const fold = (values: string[]): string[] =>
  values.map((value) => value.toLowerCase());

// A job that asks for `macos` runs on a runner that reports `macOS`. Both
// forges compare labels case-insensitively, so grove has to as well, or a
// queued job silently belongs to no group.
function canTake(jobLabels: string[], runnerLabels: string[]): boolean {
  const have = new Set(fold(runnerLabels));
  return fold(jobLabels).every((label) => have.has(label));
}

/**
 * Which group would run this job, or undefined when none would.
 *
 * The label set comes from the runners the forge reports for the group,
 * because GitHub adds `self-hosted`, the operating system and the
 * architecture on its own and `grove.yaml` never lists those. The configured
 * labels are the fallback for a group with no runner online.
 */
export function groupForJob(
  job: QueuedJob,
  forge: string,
  groups: GroupConfig[],
  runnersByGroup: Map<string, ForgeRunner[]>,
): string | undefined {
  for (const group of groups) {
    if (group.forge !== forge) {
      continue;
    }
    // Derived from the scope level rather than `config.forges[forge].kind`,
    // which holds today only because no level name is shared between the
    // two forges. A third forge sharing one of these levels would break it.
    const isGitlab =
      group.scope.level === 'instance' ||
      group.scope.level === 'group' ||
      group.scope.level === 'project';

    // An untagged GitLab job needs a runner that accepts untagged work, and
    // grove registers a group with no tags as exactly that.
    if (isGitlab && job.labels.length === 0) {
      if ((group.tags ?? []).length === 0) {
        return group.name;
      }
      continue;
    }

    const runners = runnersByGroup.get(group.name) ?? [];
    if (runners.length === 0) {
      const declared = isGitlab ? (group.tags ?? []) : (group.labels ?? []);
      if (canTake(job.labels, declared)) {
        return group.name;
      }
      continue;
    }
    if (runners.some((runner) => canTake(job.labels, runner.labels))) {
      return group.name;
    }
  }
  return undefined;
}
