import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rawStackWarnings } from '../stack/index.js';
import { loadConfig } from './load.js';
import { nativeOptionWarnings } from './warnings.js';

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

  it('shows the gitlab job image the README documents', async () => {
    const loaded = await loadConfig({
      path: EXAMPLE_PATH,
      env: { GH_TOKEN: 'example-token' },
    });
    expect(loaded.config.groups[1].raw).toEqual({ job_image: 'docker:27' });
  });

  it('uses environment interpolation rather than a literal token', async () => {
    await expect(loadConfig({ path: EXAMPLE_PATH, env: {} })).rejects.toThrow(
      /environment variable GH_TOKEN is not set/,
    );
  });
});

describe('grove.example.yaml, the native group', () => {
  it('shows the two raw keys a native group reads', async () => {
    const loaded = await loadConfig({
      path: EXAMPLE_PATH,
      env: { GH_TOKEN: 'example-token' },
    });
    const ios = loaded.config.groups[2];
    expect(ios.name).toBe('ios');
    expect(ios.stack).toBe('native');
    expect(ios.raw).toEqual({
      runner_version: '2.328.0',
      env: { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' },
    });
  });

  it('raises no unused-key warning for that group', async () => {
    const loaded = await loadConfig({
      path: EXAMPLE_PATH,
      env: { GH_TOKEN: 'example-token' },
    });
    expect(
      rawStackWarnings(loaded.config).filter((warning) =>
        warning.path.startsWith('groups[2]'),
      ),
    ).toEqual([]);
    expect(
      nativeOptionWarnings(loaded.config).filter((warning) =>
        warning.path.startsWith('groups[2]'),
      ),
    ).toEqual([]);
  });
});
