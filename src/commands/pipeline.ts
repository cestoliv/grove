import { ConfigError, CredentialError } from '../lib/config/index.js';
import { EXIT_INVALID_CONFIG } from '../lib/exit-codes.js';
import { buildPlanReport, type PlanReport } from '../lib/plan/report.js';
import { confirm } from '../lib/prompt.js';
import {
  type Action,
  type ExecutionResult,
  executeActions,
  hasDestructive,
  type ObservedState,
  observeFleet,
  persistSystemIds,
  reconcile,
} from '../lib/reconcile/index.js';
import {
  type FleetContext,
  type OpenFleet,
  type OpenFleetOptions,
  openFleet,
} from './context.js';

export interface PipelineOptions extends OpenFleetOptions {
  openFleet?: OpenFleet;
  probeTimeoutMs?: number;
  // An acting command sets this. `plan` never does, because `plan` writes
  // nothing to the database.
  recordSystemIds?: boolean;
}

export interface PlannedFleet {
  observed: ObservedState;
  actions: Action[];
  report: PlanReport;
}

/**
 * Every command opens the fleet the same way, and a bad config is the one
 * failure that is the user's to fix, so it exits instead of throwing.
 */
export async function openFleetOrExit(
  options: PipelineOptions,
  stderr: (text: string) => void,
): Promise<FleetContext | number> {
  try {
    return await (options.openFleet ?? openFleet)(options);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CredentialError) {
      stderr(error.message);
      return EXIT_INVALID_CONFIG;
    }
    throw error;
  }
}

/** Observe every host and forge, diff against the config, and build the report. */
export async function planFleet(
  fleet: FleetContext,
  options: PipelineOptions = {},
): Promise<PlannedFleet> {
  const observed = await observeFleet(fleet.loaded.config, {
    transports: fleet.transports,
    forgeClients: fleet.forgeClients,
    forgeLimit: fleet.forgeLimit,
    ...(options.probeTimeoutMs === undefined
      ? {}
      : { probeTimeoutMs: options.probeTimeoutMs }),
  });
  if (options.recordSystemIds === true) {
    // Before the records are read below, so a manager grove just learned
    // about shows up in this pass rather than the next one.
    persistSystemIds(observed, fleet.store.activeRunners(), fleet.store);
  }
  const actions = reconcile(
    fleet.loaded.config,
    observed,
    fleet.store.activeRunners(),
    { registrations: fleet.store.activeGroupRegistrations() },
  );
  const report = buildPlanReport(fleet.loaded, {
    observed,
    actions,
    extraWarnings: fleet.rawWarnings,
  });
  return { observed, actions, report };
}

export interface ConfirmAndExecuteOptions {
  // The question is the one thing every command phrases for itself, because
  // it names what the operator is about to lose.
  question: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  clean?: boolean;
  isTty?: boolean;
  input?: NodeJS.ReadableStream;
  write: (text: string) => void;
  writeError: (text: string) => void;
  nativePollIntervalMs?: number;
}

// Two ways out that are not an execution: the operator asked to see the plan
// only, or the operator said no. Both leave the fleet untouched, and each
// command maps them to its own exit code.
export type ConfirmAndExecuteOutcome = ExecutionResult | 'aborted' | 'dry-run';

/**
 * The tail every acting command shares: honour `--dry-run`, ask before
 * destroying anything, run the actions, then name what failed. Callers keep
 * the question and the exit code, because those differ per command.
 */
export async function confirmAndExecute(
  fleet: FleetContext,
  observed: ObservedState,
  work: Action[],
  options: ConfirmAndExecuteOptions,
): Promise<ConfirmAndExecuteOutcome> {
  if (options.dryRun === true) {
    options.write('');
    options.write('--dry-run: grove changed nothing.');
    return 'dry-run';
  }

  const skipPrompt = options.yes === true || options.force === true;
  if (hasDestructive(work) && !skipPrompt) {
    const answered = await confirm({
      question: options.question,
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.isTty === undefined ? {} : { isTty: options.isTty }),
      write: options.write,
      warn: options.writeError,
    });
    if (!answered) {
      options.write('Aborted. grove changed nothing.');
      return 'aborted';
    }
  }

  options.write('');
  const result = await executeActions(work, {
    config: fleet.loaded.config,
    hosts: new Map(observed.hosts.map((entry) => [entry.host, entry])),
    stacks: fleet.stacks,
    transports: fleet.transports,
    forgeClients: fleet.forgeClients,
    store: fleet.store,
    resolveRunnerVersion: fleet.runnerVersion,
    log: (line) => options.write(`  ${line}`),
    ...(options.nativePollIntervalMs === undefined
      ? {}
      : { nativePollIntervalMs: options.nativePollIntervalMs }),
    ...(options.clean === undefined ? {} : { clean: options.clean }),
    ...(options.force === undefined ? {} : { force: options.force }),
  });

  for (const failure of result.failed) {
    options.writeError(`failed: ${failure.error}`);
  }
  for (const action of result.skipped) {
    const name = 'name' in action ? ` ${action.name}` : '';
    options.writeError(
      `skipped after an earlier failure: ${action.kind}${name}`,
    );
  }

  return result;
}
