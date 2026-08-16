import { Command } from 'commander';

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
      'Validate the config and report which hosts grove can reach. Never acts.',
    )
    .action(async (_options: unknown, command: Command) => {
      const { runPlan } = await import('./commands/plan.js');
      process.exitCode = await runPlan({
        config: command.optsWithGlobals().config,
      });
    });

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
