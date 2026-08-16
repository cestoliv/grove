import { Command } from 'commander';
import { EXIT_INVALID_CONFIG } from './lib/exit-codes.js';
import { DEFAULT_TAIL } from './lib/log-defaults.js';

// `docker logs --tail NaN` is not an error grove should let a host see, so the
// value is read here and the run stops before anything opens.
function parseTail(value: string): number | undefined {
  const lines = Number(value);
  return Number.isInteger(lines) && lines >= 0 ? lines : undefined;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('grove')
    .description(
      'Declarative self-hosted CI runner fleets for GitHub and GitLab',
    )
    .version(__VERSION__)
    .option(
      '-c, --config <path>',
      'Path to grove.yaml, overriding GROVE_CONFIG and ./grove.yaml',
    );

  program
    .command('plan')
    .description(
      'Show the diff between the config and every reachable host. Never acts.',
    )
    .action(async (_options: unknown, command: Command) => {
      const { runPlan } = await import('./commands/plan.js');
      process.exitCode = await runPlan({
        config: command.optsWithGlobals().config,
      });
    });

  program
    .command('apply')
    .description(
      'Converge the fleet. Prints the diff first and confirms before destroying.',
    )
    .option('--dry-run', 'Print the diff and change nothing')
    .option('-y, --yes', 'Answer yes to the confirmation')
    .option('--force', 'Skip the drain wait and the confirmation')
    .option('--clean', 'Wipe work directories on this pass')
    .action(
      async (
        options: {
          dryRun?: boolean;
          yes?: boolean;
          force?: boolean;
          clean?: boolean;
        },
        command: Command,
      ) => {
        const { runApply } = await import('./commands/apply.js');
        process.exitCode = await runApply({
          config: command.optsWithGlobals().config,
          ...options,
        });
      },
    );

  program
    .command('teardown')
    .description('Drain and remove managed runners.')
    .option(
      '--include-unmanaged',
      'Also remove runners whose name matches but that grove has no record of',
    )
    .option('--dry-run', 'Print what would go and change nothing')
    .option('-y, --yes', 'Answer yes to the confirmation')
    .option('--force', 'Skip the drain wait and the confirmation')
    .action(
      async (
        options: {
          includeUnmanaged?: boolean;
          dryRun?: boolean;
          yes?: boolean;
          force?: boolean;
        },
        command: Command,
      ) => {
        const { runTeardown } = await import('./commands/teardown.js');
        process.exitCode = await runTeardown({
          config: command.optsWithGlobals().config,
          ...options,
        });
      },
    );

  program
    .command('status')
    .description('Table of groups, hosts, runners and state. Takes --json.')
    .option('--json', 'Print the report as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      const { runStatus } = await import('./commands/status.js');
      process.exitCode = await runStatus({
        config: command.optsWithGlobals().config,
        ...options,
      });
    });

  program
    .command('logs')
    .description('Read a group or a runner logs from Docker.')
    .argument('<target>', 'A group name or a runner name')
    .option('-f, --follow', 'Stream new lines as they arrive')
    .option(
      '--tail <lines>',
      'How many lines to print first',
      String(DEFAULT_TAIL),
    )
    .action(
      async (
        target: string,
        options: { follow?: boolean; tail?: string },
        command: Command,
      ) => {
        const tail =
          options.tail === undefined ? DEFAULT_TAIL : parseTail(options.tail);
        if (tail === undefined) {
          console.error(
            `--tail wants a whole number of lines, not "${options.tail}".`,
          );
          process.exitCode = EXIT_INVALID_CONFIG;
          return;
        }
        const { runLogs } = await import('./commands/logs.js');
        process.exitCode = await runLogs({
          config: command.optsWithGlobals().config,
          target,
          ...(options.follow === undefined ? {} : { follow: options.follow }),
          tail,
        });
      },
    );

  program
    .command('config')
    .description(
      'Open grove.yaml in $VISUAL or $EDITOR, or print its path with --path',
    )
    .option('--path', 'Print the config path and exit')
    .action(async (options: { path?: boolean }, command: Command) => {
      const { runConfig } = await import('./commands/config.js');
      process.exitCode = await runConfig({
        config: command.optsWithGlobals().config,
        path: options.path,
      });
    });

  return program;
}
