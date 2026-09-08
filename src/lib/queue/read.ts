import {
  DEFAULT_QUEUE_ACTIVE_WITHIN_MS,
  type GroveConfig,
  type Scope,
} from '../config/index.js';
import { errorMessage } from '../errors.js';
import type { ForgeClient, ForgeRunner, QueuedJob } from '../forge/index.js';
import type { ObservedState } from '../reconcile/index.js';
import type { RunnerRecord } from '../state/index.js';
import { groupForJob } from './match.js';

// A stable dedup key for a scope, so a forge is swept once per distinct
// scope even when several groups target the same level and target. Mirrors
// `scopeKey` in `src/lib/reconcile/observe.ts` — same convention, not
// imported, because that one is private to its module.
function scopeKey(scope: Scope): string {
  return 'target' in scope ? `${scope.level}:${scope.target}` : scope.level;
}

export interface QueuedJobRow extends QueuedJob {
  forge: string;
  group: string;
}

export interface QueueReport {
  rows: QueuedJobRow[];
  // What grove could not read. Never an error: a queue it cannot see is not
  // a fleet that is broken.
  notes: string[];
  // False when every forge has the sweep off, which is what tells the
  // renderer to leave the section out entirely.
  swept: boolean;
  // Forges whose sweep did not complete, whether from a failed scope or a
  // client that cannot report a queue at all. A group on one of these forges
  // must never read as an empty queue, only as unknown.
  unknownForges: string[];
}

export interface ReadQueueOptions {
  config: GroveConfig;
  forgeClients: Map<string, ForgeClient>;
  // Keyed by group name. What the forge reports for that group's runners,
  // which is where the implicit labels come from.
  runnersByGroup: Map<string, ForgeRunner[]>;
  now?: number;
  limit?: <T>(task: () => Promise<T>) => Promise<T>;
}

/** Sweep every forge that allows it, then attribute what came back. */
export async function readQueue(
  options: ReadQueueOptions,
): Promise<QueueReport> {
  const now = options.now ?? Date.now();
  const run: NonNullable<ReadQueueOptions['limit']> =
    options.limit ?? (<T>(task: () => Promise<T>) => task());
  const rows: QueuedJobRow[] = [];
  const notes: string[] = [];
  const unknownForges = new Set<string>();
  let swept = false;

  // Distinct scopes per forge: two groups on the same forge can target
  // different scopes (an org and a lone repository, say), and each has to be
  // swept, or jobs queued under the scope that lost the map entry vanish
  // with no note.
  const scopesByForge = new Map<string, Scope[]>();
  for (const group of options.config.groups) {
    const list = scopesByForge.get(group.forge) ?? [];
    if (!list.some((scope) => scopeKey(scope) === scopeKey(group.scope))) {
      list.push(group.scope);
    }
    scopesByForge.set(group.forge, list);
  }

  await Promise.all(
    Object.entries(options.config.forges).map(async ([name, forge]) => {
      // The schema leaves the block optional so that no fixture has to
      // declare it. Absent means on, with the default window.
      const queue = forge.queue ?? {
        activeWithinMs: DEFAULT_QUEUE_ACTIVE_WITHIN_MS,
        enabled: true,
      };
      if (!queue.enabled) {
        return;
      }
      const client = options.forgeClients.get(name);
      const scopes = scopesByForge.get(name);
      if (client === undefined || scopes === undefined || scopes.length === 0) {
        return;
      }
      if (client.listQueuedJobs === undefined) {
        notes.push(`forge ${name} cannot report a queue`);
        unknownForges.add(name);
        return;
      }
      swept = true;
      // Each scope fails on its own: one bad scope becomes a note for this
      // forge, and never costs the jobs the other scopes already found. The
      // limiter travels into the client instead of wrapping this call, so a
      // client that fans out per repository or project stays inside the
      // gate too, rather than counting as the one slot this call holds.
      const perScope = await Promise.all(
        scopes.map(async (scope) => {
          try {
            return await (
              client.listQueuedJobs as NonNullable<
                ForgeClient['listQueuedJobs']
              >
            )(scope, { activeSince: now - queue.activeWithinMs, limit: run });
          } catch (error) {
            notes.push(`forge ${name}: ${errorMessage(error)}`);
            unknownForges.add(name);
            return [] as QueuedJob[];
          }
        }),
      );
      for (const job of perScope.flat()) {
        const group = groupForJob(
          job,
          name,
          options.config.groups,
          options.runnersByGroup,
        );
        if (group !== undefined) {
          rows.push({ ...job, forge: name, group });
        }
      }
    }),
  );

  // An organization scope and a repository scope inside it both get swept,
  // so the same job can arrive twice. Key on `url`, the one field a job
  // never shares with another, and fall back to project, name and queuedAt
  // for a job the forge returned with no url.
  const seen = new Set<string>();
  const deduped: QueuedJobRow[] = [];
  for (const row of rows) {
    const key =
      row.url !== '' ? row.url : `${row.project} ${row.name} ${row.queuedAt}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }

  deduped.sort((left, right) => left.queuedAt - right.queuedAt);
  return { rows: deduped, notes, swept, unknownForges: [...unknownForges] };
}

/**
 * What the forges report for each group's runners.
 *
 * A forge observation holds `{ runner, scope }` entries, and only the record
 * knows which group a runner name belongs to, so the two are joined here.
 * The implicit labels GitHub adds live on these runners and nowhere else.
 */
export function runnersByGroup(
  observed: ObservedState,
  records: RunnerRecord[],
): Map<string, ForgeRunner[]> {
  const groupOf = new Map(records.map((record) => [record.name, record.group]));
  const found = new Map<string, ForgeRunner[]>();
  for (const observation of observed.forges) {
    for (const entry of observation.runners) {
      const group = groupOf.get(entry.runner.name);
      if (group === undefined) {
        continue;
      }
      found.set(group, [...(found.get(group) ?? []), entry.runner]);
    }
  }
  return found;
}
