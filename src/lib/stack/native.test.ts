import { describe, expect, it } from 'vitest';
import type { GroupConfig, HostConfig } from '../config/index.js';
import type { ExecOptions, ExecResult } from '../transport/index.js';
import { FakeTransport } from '../transport/index.js';
import { NativeStack, readUid } from './native.js';
import { buildNativeRunnerSpec, buildNativeTarget } from './native-args.js';

function launchctlList(...pids: (number | '-')[]): string {
  return [
    'PID\tStatus\tLabel',
    ...pids.map((pid) => `${pid}\t0\tcom.cestoliv.grove.ios-1`),
    '',
  ].join('\n');
}

// A drain is a sequence of answers, not one answer, so `launchctl list` walks
// a queue and repeats its last entry once the queue runs down. That keeps a
// test's expectation independent of how many times the poll loop turns.
class PollingTransport extends FakeTransport {
  private readonly answers: string[];

  constructor(name: string, answers: string[]) {
    super(name);
    this.answers = answers;
  }

  override async exec(
    command: string,
    args: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const result = await super.exec(command, args, options);
    if (command !== 'launchctl' || args[0] !== 'list') {
      return result;
    }
    const stdout =
      this.answers.length > 1
        ? (this.answers.shift() as string)
        : (this.answers[0] ?? '');
    return { ...result, stdout };
  }
}

const host = { type: 'local', work_root: '/Volumes/ci/grove' } as HostConfig;

const group = {
  name: 'ios',
  forge: 'gh-overload',
  scope: { level: 'organization', target: 'Overload-coach' },
  placement: { mac: 1 },
  stack: 'native',
  labels: ['macos'],
} as GroupConfig;

const target = buildNativeTarget({ group, host, index: 1, home: '/Users/o' });

function spec(platform = 'Darwin') {
  return buildNativeRunnerSpec({
    group,
    host,
    index: 1,
    home: '/Users/o',
    registration: {
      token: 'SECRET-TOKEN',
      url: 'https://github.com/Overload-coach',
    },
    platform,
    hostArch: 'arm64',
    version: '2.328.0',
  });
}

function mac(transport: FakeTransport): NativeStack {
  return new NativeStack({
    transport,
    host: 'mac',
    platform: 'Darwin',
    uid: '501',
    pollIntervalMs: 1,
  });
}

function linux(transport: FakeTransport): NativeStack {
  return new NativeStack({
    transport,
    host: 'atlas',
    platform: 'Linux',
    uid: '1000',
    pollIntervalMs: 1,
  });
}

describe('readUid', () => {
  it('reads the uid the launchd domain is keyed on', async () => {
    const transport = new FakeTransport('mac').on('id -u', { stdout: '501\n' });
    expect(await readUid(transport)).toBe('501');
  });

  it('answers undefined rather than throwing when id fails', async () => {
    const transport = new FakeTransport('mac').fail('id -u', 'nope', 1);
    expect(await readUid(transport)).toBeUndefined();
  });
});

describe('NativeStack.listUnits', () => {
  it('asks launchctl once and keeps only grove seats', async () => {
    const transport = new FakeTransport('mac').on('launchctl list', {
      stdout:
        'PID\tStatus\tLabel\n4242\t0\tcom.cestoliv.grove.ios-1\n901\t0\tcom.apple.Finder\n',
    });
    expect(await mac(transport).listUnits()).toEqual([
      {
        name: 'grove-ios-1',
        unit: 'com.cestoliv.grove.ios-1',
        state: 'running',
        pid: 4242,
        detail: 'pid 4242',
      },
    ]);
    expect(transport.commandLines()).toEqual(['launchctl list']);
  });

  it('asks systemctl once, with the runtime dir SSH does not set', async () => {
    const transport = new FakeTransport('atlas').on('systemctl --user', {
      stdout: 'grove-ios-1.service loaded active running grove runner\n',
    });
    expect(await linux(transport).listUnits()).toEqual([
      {
        name: 'grove-ios-1',
        unit: 'grove-ios-1.service',
        state: 'running',
        detail: 'active running',
      },
    ]);
    expect(transport.commandLines()).toEqual([
      'systemctl --user list-units --type=service --all --no-legend --plain grove-*.service',
    ]);
    expect(transport.calls[0].options?.env).toEqual({
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
  });

  it('names loginctl enable-linger when the user bus is missing', async () => {
    const transport = new FakeTransport('atlas').fail(
      'systemctl --user',
      'Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS not defined\n',
      1,
    );
    await expect(linux(transport).listUnits()).rejects.toThrow(
      /loginctl enable-linger/,
    );
  });
});

describe('NativeStack without a uid', () => {
  it('refuses to speak launchctl without a uid', async () => {
    const stack = new NativeStack({
      transport: new FakeTransport('mac'),
      host: 'mac',
      platform: 'Darwin',
    });
    await expect(stack.start(target)).rejects.toThrow(/uid/);
  });
});

describe('NativeStack.prepareDirs', () => {
  it('creates the three directories and locks the install dir down', async () => {
    const transport = new FakeTransport('mac');
    await mac(transport).prepareDirs(target, {
      wipeWork: true,
      wipeInstall: true,
    });
    const [call] = transport.calls;
    expect(call.command).toBe('sh');
    expect(call.args[1]).toBe(
      [
        "rm -rf '/Volumes/ci/grove/ios-1'",
        "rm -rf '/Volumes/ci/grove/ios-1-runner'",
        "mkdir -p '/Volumes/ci/grove/ios-1' '/Volumes/ci/grove-cache/ios-1' '/Volumes/ci/grove/ios-1-runner'",
        "chmod 0700 '/Volumes/ci/grove/ios-1-runner'",
        "touch '/Volumes/ci/grove/ios-1-runner/stdout.log' '/Volumes/ci/grove/ios-1-runner/stderr.log'",
      ].join(' && '),
    );
  });

  it('keeps the install dir when only the work dir is wiped', async () => {
    const transport = new FakeTransport('mac');
    await mac(transport).prepareDirs(target, {
      wipeWork: true,
      wipeInstall: false,
    });
    expect(transport.calls[0].args[1]).not.toContain(
      "rm -rf '/Volumes/ci/grove/ios-1-runner'",
    );
  });

  it('creates no log files on Linux, where the journal holds the output', async () => {
    const transport = new FakeTransport('atlas');
    await linux(transport).prepareDirs(target, {
      wipeWork: false,
      wipeInstall: false,
    });
    expect(transport.calls[0].args[1]).not.toContain('touch');
  });

  it('refuses to wipe a path that is not this seat', async () => {
    const transport = new FakeTransport('mac');
    await expect(
      mac(transport).prepareDirs(
        { ...target, installDir: '/Volumes/ci' },
        { wipeWork: false, wipeInstall: true },
      ),
    ).rejects.toThrow('refusing to wipe /Volumes/ci');
    expect(transport.calls).toEqual([]);
  });

  it('turns a failing shell into a stack error naming the host', async () => {
    const transport = new FakeTransport('mac').fail(
      'sh -c',
      'mkdir: Read-only file system\n',
      1,
    );
    await expect(
      mac(transport).prepareDirs(target, {
        wipeWork: false,
        wipeInstall: false,
      }),
    ).rejects.toThrow('mac: cannot prepare /Volumes/ci/grove/ios-1-runner');
  });
});

describe('NativeStack.install', () => {
  it('downloads, unpacks, tidies up, then configures from the install dir', async () => {
    const transport = new FakeTransport('mac');
    await mac(transport).install(spec());
    expect(transport.commandLines()).toEqual([
      'curl -fsSL -o /Volumes/ci/grove/ios-1-runner/actions-runner.tar.gz https://github.com/actions/runner/releases/download/v2.328.0/actions-runner-osx-arm64-2.328.0.tar.gz',
      'tar xzf /Volumes/ci/grove/ios-1-runner/actions-runner.tar.gz -C /Volumes/ci/grove/ios-1-runner',
      'rm -f /Volumes/ci/grove/ios-1-runner/actions-runner.tar.gz',
      '/Volumes/ci/grove/ios-1-runner/config.sh --url https://github.com/Overload-coach --token SECRET-TOKEN --name grove-ios-1 --work /Volumes/ci/grove/ios-1 --unattended --replace --disableupdate --labels macos',
    ]);
    expect(transport.calls[3].options?.cwd).toBe(
      '/Volumes/ci/grove/ios-1-runner',
    );
  });

  it('names the seat and never the token when config.sh fails', async () => {
    const transport = new FakeTransport('mac').fail(
      '/Volumes/ci/grove/ios-1-runner/config.sh',
      'Http response code: NotFound\n',
      1,
    );
    const error = await mac(transport)
      .install(spec())
      .then(() => undefined)
      .catch((thrown: Error) => thrown);
    expect(error?.message).toBe(
      'mac: config.sh for grove-ios-1 failed: Http response code: NotFound',
    );
    expect(error?.message).not.toContain('SECRET-TOKEN');
  });
});

describe('NativeStack.create', () => {
  it('writes the plist, clears any stale job, loads it and starts it', async () => {
    const transport = new FakeTransport('mac');
    await mac(transport).create(spec());
    expect(transport.commandLines()).toEqual([
      'mkdir -p /Users/o/Library/LaunchAgents',
      'launchctl bootout gui/501/com.cestoliv.grove.ios-1',
      'launchctl bootstrap gui/501 /Users/o/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
      'launchctl kickstart gui/501/com.cestoliv.grove.ios-1',
    ]);
    expect(
      transport.writes.get(
        '/Users/o/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
      ),
    ).toContain('<key>Label</key>');
  });

  it('tolerates a label the bootout before it has not finished unloading', async () => {
    // bootout returns before launchd has let go of a job whose process is
    // still exiting, and the bootstrap that follows fails with I/O error.
    const transport = new FakeTransport('mac').fail(
      'launchctl bootstrap',
      'Bootstrap failed: 5: Input/output error\n',
      5,
    );
    await mac(transport).create(spec());
    expect(transport.commandLines()).toContain(
      'launchctl kickstart gui/501/com.cestoliv.grove.ios-1',
    );
  });

  it('writes the unit, reloads systemd and enables it now', async () => {
    const transport = new FakeTransport('atlas');
    await linux(transport).create(spec('Linux'));
    expect(transport.commandLines()).toEqual([
      'mkdir -p /Users/o/.config/systemd/user',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now grove-ios-1.service',
    ]);
    expect(
      transport.writes.get('/Users/o/.config/systemd/user/grove-ios-1.service'),
    ).toContain('ExecStart="/Volumes/ci/grove/ios-1-runner/bin/runsvc.sh"');
  });
});

describe('NativeStack.start', () => {
  it('tolerates a label launchd already holds and kicks it anyway', async () => {
    const transport = new FakeTransport('mac').fail(
      'launchctl bootstrap',
      'Bootstrap failed: 5: Input/output error\n',
      5,
    );
    await mac(transport).start(target);
    expect(transport.commandLines()).toEqual([
      'launchctl bootstrap gui/501 /Users/o/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
      'launchctl kickstart -k gui/501/com.cestoliv.grove.ios-1',
    ]);
  });

  it('starts the unit on Linux', async () => {
    const transport = new FakeTransport('atlas');
    await linux(transport).start(target);
    expect(transport.commandLines()).toEqual([
      'systemctl --user start grove-ios-1.service',
    ]);
  });
});

describe('NativeStack.stop', () => {
  it('boots the job out and stops once launchd no longer lists it', async () => {
    const transport = new FakeTransport('mac').on('launchctl list', {
      stdout: 'PID\tStatus\tLabel\n',
    });
    await mac(transport).stop(target, 50);
    expect(transport.commandLines()).toEqual([
      'launchctl bootout gui/501/com.cestoliv.grove.ios-1',
      'launchctl list',
    ]);
  });

  it('stops when launchd holds the label with no process behind it', async () => {
    const transport = new FakeTransport('mac').on('launchctl list', {
      stdout: launchctlList('-'),
    });
    await mac(transport).stop(target, 50);
    expect(transport.commandLines()).toEqual([
      'launchctl bootout gui/501/com.cestoliv.grove.ios-1',
      'launchctl list',
    ]);
  });

  it('waits for the job to go and kills nothing itself', async () => {
    const transport = new PollingTransport('mac', [
      launchctlList(4242),
      launchctlList(4242),
      launchctlList(),
    ]);
    await mac(transport).stop(target, 50);
    expect(transport.commandLines()).not.toContain('kill -9 4242');
    expect(
      transport.commandLines().filter((line) => line === 'launchctl list')
        .length,
    ).toBe(3);
  });

  it('fails rather than reporting a drain when the job never goes', async () => {
    const transport = new FakeTransport('mac').on('launchctl list', {
      stdout: launchctlList(4242),
    });
    const stack = new NativeStack({
      transport,
      host: 'mac',
      platform: 'Darwin',
      uid: '501',
      pollIntervalMs: 1,
      stopGraceMs: 5,
    });
    await expect(stack.stop(target, 20)).rejects.toThrow(
      /^mac: seat "grove-ios-1" is still stopping after \d+s; launchd escalates to SIGKILL at ExitTimeOut$/,
    );
    expect(
      transport.commandLines().some((line) => line.startsWith('kill')),
    ).toBe(false);
  });

  it('polls briefly rather than waiting when the drain is zero', async () => {
    const transport = new PollingTransport('mac', [
      launchctlList(4242),
      launchctlList(),
    ]);
    await mac(transport).stop(target, 0);
    expect(transport.commandLines()).toEqual([
      'launchctl bootout gui/501/com.cestoliv.grove.ios-1',
      'launchctl list',
      'launchctl list',
    ]);
  });

  it('tolerates a job launchd has already let go', async () => {
    const transport = new FakeTransport('mac')
      .on('launchctl list', { stdout: 'PID\tStatus\tLabel\n' })
      .fail('launchctl bootout', 'Boot-out failed: 3: No such process\n', 3);
    await expect(mac(transport).stop(target, 20)).resolves.toBeUndefined();
  });

  it('lets systemd run the drain it was given in the unit', async () => {
    const transport = new FakeTransport('atlas');
    await linux(transport).stop(target, 120_000);
    expect(transport.commandLines()).toEqual([
      'systemctl --user stop grove-ios-1.service',
    ]);
  });

  it('kills the unit first when the drain is zero', async () => {
    const transport = new FakeTransport('atlas');
    await linux(transport).stop(target, 0);
    expect(transport.commandLines()).toEqual([
      'systemctl --user kill --signal=SIGKILL grove-ios-1.service',
      'systemctl --user stop grove-ios-1.service',
    ]);
  });

  it('tolerates a unit systemd does not have', async () => {
    const transport = new FakeTransport('atlas').fail(
      'systemctl --user stop',
      'Failed to stop grove-ios-1.service: Unit grove-ios-1.service not loaded.\n',
      5,
    );
    await expect(linux(transport).stop(target, 100)).resolves.toBeUndefined();
  });

  it('surfaces a failure that merely mentions something not found', async () => {
    const transport = new FakeTransport('atlas').fail(
      'systemctl --user stop',
      'sh: 1: systemctl: not found\n',
      127,
    );
    await expect(linux(transport).stop(target, 100)).rejects.toThrow(
      'atlas: systemctl --user stop grove-ios-1.service failed: sh: 1: systemctl: not found',
    );
  });
});

describe('NativeStack.remove', () => {
  it('unloads the job, deletes the plist and deletes the install dir', async () => {
    const transport = new FakeTransport('mac');
    await mac(transport).remove(target);
    expect(transport.commandLines()).toEqual([
      'launchctl bootout gui/501/com.cestoliv.grove.ios-1',
      'rm -f /Users/o/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
      'rm -rf /Volumes/ci/grove/ios-1-runner',
    ]);
  });

  it('disables the unit, deletes it, reloads, then deletes the install dir', async () => {
    const transport = new FakeTransport('atlas');
    await linux(transport).remove(target);
    expect(transport.commandLines()).toEqual([
      'systemctl --user disable --now grove-ios-1.service',
      'rm -f /Users/o/.config/systemd/user/grove-ios-1.service',
      'systemctl --user daemon-reload',
      'rm -rf /Volumes/ci/grove/ios-1-runner',
    ]);
  });

  it('leaves the work dir alone, because caches survive a removal', async () => {
    const transport = new FakeTransport('mac');
    await mac(transport).remove(target);
    expect(transport.commandLines()).not.toContain(
      'rm -rf /Volumes/ci/grove/ios-1',
    );
  });
});

describe('NativeStack.logs', () => {
  it('tails both redirected streams on macOS', async () => {
    const chunks: string[] = [];
    const transport = new FakeTransport('mac').on('tail', {
      stdout: 'job started\n',
    });
    const code = await mac(transport).logs(target, {
      tail: 200,
      follow: true,
      onChunk: (chunk) => chunks.push(chunk),
    });
    expect(code).toBe(0);
    expect(chunks).toEqual(['job started\n']);
    expect(transport.commandLines()).toEqual([
      'tail -n 200 -f /Volumes/ci/grove/ios-1-runner/stdout.log /Volumes/ci/grove/ios-1-runner/stderr.log',
    ]);
  });

  it('reads the user journal on Linux', async () => {
    const transport = new FakeTransport('atlas').on('journalctl', {
      stdout: 'job started\n',
    });
    await linux(transport).logs(target, { tail: 50, onChunk: () => undefined });
    expect(transport.commandLines()).toEqual([
      'journalctl --user -u grove-ios-1.service -n 50 --no-pager',
    ]);
    expect(transport.calls[0].options?.env).toEqual({
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
  });

  it('points at the runner diagnostics when there is no journalctl', async () => {
    const transport = new FakeTransport('atlas').fail(
      'journalctl',
      'sh: journalctl: not found\n',
      127,
    );
    await expect(
      linux(transport).logs(target, { onChunk: () => undefined }),
    ).rejects.toThrow('/Volumes/ci/grove/ios-1-runner/_diag');
  });
});
