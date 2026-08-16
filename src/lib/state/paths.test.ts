import { describe, expect, it } from 'vitest';
import { resolveStateDbPath, resolveStateDir } from './paths.js';

const home = '/home/olivier';

describe('resolveStateDir', () => {
  it('honours GROVE_STATE_DIR above everything else', () => {
    expect(
      resolveStateDir({
        env: { GROVE_STATE_DIR: '/srv/grove-state', XDG_STATE_HOME: '/xdg' },
        platform: 'darwin',
        home,
      }),
    ).toBe('/srv/grove-state');
  });

  it('expands a tilde in GROVE_STATE_DIR', () => {
    expect(
      resolveStateDir({
        env: { GROVE_STATE_DIR: '~/state/grove' },
        platform: 'linux',
        home,
      }),
    ).toBe('/home/olivier/state/grove');
  });

  it('uses Application Support on macOS', () => {
    expect(resolveStateDir({ env: {}, platform: 'darwin', home })).toBe(
      '/home/olivier/Library/Application Support/grove',
    );
  });

  it('uses XDG_STATE_HOME on Linux when it is set', () => {
    expect(
      resolveStateDir({
        env: { XDG_STATE_HOME: '/home/olivier/.local/state' },
        platform: 'linux',
        home,
      }),
    ).toBe('/home/olivier/.local/state/grove');
  });

  it('falls back to ~/.local/state on Linux', () => {
    expect(resolveStateDir({ env: {}, platform: 'linux', home })).toBe(
      '/home/olivier/.local/state/grove',
    );
  });

  it('ignores an empty override', () => {
    expect(
      resolveStateDir({
        env: { GROVE_STATE_DIR: '  ' },
        platform: 'linux',
        home,
      }),
    ).toBe('/home/olivier/.local/state/grove');
  });
});

describe('resolveStateDbPath', () => {
  it('appends grove.db to the state dir', () => {
    expect(resolveStateDbPath({ env: {}, platform: 'linux', home })).toBe(
      '/home/olivier/.local/state/grove/grove.db',
    );
  });
});
