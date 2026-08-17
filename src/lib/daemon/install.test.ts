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

const PLIST =
  '/Users/olivier/Library/LaunchAgents/com.cestoliv.grove.daemon.plist';

// What `launchctl print` answers about a label the domain no longer holds,
// and about one it does.
const GONE = { code: 1, stderr: 'Could not find service "…" in domain' };
const LOADED = { code: 0, stdout: 'com.cestoliv.grove.daemon = {\n' };

// The ordinary Mac: the bootout has finished by the time grove asks, and the
// label is loaded when grove checks after the kickstart.
function macTransport(): FakeTransport {
  return new FakeTransport('control').onEach('launchctl print', [GONE, LOADED]);
}

// No test waits on a real timer. Every nap is recorded, so a test can say
// that grove waited rather than hammered.
function macInstall(
  transport: FakeTransport,
  naps: number[] = [],
): Promise<Awaited<ReturnType<typeof installDaemon>>> {
  return installDaemon({
    transport,
    platform: 'Darwin',
    uid: '501',
    spec: spec(),
    sleep: async (ms) => {
      naps.push(ms);
    },
  });
}

describe('installDaemon on macOS', () => {
  it('writes the plist, boots out the old label and bootstraps the new one', async () => {
    const transport = macTransport();
    const result = await macInstall(transport);

    expect(result.path).toBe(PLIST);
    expect(transport.writes.get(result.path)).toContain('<key>KeepAlive</key>');
    // Every command grove ran, probes included, in the order it ran them.
    expect(result.commands).toEqual(transport.commandLines());
    expect(transport.commandLines()).toEqual([
      'mkdir -p /Users/olivier/Library/LaunchAgents',
      'launchctl bootout gui/501/com.cestoliv.grove.daemon',
      'launchctl print gui/501/com.cestoliv.grove.daemon',
      `launchctl bootstrap gui/501 ${PLIST}`,
      'launchctl kickstart gui/501/com.cestoliv.grove.daemon',
      'launchctl print gui/501/com.cestoliv.grove.daemon',
    ]);
  });

  it('waits for launchd to let the old label go before it bootstraps', async () => {
    const transport = new FakeTransport('control').onEach('launchctl print', [
      LOADED,
      LOADED,
      GONE,
      LOADED,
    ]);
    const naps: number[] = [];
    await macInstall(transport, naps);

    const lines = transport.commandLines();
    const bootstrap = lines.indexOf(`launchctl bootstrap gui/501 ${PLIST}`);
    expect(
      lines
        .slice(0, bootstrap)
        .filter((line) => line.startsWith('launchctl print')),
    ).toHaveLength(3);
    expect(naps).toEqual([100, 100]);
  });

  it('retries a bootstrap launchd answers with an I/O error', async () => {
    const transport = macTransport().onEach('launchctl bootstrap', [
      { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' },
      { code: 0 },
    ]);
    const naps: number[] = [];
    await macInstall(transport, naps);

    expect(
      transport
        .commandLines()
        .filter((line) => line.startsWith('launchctl bootstrap')),
    ).toHaveLength(2);
    expect(naps).toEqual([100]);
  });

  it('gives up when launchd keeps answering with an I/O error', async () => {
    const transport = macTransport().fail(
      'launchctl bootstrap',
      'Bootstrap failed: 5: Input/output error',
      5,
    );
    await expect(macInstall(transport)).rejects.toThrow(
      /failed 5 times.*Input\/output error.*launchctl bootstrap gui\/501/s,
    );
    expect(
      transport
        .commandLines()
        .filter((line) => line.startsWith('launchctl bootstrap')),
    ).toHaveLength(5);
  });

  it('treats a label already bootstrapped as loaded once the old one has gone', async () => {
    const transport = macTransport().fail(
      'launchctl bootstrap',
      'Load failed: 37: service already bootstrapped',
      37,
    );
    await expect(macInstall(transport)).resolves.toBeDefined();
  });

  it('refuses a label already bootstrapped while the old job is still there', async () => {
    // launchd never let the old job go, so the label this bootstrap bounces
    // off is the plist grove just replaced.
    const transport = new FakeTransport('control')
      .on('launchctl print', LOADED)
      .fail(
        'launchctl bootstrap',
        'Load failed: 37: service already bootstrapped',
        37,
      );
    const naps: number[] = [];
    await expect(macInstall(transport, naps)).rejects.toThrow(
      new RegExp(
        `still holds the job it had before this install.*${PLIST}.*launchctl bootstrap gui/501`,
        's',
      ),
    );
    // The whole unload budget, and one bootstrap that settled the question.
    expect(naps).toHaveLength(19);
    expect(
      transport
        .commandLines()
        .filter((line) => line.startsWith('launchctl bootstrap')),
    ).toHaveLength(1);
  });

  it('fails when the label is not loaded after the kickstart', async () => {
    const transport = new FakeTransport('control').on('launchctl print', GONE);
    await expect(macInstall(transport)).rejects.toThrow(
      new RegExp(`did not load .*${PLIST}.*launchctl bootstrap gui/501`, 's'),
    );
  });

  it('reports a bootstrap launchd refuses for any other reason', async () => {
    const transport = macTransport().fail(
      'launchctl bootstrap',
      'Bootstrap failed: 5: Path had bad ownership/permissions',
    );
    await expect(macInstall(transport)).rejects.toThrow(
      /launchctl bootstrap com\.cestoliv\.grove\.daemon failed/,
    );
  });

  it('tolerates a bootout for a label that is not loaded', async () => {
    const transport = macTransport().fail(
      'launchctl bootout',
      'Boot-out failed: 3: No such process',
    );
    await expect(macInstall(transport)).resolves.toBeDefined();
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
