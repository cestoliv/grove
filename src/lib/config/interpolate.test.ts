import { describe, expect, it } from 'vitest';
import { interpolateEnv } from './interpolate.js';

// Built at runtime so secret scanners do not match the fixture.
const FAKE_GHP_ENV = ['ghp', 'from_the_environment'].join('_');

describe('interpolateEnv', () => {
  it('expands a variable inside a nested string', () => {
    const result = interpolateEnv(
      { forges: { gh: { auth: { token: '${GH_TOKEN}' } } } },
      { GH_TOKEN: FAKE_GHP_ENV },
    );
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual({
      forges: { gh: { auth: { token: FAKE_GHP_ENV } } },
    });
  });

  it('expands variables inside arrays and keeps other scalars intact', () => {
    const result = interpolateEnv(
      {
        groups: [
          { volumes: ['${CACHE}:/cache'], concurrent: 4, privileged: true },
        ],
      },
      { CACHE: '/Volumes/ci/cache' },
    );
    expect(result.value).toEqual({
      groups: [
        {
          volumes: ['/Volumes/ci/cache:/cache'],
          concurrent: 4,
          privileged: true,
        },
      ],
    });
  });

  it('expands several variables in one string', () => {
    const result = interpolateEnv(
      { work_root: '${ROOT}/${NAME}' },
      {
        ROOT: '/Volumes/ci',
        NAME: 'grove',
      },
    );
    expect(result.value).toEqual({ work_root: '/Volumes/ci/grove' });
  });

  it('reports an unset variable and names the path', () => {
    const result = interpolateEnv(
      { forges: { gh: { auth: { token: '${GH_TOKEN}' } } } },
      {},
    );
    expect(result.issues).toEqual([
      {
        path: 'forges.gh.auth.token',
        message:
          'environment variable GH_TOKEN is not set. Export it, or use a command: source instead.',
      },
    ]);
  });

  it('names an array index in the reported path', () => {
    const result = interpolateEnv({ groups: [{ volumes: ['${CACHE}'] }] }, {});
    expect(result.issues[0].path).toBe('groups[0].volumes[0]');
  });

  it('treats an empty variable as unset', () => {
    const result = interpolateEnv({ token: '${EMPTY}' }, { EMPTY: '' });
    expect(result.issues).toHaveLength(1);
  });

  it('leaves a string with no placeholder alone', () => {
    const result = interpolateEnv({ host: 'atlas' }, {});
    expect(result.value).toEqual({ host: 'atlas' });
    expect(result.issues).toEqual([]);
  });
});
