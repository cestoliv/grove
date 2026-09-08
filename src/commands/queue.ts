import { EXIT_OK } from '../lib/exit-codes.js';
import { renderTable } from '../lib/plan/render.js';
import { readQueue, runnersByGroup } from '../lib/queue/index.js';
import { observeFleet } from '../lib/reconcile/index.js';
import { formatElapsed } from '../lib/status/current-job.js';
import type { FleetContext } from './context.js';
import { openFleetOrExit } from './pipeline.js';
import type { PlanCommandOptions } from './plan.js';

export interface QueueCommandOptions extends PlanCommandOptions {
  json?: boolean;
  now?: number;
}

/**
 * What is waiting, and for whom. Forges only: no host answers this question,
 * so the command runs no host command.
 */
export async function runQueue(
  options: QueueCommandOptions = {},
): Promise<number> {
  const write = options.stdout ?? ((text: string) => console.log(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));

  const opened = await openFleetOrExit(options, writeError);
  if (typeof opened === 'number') {
    return opened;
  }
  const fleet: FleetContext = opened;

  try {
    const observed = await observeFleet(fleet.loaded.config, {
      transports: new Map(),
      forgeClients: fleet.forgeClients,
      forgeLimit: fleet.forgeLimit,
    });
    const records = fleet.store.activeRunners();

    const report = await readQueue({
      config: fleet.loaded.config,
      forgeClients: fleet.forgeClients,
      runnersByGroup: runnersByGroup(observed, records),
      limit: fleet.forgeLimit,
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    if (options.json === true) {
      write(JSON.stringify(report, null, 2));
      return EXIT_OK;
    }

    const now = options.now ?? Date.now();
    if (report.rows.length === 0) {
      write('No job is waiting.');
    } else {
      for (const line of renderTable(
        ['GROUP', 'FORGE', 'PROJECT', 'JOB', 'LABELS', 'WAITING'],
        report.rows.map((row) => [
          row.group,
          row.forge,
          row.project,
          row.name,
          row.labels.join(','),
          formatElapsed(now - row.queuedAt),
        ]),
      )) {
        write(line);
      }
    }
    for (const note of report.notes) {
      writeError(note);
    }
    return EXIT_OK;
  } finally {
    await fleet.close();
  }
}
