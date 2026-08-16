import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './load.js';

const EXAMPLE_PATH = fileURLToPath(
  new URL('../../../grove.example.yaml', import.meta.url),
);

describe('grove.example.yaml', () => {
  it('parses with the shipped schema', async () => {
    const loaded = await loadConfig({
      path: EXAMPLE_PATH,
      env: { GH_TOKEN: 'example-token' },
    });
    expect(Object.keys(loaded.config.hosts)).toEqual(['mac', 'atlas']);
    expect(Object.keys(loaded.config.forges)).toEqual([
      'gh-overload',
      'gl-chevro',
    ]);
    expect(loaded.config.groups.map((group) => group.name)).toEqual([
      'overload-arm',
      'chevro-dind',
      'ios',
      'api-repo',
    ]);
  });

  it('exercises both placement forms', async () => {
    const loaded = await loadConfig({
      path: EXAMPLE_PATH,
      env: { GH_TOKEN: 'example-token' },
    });
    expect(loaded.config.groups[0].placement).toEqual({ mac: 2 });
    expect(loaded.config.groups[1].placement).toEqual({ atlas: 3 });
  });

  it('carries the privileged socket warning, so the docs show a real warning', async () => {
    const loaded = await loadConfig({
      path: EXAMPLE_PATH,
      env: { GH_TOKEN: 'example-token' },
    });
    expect(loaded.warnings.map((warning) => warning.code)).toEqual([
      'privileged-docker-socket',
    ]);
  });

  it('shows the docker escape hatch the README documents', async () => {
    const loaded = await loadConfig({
      path: EXAMPLE_PATH,
      env: { GH_TOKEN: 'example-token' },
    });
    expect(loaded.config.groups[3].raw).toEqual({
      docker_run_args: ['--dns', '1.1.1.1'],
      env: { HTTPS_PROXY: 'http://proxy.internal:3128' },
    });
  });

  it('uses environment interpolation rather than a literal token', async () => {
    await expect(loadConfig({ path: EXAMPLE_PATH, env: {} })).rejects.toThrow(
      /environment variable GH_TOKEN is not set/,
    );
  });
});
