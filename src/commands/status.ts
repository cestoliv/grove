import { EXIT_OK, EXIT_UNREACHABLE } from '../lib/exit-codes.js';
import { observeFleet, persistSystemIds } from '../lib/reconcile/index.js';
import { renderStatusReport } from '../lib/status/render.js';
import { buildStatusReport, livenessFor } from '../lib/status/report.js';
import type { FleetContext } from './context.js';
import { openFleetOrExit } from './pipeline.js';
import type { PlanCommandOptions } from './plan.js';

export interface StatusCommandOptions extends PlanCommandOptions {
  json?: boolean;
}

export async function runStatus(
  options: StatusCommandOptions = {},
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
      transports: fleet.transports,
      forgeClients: fleet.forgeClients,
      forgeLimit: fleet.forgeLimit,
      ...(options.probeTimeoutMs === undefined
        ? {}
        : { probeTimeoutMs: options.probeTimeoutMs }),
    });
    // Before the records are read, so a manager grove just learned about
    // shows up in this run rather than the next one.
    persistSystemIds(observed, fleet.store.activeRunners(), fleet.store);
    const report = buildStatusReport(
      fleet.loaded,
      observed,
      fleet.store.activeRunners(),
    );

    // History, never a decision. A sample per managed runner per run.
    for (const row of report.rows) {
      if (row.recordId !== undefined) {
        fleet.store.recordLiveness(row.recordId, livenessFor(row));
      }
    }

    write(
      options.json === true
        ? JSON.stringify(report, null, 2)
        : renderStatusReport(report, {
            ...(options.color === undefined ? {} : { color: options.color }),
          }),
    );
    return report.ok ? EXIT_OK : EXIT_UNREACHABLE;
  } finally {
    await fleet.close();
  }
}
