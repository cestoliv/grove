import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TAIL } from './lib/log-defaults.js';
import { buildProgram } from './program.js';

describe('buildProgram', () => {
  it('is named grove and carries the package version', () => {
    const program = buildProgram();
    expect(program.name()).toBe('grove');
    expect(program.version()).toBe(__VERSION__);
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('registers every command', () => {
    const names = buildProgram()
      .commands.map((command) => command.name())
      .sort();
    expect(names).toEqual([
      'apply',
      'config',
      'logs',
      'plan',
      'status',
      'teardown',
    ]);
  });

  it('accepts --config as a global option', () => {
    const flags = buildProgram()
      .options.map((option) => option.flags)
      .join(' ');
    expect(flags).toContain('-c, --config <path>');
  });

  it('gives the config command a --path flag', () => {
    const config = buildProgram().commands.find(
      (command) => command.name() === 'config',
    );
    expect(config?.options.map((option) => option.flags)).toContain('--path');
  });

  it('gives the apply command its four flags', () => {
    const apply = buildProgram().commands.find(
      (command) => command.name() === 'apply',
    );
    const flags = apply?.options.map((option) => option.flags) ?? [];
    expect(flags).toContain('--dry-run');
    expect(flags).toContain('-y, --yes');
    expect(flags).toContain('--force');
    expect(flags).toContain('--clean');
  });

  it('gives the teardown command its four flags', () => {
    const teardown = buildProgram().commands.find(
      (command) => command.name() === 'teardown',
    );
    const flags = teardown?.options.map((option) => option.flags) ?? [];
    expect(flags).toContain('--include-unmanaged');
    expect(flags).toContain('--dry-run');
    expect(flags).toContain('-y, --yes');
    expect(flags).toContain('--force');
  });

  it('defaults --tail to the value the logs command uses', () => {
    const logs = buildProgram().commands.find(
      (command) => command.name() === 'logs',
    );
    const tail = logs?.options.find(
      (option) => option.flags === '--tail <lines>',
    );
    expect(tail?.defaultValue).toBe(String(DEFAULT_TAIL));
  });

  it('describes every command, so grove --help is useful', () => {
    for (const command of buildProgram().commands) {
      expect(command.description().length).toBeGreaterThan(10);
    }
  });
});

describe('buildProgram, run end to end', () => {
  let dir: string;

  afterEach(async () => {
    process.exitCode = undefined;
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The plan command now opens a fleet, so a run that reached a config would
  // touch hosts and a forge. A missing file proves the wiring without that.
  it('wires --config through to the plan command', async () => {
    dir = await mkdtemp(join(tmpdir(), 'grove-program-'));
    const configPath = join(dir, 'nowhere.yaml');
    const errors: string[] = [];
    const spy = console.error;
    console.error = (text: string) => errors.push(text);
    try {
      await buildProgram().parseAsync(['--config', configPath, 'plan'], {
        from: 'user',
      });
    } finally {
      console.error = spy;
    }

    expect(process.exitCode).toBe(2);
    expect(errors.join('\n')).toContain(configPath);
  });

  it('refuses a --tail that is not a whole number and opens nothing', async () => {
    const errors: string[] = [];
    const spy = console.error;
    console.error = (text: string) => errors.push(text);
    try {
      await buildProgram().parseAsync(
        ['logs', 'overload-arm', '--tail', 'abc'],
        { from: 'user' },
      );
    } finally {
      console.error = spy;
    }

    expect(process.exitCode).toBe(2);
    expect(errors.join('\n')).toBe(
      '--tail wants a whole number of lines, not "abc".',
    );
  });
});
