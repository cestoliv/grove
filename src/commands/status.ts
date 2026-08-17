import { join } from 'node:path';
import { isPidAlive } from '../lib/daemon/lock.js';
import { DAEMON_LOCK_FILE, daemonLockPath } from '../lib/daemon/paths.js';
import { EXIT_OK, EXIT_UNREACHABLE } from '../lib/exit-codes.js';
import { observeFleet, persistSystemIds } from '../lib/reconcile/index.js';
import {
  META_DAEMON_PID,
  META_LAST_FAST_TICK,
  META_LAST_FULL_TICK,
  type StateStore,
} from '../lib/state/index.js';
import { renderStatusReport } from '../lib/status/render.js';
import {
  buildStatusReport,
  type DaemonStatus,
  livenessFor,
  type SuspectRow,
} from '../lib/status/report.js';
import type { FleetContext } from './context.js';
import { openFleetOrExit } from './pipeline.js';
import type { PlanCommandOptions } from './plan.js';

export interface StatusCommandOptions extends PlanCommandOptions {
  json?: boolean;
  isPidAlive?: (pid: number) => boolean;
}

function readTick(store: StateStore, key: string): number | undefined {
  const value = store.getMeta(key);
  if (value === undefined) {
    return undefined;
  }
  const ts = Number(value);
  return Number.isFinite(ts) ? ts : undefined;
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

    const records = fleet.store.activeRunners();
    const suspects: SuspectRow[] = [];
    for (const record of records) {
      const watch = fleet.store.watchFor(record.id);
      if (watch.suspectSince === null || watch.suspectReason === null) {
        continue;
      }
      suspects.push({
        runner: record.name,
        host: record.host,
        since: watch.suspectSince,
        reason: watch.suspectReason,
      });
    }

    const lockPath =
      options.stateDir === undefined
        ? daemonLockPath({ env: options.env ?? process.env })
        : join(options.stateDir, DAEMON_LOCK_FILE);
    const alive = options.isPidAlive ?? isPidAlive;
    // The daemon publishes its own pid for as long as the loop runs. The
    // reconciler lock cannot answer this, because apply and teardown share it
    // and the daemon takes it per tick rather than for its whole life.
    const daemonPid = readTick(fleet.store, META_DAEMON_PID);
    const running =
      daemonPid !== undefined && Number.isInteger(daemonPid) && daemonPid > 0;
    const lastFastTick = readTick(fleet.store, META_LAST_FAST_TICK);
    const lastFullTick = readTick(fleet.store, META_LAST_FULL_TICK);
    const daemon: DaemonStatus = {
      lockPath,
      ...(running ? { pid: daemonPid, command: 'daemon' } : {}),
      alive: running && alive(daemonPid),
      ...(lastFastTick === undefined ? {} : { lastFastTick }),
      ...(lastFullTick === undefined ? {} : { lastFullTick }),
    };

    const report = buildStatusReport(fleet.loaded, observed, records, {
      suspects,
      daemon,
    });

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
