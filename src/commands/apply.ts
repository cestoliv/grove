import { EXIT_ABORTED, EXIT_OK, EXIT_UNREACHABLE } from '../lib/exit-codes.js';
import { renderPlanReport } from '../lib/plan/render.js';
import { isReport } from '../lib/reconcile/index.js';
import type { FleetContext } from './context.js';
import { confirmAndExecute, openFleetOrExit, planFleet } from './pipeline.js';
import type { PlanCommandOptions } from './plan.js';

export interface ApplyCommandOptions extends PlanCommandOptions {
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  clean?: boolean;
  input?: NodeJS.ReadableStream;
  isTty?: boolean;
}

export async function runApply(
  options: ApplyCommandOptions = {},
): Promise<number> {
  const write = options.stdout ?? ((text: string) => console.log(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));

  const opened = await openFleetOrExit(options, writeError);
  if (typeof opened === 'number') {
    return opened;
  }
  const fleet: FleetContext = opened;

  try {
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

    return outcome.failed.length > 0 || !report.ok ? EXIT_UNREACHABLE : EXIT_OK;
  } finally {
    await fleet.close();
  }
}
