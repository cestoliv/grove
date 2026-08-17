import { describe, expect, it } from 'vitest';
import {
  daemonLockPath,
  daemonLogPath,
  daemonStderrPath,
  daemonStdoutPath,
} from './paths.js';

describe('daemon paths', () => {
  const env = { GROVE_STATE_DIR: '/srv/grove-state' };

  it('puts every daemon file in the state directory', () => {
    expect(daemonLogPath({ env })).toBe('/srv/grove-state/grove.log');
    expect(daemonLockPath({ env })).toBe('/srv/grove-state/grove.pid');
    expect(daemonStdoutPath({ env })).toBe('/srv/grove-state/daemon.out.log');
    expect(daemonStderrPath({ env })).toBe('/srv/grove-state/daemon.err.log');
  });

  it('follows the platform default when nothing overrides it', () => {
    expect(
      daemonLogPath({ env: {}, platform: 'darwin', home: '/Users/o' }),
    ).toBe('/Users/o/Library/Application Support/grove/grove.log');
  });
});
