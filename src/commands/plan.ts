import { EXIT_OK, EXIT_UNREACHABLE } from '../lib/exit-codes.js';
import { renderPlanReport } from '../lib/plan/render.js';
import type { FleetContext } from './context.js';
import {
  openFleetOrExit,
  type PipelineOptions,
  planFleet,
} from './pipeline.js';

export {
  EXIT_ABORTED,
  EXIT_INVALID_CONFIG,
  EXIT_OK,
  EXIT_UNREACHABLE,
} from '../lib/exit-codes.js';

export interface PlanCommandOptions extends PipelineOptions {
  color?: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runPlan(
  options: PlanCommandOptions = {},
): Promise<number> {
  const write = options.stdout ?? ((text: string) => console.log(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));

  const opened = await openFleetOrExit(options, writeError);
  if (typeof opened === 'number') {
    return opened;
  }
  const fleet: FleetContext = opened;

  try {
    const { report } = await planFleet(fleet, options);
    write(
      renderPlanReport(report, {
        ...(options.color === undefined ? {} : { color: options.color }),
      }),
    );
    return report.ok ? EXIT_OK : EXIT_UNREACHABLE;
  } finally {
    await fleet.close();
  }
}
