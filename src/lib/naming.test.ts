import { describe, expect, it } from 'vitest';
import type { GroupConfig, HostConfig } from './config/index.js';
import {
  containerName,
  DEFAULT_WORK_ROOT,
  isManagedName,
  launchdLabel,
  launchdPlistPath,
  parseManagedName,
  parseSharedName,
  resolveCacheRoot,
  resolveWorkRoot,
  runnerConfigDir,
  runnerDir,
  runnerInstallDir,
  runnerName,
  runnerNameFromLaunchdLabel,
  runnerNameFromSystemdUnit,
  sharedRunnerName,
  systemdUnit,
  systemdUnitPath,
} from './naming.js';

const host = { type: 'local' } as HostConfig;
const group = { name: 'overload-arm' } as GroupConfig;

describe('runnerName', () => {
  it('joins the prefix, the group and the one-based index', () => {
    expect(runnerName('overload-arm', 1)).toBe('grove-overload-arm-1');
  });

  it('names the container the same thing', () => {
    expect(containerName('overload-arm', 2)).toBe('grove-overload-arm-2');
  });
});

describe('runnerDir', () => {
  it('drops the grove prefix because the root already scopes it', () => {
    expect(runnerDir('/Volumes/ci/grove', 'overload-arm', 1)).toBe(
      '/Volumes/ci/grove/overload-arm-1',
    );
  });

  it('tolerates a trailing slash on the root', () => {
    expect(runnerDir('/Volumes/ci/grove/', 'ios', 3)).toBe(
      '/Volumes/ci/grove/ios-3',
    );
  });
});

describe('parseManagedName', () => {
  it('splits a managed name back into group and index', () => {
    expect(parseManagedName('grove-overload-arm-12')).toEqual({
      group: 'overload-arm',
      index: 12,
    });
  });

  it('keeps a trailing digit in the group when an index follows it', () => {
    expect(parseManagedName('grove-arm64-2')).toEqual({
      group: 'arm64',
      index: 2,
    });
  });

  it('rejects a name without the prefix', () => {
    expect(parseManagedName('overload-arm-1')).toBeNull();
  });

  it('rejects a name without an index', () => {
    expect(parseManagedName('grove-overload-arm')).toBeNull();
  });

  it('rejects a zero or padded index', () => {
    expect(parseManagedName('grove-ios-0')).toBeNull();
    expect(parseManagedName('grove-ios-01')).toBeNull();
  });

  it('rejects a group that could never pass config validation', () => {
    expect(parseManagedName('grove-Ios-1')).toBeNull();
    expect(parseManagedName(`grove-${'a'.repeat(41)}-1`)).toBeNull();
  });

  it('answers isManagedName from the same rule', () => {
    expect(isManagedName('grove-ios-1')).toBe(true);
    expect(isManagedName('runner-1')).toBe(false);
  });
});

describe('resolveWorkRoot', () => {
  it('prefers the group over the host', () => {
    expect(
      resolveWorkRoot({ ...host, work_root: '/host' }, {
        ...group,
        work_root: '/group',
      } as GroupConfig),
    ).toBe('/group');
  });

  it('falls back to the host, then to the default', () => {
    expect(resolveWorkRoot({ ...host, work_root: '/host' }, group)).toBe(
      '/host',
    );
    expect(resolveWorkRoot(host, group)).toBe(DEFAULT_WORK_ROOT);
  });
});

describe('resolveCacheRoot', () => {
  it('defaults to a sibling of the work root', () => {
    expect(
      resolveCacheRoot({ ...host, work_root: '/Volumes/ci/grove' }, group),
    ).toBe('/Volumes/ci/grove-cache');
  });

  it('prefers an explicit cache root', () => {
    expect(
      resolveCacheRoot({ ...host, cache_root: '/host-cache' }, group),
    ).toBe('/host-cache');
  });
});

describe('sharedRunnerName and parseSharedName', () => {
  it('describes the whole group, with no index', () => {
    expect(sharedRunnerName('chevro-dind')).toBe('grove-chevro-dind');
  });

  it('reads its own description back', () => {
    expect(parseSharedName('grove-chevro-dind')).toEqual({
      group: 'chevro-dind',
    });
  });

  it('refuses a seat name, which would be ambiguous', () => {
    expect(parseSharedName('grove-chevro-dind-1')).toBeNull();
  });

  it('refuses a name that is not grove shaped', () => {
    expect(parseSharedName('gitlab-runner')).toBeNull();
    expect(parseSharedName('grove-')).toBeNull();
    expect(parseSharedName('grove-Chevro')).toBeNull();
  });

  it('refuses a group name longer than the cap', () => {
    expect(parseSharedName(`grove-${'a'.repeat(41)}`)).toBeNull();
  });
});

describe('runnerConfigDir', () => {
  it('sits beside the work dir and names itself', () => {
    expect(runnerConfigDir('/Volumes/ci/grove', 'chevro-dind', 3)).toBe(
      '/Volumes/ci/grove/chevro-dind-3-config',
    );
  });

  it('drops a trailing slash on the root', () => {
    expect(runnerConfigDir('/PROD/local/grove/', 'chevro-dind', 1)).toBe(
      '/PROD/local/grove/chevro-dind-1-config',
    );
  });
});

describe('native seat names', () => {
  it('builds the launchd label and the systemd unit from the group and index', () => {
    expect(launchdLabel('overload-arm', 1)).toBe(
      'com.cestoliv.grove.overload-arm-1',
    );
    expect(systemdUnit('overload-arm', 1)).toBe('grove-overload-arm-1.service');
  });

  it('places the plist and the unit file under the runner user home', () => {
    expect(launchdPlistPath('/Users/olivier', 'ios', 2)).toBe(
      '/Users/olivier/Library/LaunchAgents/com.cestoliv.grove.ios-2.plist',
    );
    expect(systemdUnitPath('/home/ci', 'ios', 2)).toBe(
      '/home/ci/.config/systemd/user/grove-ios-2.service',
    );
  });

  it('trims a trailing slash off the home it was given', () => {
    expect(launchdPlistPath('/Users/olivier/', 'ios', 1)).toBe(
      '/Users/olivier/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
    );
    expect(systemdUnitPath('/home/ci/', 'ios', 1)).toBe(
      '/home/ci/.config/systemd/user/grove-ios-1.service',
    );
  });

  it('puts the install dir beside the work dir, never inside it', () => {
    expect(runnerInstallDir('/Volumes/ci/grove', 'ios', 1)).toBe(
      '/Volumes/ci/grove/ios-1-runner',
    );
    expect(runnerDir('/Volumes/ci/grove', 'ios', 1)).toBe(
      '/Volumes/ci/grove/ios-1',
    );
  });

  it('reads a runner name back out of a launchd label', () => {
    expect(runnerNameFromLaunchdLabel('com.cestoliv.grove.ios-1')).toBe(
      'grove-ios-1',
    );
    expect(runnerNameFromLaunchdLabel('com.apple.Safari')).toBeNull();
    // The daemon of milestone 5 shares the prefix and is not a seat.
    expect(runnerNameFromLaunchdLabel('com.cestoliv.grove.daemon')).toBeNull();
  });

  it('reads a runner name back out of a systemd unit', () => {
    expect(runnerNameFromSystemdUnit('grove-ios-1.service')).toBe(
      'grove-ios-1',
    );
    expect(runnerNameFromSystemdUnit('grove-daemon.service')).toBeNull();
    expect(runnerNameFromSystemdUnit('docker.service')).toBeNull();
    expect(runnerNameFromSystemdUnit('grove-ios-1')).toBeNull();
  });
});
