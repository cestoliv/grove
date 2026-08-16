import { describe, expect, it } from 'vitest';
import { expandHome } from '../paths.js';
import { DEFAULT_CONFIG_FILE, resolveConfigPath } from './paths.js';

describe('expandHome', () => {
  it('expands a leading tilde', () => {
    expect(expandHome('~/ci/ios', { HOME: '/Users/me' })).toBe(
      '/Users/me/ci/ios',
    );
  });

  it('expands a bare tilde', () => {
    expect(expandHome('~', { HOME: '/Users/me' })).toBe('/Users/me');
  });

  it('leaves an absolute path alone', () => {
    expect(expandHome('/Volumes/ci/grove', { HOME: '/Users/me' })).toBe(
      '/Volumes/ci/grove',
    );
  });

  it('leaves a tilde inside the path alone', () => {
    expect(expandHome('/tmp/~backup', { HOME: '/Users/me' })).toBe(
      '/tmp/~backup',
    );
  });
});

describe('resolveConfigPath', () => {
  it('defaults to grove.yaml in the working directory', () => {
    expect(DEFAULT_CONFIG_FILE).toBe('grove.yaml');
    expect(resolveConfigPath({ env: {}, cwd: '/work' })).toBe(
      '/work/grove.yaml',
    );
  });

  it('prefers GROVE_CONFIG over the default', () => {
    expect(
      resolveConfigPath({ env: { GROVE_CONFIG: 'fleet.yaml' }, cwd: '/work' }),
    ).toBe('/work/fleet.yaml');
  });

  it('prefers an explicit path over GROVE_CONFIG', () => {
    expect(
      resolveConfigPath({
        explicit: '/etc/grove/fleet.yaml',
        env: { GROVE_CONFIG: 'fleet.yaml' },
        cwd: '/work',
      }),
    ).toBe('/etc/grove/fleet.yaml');
  });

  it('expands a tilde in either source', () => {
    expect(
      resolveConfigPath({
        explicit: '~/fleet.yaml',
        env: { HOME: '/Users/me' },
        cwd: '/work',
      }),
    ).toBe('/Users/me/fleet.yaml');
  });

  it('always returns an absolute path', () => {
    expect(
      resolveConfigPath({
        explicit: 'nested/grove.yaml',
        env: {},
        cwd: '/work',
      }),
    ).toBe('/work/nested/grove.yaml');
  });
});
