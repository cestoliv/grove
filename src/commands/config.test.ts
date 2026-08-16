import { describe, expect, it } from 'vitest';
import { createFakeSpawn } from '../lib/transport/test-utils.js';
import { runConfig } from './config.js';

describe('runConfig', () => {
  it('prints the resolved path and exits zero with --path', async () => {
    const lines: string[] = [];
    const code = await runConfig({
      path: true,
      env: {},
      cwd: '/work',
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines).toEqual(['/work/grove.yaml']);
  });

  it('prints the path GROVE_CONFIG points at', async () => {
    const lines: string[] = [];
    await runConfig({
      path: true,
      env: { GROVE_CONFIG: '/etc/grove/fleet.yaml' },
      cwd: '/work',
      stdout: (line) => lines.push(line),
    });
    expect(lines).toEqual(['/etc/grove/fleet.yaml']);
  });

  it('prints the path --config points at', async () => {
    const lines: string[] = [];
    await runConfig({
      config: '/etc/grove/other.yaml',
      path: true,
      env: { GROVE_CONFIG: '/etc/grove/fleet.yaml' },
      cwd: '/work',
      stdout: (line) => lines.push(line),
    });
    expect(lines).toEqual(['/etc/grove/other.yaml']);
  });

  it('opens the config in $EDITOR', async () => {
    const { spawnFn, calls } = createFakeSpawn();
    const code = await runConfig({
      env: { EDITOR: 'hx' },
      cwd: '/work',
      spawnFn,
      stdout: () => undefined,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('hx');
    expect(calls[0].args).toEqual(['/work/grove.yaml']);
    expect(calls[0].options.stdio).toBe('inherit');
  });

  it('prefers VISUAL over EDITOR', async () => {
    const { spawnFn, calls } = createFakeSpawn();
    await runConfig({
      env: { VISUAL: 'code -w', EDITOR: 'hx' },
      cwd: '/work',
      spawnFn,
      stdout: () => undefined,
    });
    expect(calls[0].command).toBe('code');
    expect(calls[0].args).toEqual(['-w', '/work/grove.yaml']);
  });

  it('falls back to VISUAL and then to nano', async () => {
    const visual = createFakeSpawn();
    await runConfig({
      env: { VISUAL: 'code -w' },
      cwd: '/work',
      spawnFn: visual.spawnFn,
      stdout: () => undefined,
    });
    expect(visual.calls[0].command).toBe('code');
    expect(visual.calls[0].args).toEqual(['-w', '/work/grove.yaml']);

    const fallback = createFakeSpawn();
    await runConfig({
      env: {},
      cwd: '/work',
      spawnFn: fallback.spawnFn,
      stdout: () => undefined,
    });
    expect(fallback.calls[0].command).toBe('nano');
  });

  it('treats an empty EDITOR as unset and falls back to nano', async () => {
    const { spawnFn, calls } = createFakeSpawn();
    await runConfig({
      env: { EDITOR: '' },
      cwd: '/work',
      spawnFn,
      stdout: () => undefined,
    });
    expect(calls[0].command).toBe('nano');
  });

  it('announces the file it is about to open', async () => {
    const lines: string[] = [];
    const { spawnFn } = createFakeSpawn();
    await runConfig({
      env: { EDITOR: 'hx' },
      cwd: '/work',
      spawnFn,
      stdout: (line) => lines.push(line),
    });
    expect(lines).toEqual(['Config: /work/grove.yaml']);
  });

  it('returns the editor exit code', async () => {
    const { spawnFn } = createFakeSpawn({ code: 5 });
    const code = await runConfig({
      env: { EDITOR: 'hx' },
      cwd: '/work',
      spawnFn,
      stdout: () => undefined,
    });
    expect(code).toBe(5);
  });
});
