import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram } from './program.js';

describe('buildProgram', () => {
  it('is named grove and carries the package version', () => {
    const program = buildProgram();
    expect(program.name()).toBe('grove');
    expect(program.version()).toBe(__VERSION__);
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('registers the milestone 1 commands', () => {
    const names = buildProgram()
      .commands.map((command) => command.name())
      .sort();
    expect(names).toEqual(['config', 'plan']);
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

  it('wires --config through to the plan command and exits zero for a reachable local host', async () => {
    dir = await mkdtemp(join(tmpdir(), 'grove-program-'));
    const configPath = join(dir, 'grove.yaml');
    await writeFile(
      configPath,
      `
hosts:
  mac: { type: local }

forges:
  gh: { kind: github }

groups:
  - name: local-group
    forge: gh
    scope: { level: organization, target: x }
    placement: { host: mac, count: 1 }
`,
      'utf8',
    );

    await buildProgram().parseAsync(['--config', configPath, 'plan'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(0);
  });
});
