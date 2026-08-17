import { EXIT_ABORTED, EXIT_OK, EXIT_UNREACHABLE } from '../lib/exit-codes.js';
import {
  describeAction,
  isReport,
  observeFleet,
  planTeardown,
} from '../lib/reconcile/index.js';
import type { ApplyCommandOptions } from './apply.js';
import type { FleetContext } from './context.js';
import {
  confirmAndExecute,
  openFleetOrExit,
  takeStateLockOrExit,
} from './pipeline.js';

export interface TeardownCommandOptions extends ApplyCommandOptions {
  includeUnmanaged?: boolean;
}

export async function runTeardown(
  options: TeardownCommandOptions = {},
): Promise<number> {
  const write = options.stdout ?? ((text: string) => console.log(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));

  // Before the fleet opens, so a refused teardown costs no SSH connection and
  // no credential lookup.
  const lock = takeStateLockOrExit(
    {
      command: 'teardown',
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      ...(options.isPidAlive === undefined
        ? {}
        : { isPidAlive: options.isPidAlive }),
    },
    writeError,
  );
  if (typeof lock === 'number') {
    return lock;
  }

  try {
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
      const actions = planTeardown(
        fleet.loaded.config,
        observed,
        fleet.store.activeRunners(),
        {
          registrations: fleet.store.activeGroupRegistrations(),
          ...(options.includeUnmanaged === undefined
            ? {}
            : { includeUnmanaged: options.includeUnmanaged }),
        },
      );

      write('Teardown');
      if (actions.length === 0) {
        write('  nothing grove owns is running');
      }
      for (const action of actions) {
        write(`  ${describeAction(action)}`);
      }

      const degraded = actions.some(
        (action) => action.kind === 'report-degraded',
      );
      const work = actions.filter((action) => !isReport(action));
      if (work.length === 0) {
        return degraded ? EXIT_UNREACHABLE : EXIT_OK;
      }

      // The count is runners, not actions, because a runner is the unit the
      // operator agrees to lose.
      const runners = new Set(
        work.map((action) => ('name' in action ? action.name : '')),
      ).size;
      const outcome = await confirmAndExecute(fleet, observed, work, {
        question: `Tear down ${runners} runner${runners === 1 ? '' : 's'}? [y/N]`,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.yes === undefined ? {} : { yes: options.yes }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.isTty === undefined ? {} : { isTty: options.isTty }),
        ...(options.input === undefined ? {} : { input: options.input }),
        write,
        writeError,
      });

      if (outcome === 'aborted') {
        return EXIT_ABORTED;
      }
      if (outcome === 'dry-run') {
        return degraded ? EXIT_UNREACHABLE : EXIT_OK;
      }

      return outcome.failed.length > 0 || degraded ? EXIT_UNREACHABLE : EXIT_OK;
    } finally {
      await fleet.close();
    }
  } finally {
    lock.release();
  }
}
