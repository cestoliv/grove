import { checkNewHosts, renderDoctorReport } from '../lib/doctor/index.js';
import { EXIT_ABORTED, EXIT_OK, EXIT_UNREACHABLE } from '../lib/exit-codes.js';
import { renderPlanReport } from '../lib/plan/render.js';
import { isReport } from '../lib/reconcile/index.js';
import type { FleetContext } from './context.js';
import {
  confirmAndExecute,
  openFleetOrExit,
  planFleet,
  takeStateLockOrExit,
} from './pipeline.js';
import type { PlanCommandOptions } from './plan.js';

export interface ApplyCommandOptions extends PlanCommandOptions {
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  clean?: boolean;
  skipDoctor?: boolean;
  input?: NodeJS.ReadableStream;
  isTty?: boolean;
}

export async function runApply(
  options: ApplyCommandOptions = {},
): Promise<number> {
  const write = options.stdout ?? ((text: string) => console.log(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));

  // Before the fleet opens, so a refused apply costs no SSH connection and no
  // credential lookup.
  const lock = takeStateLockOrExit(
    {
      command: 'apply',
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
      // The spec runs host checks before the first apply against a new host.
      // grove never provisions, so this is the one place it can still refuse
      // to build on a host that cannot hold what it is about to be given.
      if (options.skipDoctor !== true) {
        const gate = await checkNewHosts({
          fleet,
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        });
        if (gate.report !== undefined && gate.checked.length > 0) {
          write(
            renderDoctorReport(gate.report, {
              ...(options.color === undefined ? {} : { color: options.color }),
            }),
          );
          write('');
        }
        // A dry run changes nothing, on the host or in the store, so it
        // prints the findings and carries on to the plan, which is what the
        // operator asked to see.
        if (gate.blocked.length > 0 && options.dryRun !== true) {
          writeError(
            `grove has not checked ${gate.blocked.join(', ')} before, and the checks above failed. Fix them and run grove doctor, or pass --skip-doctor to apply anyway.`,
          );
          return EXIT_UNREACHABLE;
        }
      }

      const { observed, actions, report } = await planFleet(fleet, {
        ...options,
        recordSystemIds: true,
      });
      write(
        renderPlanReport(report, {
          closing: 'apply',
          ...(options.color === undefined ? {} : { color: options.color }),
        }),
      );

      const work = actions.filter((action) => !isReport(action));
      if (work.length === 0) {
        return report.ok ? EXIT_OK : EXIT_UNREACHABLE;
      }

      const destructive = work.filter((action) => action.destructive).length;
      const outcome = await confirmAndExecute(fleet, observed, work, {
        question: `Apply ${destructive} destructive change${destructive === 1 ? '' : 's'}? [y/N]`,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.yes === undefined ? {} : { yes: options.yes }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.clean === undefined ? {} : { clean: options.clean }),
        ...(options.isTty === undefined ? {} : { isTty: options.isTty }),
        ...(options.input === undefined ? {} : { input: options.input }),
        write,
        writeError,
      });

      if (outcome === 'aborted') {
        return EXIT_ABORTED;
      }
      if (outcome === 'dry-run') {
        return report.ok ? EXIT_OK : EXIT_UNREACHABLE;
      }

      return outcome.failed.length > 0 || !report.ok
        ? EXIT_UNREACHABLE
        : EXIT_OK;
    } finally {
      await fleet.close();
    }
  } finally {
    lock.release();
  }
}
