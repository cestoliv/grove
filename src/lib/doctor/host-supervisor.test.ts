import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import { createHostContext } from './host-context.js';
import {
  curlCheck,
  launchdCheck,
  lingeringCheck,
  simulatorsCheck,
  systemdUserCheck,
  xcodebuildCheck,
  xcodeSelectCheck,
} from './host-supervisor.js';

function configWith(
  stack: 'docker' | 'native',
  extra: Record<string, unknown> = {},
): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { box: { type: 'ssh', host: 'box', work_root: '/srv/grove' } },
    forges: { gh: { kind: 'github' } },
    groups: [
      {
        name: 'seat',
        forge: 'gh',
        scope: { level: 'organization', target: 'Acme' },
        placement: { box: 1 },
        stack,
        ...extra,
      },
    ],
  } as unknown as GroveConfig;
}

function contextFor(
  transport: FakeTransport,
  stack: 'docker' | 'native' = 'native',
  config?: GroveConfig,
) {
  return createHostContext({
    host: 'box',
    config: config ?? configWith(stack),
    transport,
  });
}

const LINUX = { stdout: 'Linux x86_64\n' };
const DARWIN = { stdout: 'Darwin arm64\n' };

describe('systemdUserCheck', () => {
  it('passes when the user manager answers', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('systemctl --user is-system-running', { stdout: 'running\n' }),
    );
    const [result] = await systemdUserCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('passes a degraded manager, because the bus is what grove needs', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('systemctl --user is-system-running', {
          code: 1,
          stdout: 'degraded\n',
        }),
    );
    const [result] = await systemdUserCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('passes a manager that is still initializing', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('systemctl --user is-system-running', {
          code: 1,
          stdout: 'initializing\n',
        }),
    );
    const [result] = await systemdUserCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('reaches the user bus the way the native stack does', async () => {
    const transport = new FakeTransport('box')
      .on('uname -sm', LINUX)
      .on('id -u', { stdout: '1000\n' })
      .on('systemctl --user is-system-running', { stdout: 'running\n' });
    await systemdUserCheck.run(contextFor(transport));
    const call = transport.calls.find((each) => each.command === 'systemctl');
    // An SSH session is not a login session, so systemctl finds no user bus
    // unless grove points it at one, exactly as the native stack does.
    expect(call?.options?.env).toEqual({ XDG_RUNTIME_DIR: '/run/user/1000' });
  });

  it('fails when the bus is missing and a native group needs it', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .fail(
          'systemctl --user is-system-running',
          'Failed to connect to bus: No medium found',
        ),
    );
    const [result] = await systemdUserCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('enable-linger');
  });

  it('only warns when nothing on the host needs a user unit', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .fail(
          'systemctl --user is-system-running',
          'Failed to connect to bus: No medium found',
        ),
      'docker',
    );
    const [result] = await systemdUserCheck.run(context);
    expect(result.status).toBe('warn');
  });

  it('skips on macOS', async () => {
    const context = contextFor(
      new FakeTransport('box').on('uname -sm', DARWIN),
    );
    const [result] = await systemdUserCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('lingeringCheck', () => {
  it('passes when lingering is on', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('sh -c loginctl', { stdout: 'Linger=yes\n' }),
    );
    const [result] = await lingeringCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('fails when it is off and a native group needs it', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('sh -c loginctl', { stdout: 'Linger=no\n' }),
    );
    const [result] = await lingeringCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('loginctl enable-linger');
  });

  it('only warns on a host with no native group', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('sh -c loginctl', { stdout: 'Linger=no\n' }),
      'docker',
    );
    const [result] = await lingeringCheck.run(context);
    expect(result.status).toBe('warn');
  });

  it('skips on macOS', async () => {
    const context = contextFor(
      new FakeTransport('box').on('uname -sm', DARWIN),
    );
    const [result] = await lingeringCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('launchdCheck', () => {
  it('passes when the GUI domain answers', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('id -u', { stdout: '501\n' })
        .on('launchctl print gui/501', {
          stdout: 'com.apple.launchd.peruser\n',
        }),
    );
    const [result] = await launchdCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('fails when there is no login session to load an agent into', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('id -u', { stdout: '501\n' })
        .fail('launchctl print gui/501', 'Could not find domain for'),
    );
    const [result] = await launchdCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('Log in');
  });

  it('fails when id -u printed no uid to name the domain with', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .fail('id -u', 'id: command not found', 127),
    );
    const [result] = await launchdCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('uid');
  });

  it('skips on Linux', async () => {
    const context = contextFor(new FakeTransport('box').on('uname -sm', LINUX));
    const [result] = await launchdCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('xcodeSelectCheck', () => {
  it('passes a developer directory that is there', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('xcode-select -p', {
          stdout: '/Applications/Xcode.app/Contents/Developer\n',
        })
        .on('test -d /Applications/Xcode.app/Contents/Developer', { code: 0 }),
    );
    const [result] = await xcodeSelectCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('warns when it points at the command line tools', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('xcode-select -p', {
          stdout: '/Library/Developer/CommandLineTools\n',
        })
        .on('test -d /Library/Developer/CommandLineTools', { code: 0 }),
    );
    const [result] = await xcodeSelectCheck.run(context);
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('xcode-select -s');
  });

  it('fails when the path it names does not exist', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('xcode-select -p', {
          stdout: '/Applications/Xcode.app/Contents/Developer\n',
        })
        .on('test -d /Applications/Xcode.app/Contents/Developer', { code: 1 }),
    );
    const [result] = await xcodeSelectCheck.run(context);
    expect(result.status).toBe('fail');
  });

  it('fails when xcode-select itself does not answer', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .fail('xcode-select -p', 'xcode-select: error: no developer tools', 2),
    );
    const [result] = await xcodeSelectCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('xcode-select -s');
  });

  it('skips a Mac with no native group on it', async () => {
    const context = contextFor(
      new FakeTransport('box').on('uname -sm', DARWIN),
      'docker',
    );
    const [result] = await xcodeSelectCheck.run(context);
    expect(result.status).toBe('skip');
  });

  it('skips on Linux', async () => {
    const context = contextFor(new FakeTransport('box').on('uname -sm', LINUX));
    const [result] = await xcodeSelectCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('xcodebuildCheck', () => {
  it('reports the version', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('xcodebuild -version', {
          stdout: 'Xcode 16.2\nBuild version 16C5032a\n',
        }),
    );
    const [result] = await xcodebuildCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('Xcode 16.2');
  });

  it('names the licence in the fix when that is what xcodebuild said', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .fail(
          'xcodebuild -version',
          'You have not agreed to the Xcode license agreements.',
          69,
        ),
    );
    const [result] = await xcodebuildCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('xcodebuild -license accept');
  });

  it('points at the install when xcodebuild is not there at all', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .fail('xcodebuild -version', 'xcodebuild: command not found', 127),
    );
    const [result] = await xcodebuildCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('App Store');
  });

  it('skips a Mac with no native group on it', async () => {
    const context = contextFor(
      new FakeTransport('box').on('uname -sm', DARWIN),
      'docker',
    );
    const [result] = await xcodebuildCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('simulatorsCheck', () => {
  it('counts the available devices', async () => {
    const devices = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'a', name: 'iPhone 16', isAvailable: true },
          { udid: 'b', name: 'iPad', isAvailable: true },
        ],
      },
    });
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('xcrun simctl', { stdout: devices }),
    );
    const [result] = await simulatorsCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('2');
  });

  it('leaves out a device simctl marked unavailable', async () => {
    const devices = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'a', name: 'iPhone 16', isAvailable: true },
          { udid: 'b', name: 'iPhone 12', isAvailable: false },
          { udid: 'c', name: 'iPad' },
        ],
      },
    });
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('xcrun simctl', { stdout: devices }),
    );
    const [result] = await simulatorsCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('2 simulator devices available');
  });

  it('warns when every device it listed is unavailable', async () => {
    const devices = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'a', name: 'iPhone 16', isAvailable: false },
        ],
      },
    });
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('xcrun simctl', { stdout: devices }),
    );
    const [result] = await simulatorsCheck.run(context);
    expect(result.status).toBe('warn');
  });

  it('warns when there is none, because a macOS-only group needs none', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('xcrun simctl', { stdout: JSON.stringify({ devices: {} }) }),
    );
    const [result] = await simulatorsCheck.run(context);
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('downloadPlatform');
  });

  it('warns when simctl printed something that is not JSON', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', DARWIN)
        .on('xcrun simctl', { stdout: 'xcrun: error: unable to find utility' }),
    );
    const [result] = await simulatorsCheck.run(context);
    expect(result.status).toBe('warn');
  });

  it('skips a Mac with no native group on it', async () => {
    const context = contextFor(
      new FakeTransport('box').on('uname -sm', DARWIN),
      'docker',
    );
    const [result] = await simulatorsCheck.run(context);
    expect(result.status).toBe('skip');
  });
});

describe('curlCheck', () => {
  // A GitLab Docker group, because that is the only kind whose seats publish a
  // gitlab-runner metrics port for grove to scrape.
  function gitlab(extra: Record<string, unknown> = {}): GroveConfig {
    return {
      ...configWith('docker', {
        forge: 'gl',
        raw: { metrics_port: 9252 },
        ...extra,
      }),
      forges: { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
    } as unknown as GroveConfig;
  }

  const WITH_METRICS = {
    ...gitlab(),
    metrics: { listen: '127.0.0.1:9130', scrapeCacheMs: 10_000 },
  } as unknown as GroveConfig;

  it('passes when curl is on the PATH', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .on('sh -c command -v curl', { stdout: '/usr/bin/curl\n' }),
      'docker',
      WITH_METRICS,
    );
    const [result] = await curlCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('fails when the exporter needs it and it is missing', async () => {
    const context = contextFor(
      new FakeTransport('box')
        .on('uname -sm', LINUX)
        .fail('sh -c command -v curl', '', 1),
      'docker',
      WITH_METRICS,
    );
    const [result] = await curlCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('metrics_port');
  });

  it('skips when no seat on this host publishes a metrics port', async () => {
    const context = contextFor(
      new FakeTransport('box').on('uname -sm', LINUX),
      'docker',
    );
    const [result] = await curlCheck.run(context);
    expect(result.status).toBe('skip');
    expect(result.summary).toBe(
      'no seat on this host publishes a gitlab-runner metrics port',
    );
  });

  it('skips when the only group declaring a port is not a GitLab Docker one', async () => {
    // `configWith` builds a GitHub group. A GitHub Actions runner exposes no
    // metrics endpoint, so the port publishes nothing and curl is not needed.
    const context = contextFor(
      new FakeTransport('box').on('uname -sm', LINUX),
      'docker',
      {
        ...configWith('docker', { raw: { metrics_port: 9252 } }),
        metrics: { listen: '127.0.0.1:9130', scrapeCacheMs: 10_000 },
      } as unknown as GroveConfig,
    );
    const [result] = await curlCheck.run(context);
    expect(result.status).toBe('skip');
    expect(result.summary).toBe(
      'no seat on this host publishes a gitlab-runner metrics port',
    );
  });

  it('names the exporter, not the port, when a seat publishes one and metrics is off', async () => {
    const context = contextFor(
      new FakeTransport('box').on('uname -sm', LINUX),
      'docker',
      gitlab(),
    );
    const [result] = await curlCheck.run(context);
    expect(result.status).toBe('skip');
    // The port is published, so the reason is the missing exporter. Saying
    // "no seat publishes a port" would send an operator to the wrong half of
    // the config.
    expect(result.summary).toBe(
      'metrics.listen is not set, so no seat metrics are re-exported',
    );
  });
});
