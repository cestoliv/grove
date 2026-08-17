import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../transport/index.js';
import {
  daemonUnitPathFor,
  installDaemon,
  readDaemonInstalled,
  uninstallDaemon,
} from './install.js';
import { buildDaemonSpec } from './units.js';

function spec() {
  return buildDaemonSpec({
    home: '/Users/olivier',
    stateDir: '/Users/olivier/state',
    configPath: '/Users/olivier/grove.yaml',
    execPath: '/usr/local/bin/node',
    script: '/opt/grove/dist/grove.js',
  });
}

describe('installDaemon on macOS', () => {
  it('writes the plist, boots out the old label and bootstraps the new one', async () => {
    const transport = new FakeTransport('control');
    const result = await installDaemon({
      transport,
      platform: 'Darwin',
      uid: '501',
      spec: spec(),
    });

    expect(result.path).toBe(
      '/Users/olivier/Library/LaunchAgents/com.cestoliv.grove.daemon.plist',
    );
    expect(transport.writes.get(result.path)).toContain('<key>KeepAlive</key>');
    expect(transport.commandLines()).toEqual([
      'mkdir -p /Users/olivier/Library/LaunchAgents',
      'launchctl bootout gui/501/com.cestoliv.grove.daemon',
      'launchctl bootstrap gui/501 /Users/olivier/Library/LaunchAgents/com.cestoliv.grove.daemon.plist',
      'launchctl kickstart gui/501/com.cestoliv.grove.daemon',
    ]);
  });

  it('tolerates a bootout for a label that is not loaded', async () => {
    const transport = new FakeTransport('control').fail(
      'launchctl bootout',
      'Boot-out failed: 3: No such process',
    );
    await expect(
      installDaemon({
        transport,
        platform: 'Darwin',
        uid: '501',
        spec: spec(),
      }),
    ).resolves.toBeDefined();
  });

  it('refuses without a uid, because launchd addresses its domain by one', async () => {
    await expect(
      installDaemon({
        transport: new FakeTransport('control'),
        platform: 'Darwin',
        spec: spec(),
      }),
    ).rejects.toThrow(/uid/);
  });
});

describe('installDaemon on Linux', () => {
  it('writes the unit, reloads and enables it', async () => {
    const transport = new FakeTransport('control');
    const result = await installDaemon({
      transport,
      platform: 'Linux',
      uid: '1000',
      spec: spec(),
    });

    expect(result.path).toBe(
      '/Users/olivier/.config/systemd/user/grove-daemon.service',
    );
    expect(transport.writes.get(result.path)).toContain('Restart=on-failure');
    expect(transport.commandLines()).toEqual([
      'mkdir -p /Users/olivier/.config/systemd/user',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now grove-daemon.service',
    ]);
  });

  it('names lingering when the user bus is missing', async () => {
    const transport = new FakeTransport('control').fail(
      'systemctl --user daemon-reload',
      'Failed to connect to bus: No medium found',
    );
    await expect(
      installDaemon({
        transport,
        platform: 'Linux',
        uid: '1000',
        spec: spec(),
      }),
    ).rejects.toThrow(/loginctl enable-linger/);
  });
});

describe('uninstallDaemon', () => {
  it('boots the label out and removes the plist', async () => {
    const transport = new FakeTransport('control');
    await uninstallDaemon({
      transport,
      platform: 'Darwin',
      uid: '501',
      spec: spec(),
    });
    expect(transport.commandLines()).toEqual([
      'launchctl bootout gui/501/com.cestoliv.grove.daemon',
      'rm -f /Users/olivier/Library/LaunchAgents/com.cestoliv.grove.daemon.plist',
    ]);
  });

  it('disables the unit, removes it and reloads', async () => {
    const transport = new FakeTransport('control');
    await uninstallDaemon({
      transport,
      platform: 'Linux',
      uid: '1000',
      spec: spec(),
    });
    expect(transport.commandLines()).toEqual([
      'systemctl --user disable --now grove-daemon.service',
      'rm -f /Users/olivier/.config/systemd/user/grove-daemon.service',
      'systemctl --user daemon-reload',
    ]);
  });
});

describe('readDaemonInstalled', () => {
  it('answers from the presence of the file the supervisor reads', async () => {
    const present = new FakeTransport('control');
    expect(
      await readDaemonInstalled({
        transport: present,
        platform: 'Linux',
        spec: spec(),
      }),
    ).toBe(true);

    const absent = new FakeTransport('control').fail('test -f', '', 1);
    expect(
      await readDaemonInstalled({
        transport: absent,
        platform: 'Linux',
        spec: spec(),
      }),
    ).toBe(false);
  });
});

describe('daemonUnitPathFor', () => {
  it('picks the plist on a Mac and the unit on Linux', () => {
    expect(daemonUnitPathFor(spec(), 'Darwin')).toContain('LaunchAgents');
    expect(daemonUnitPathFor(spec(), 'Linux')).toContain('systemd/user');
  });
});
