import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { FakeForgeClient } from '../forge/index.js';
import { FakeTransport, type Transport } from '../transport/index.js';
import { observeFleet } from './observe.js';

const SCOPE = { level: 'organization', target: 'Overload-coach' } as const;

const PS_LINE = JSON.stringify({
  ID: 'abc',
  Names: 'grove-overload-arm-1',
  State: 'running',
  Image: 'ghcr.io/actions/actions-runner:latest',
  Status: 'Up 2 hours',
  CreatedAt: 'now',
});

function config(overrides: Partial<GroveConfig> = {}): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { mac: { type: 'local', work_root: '/Volumes/ci/grove' } },
    forges: { 'gh-overload': { kind: 'github' } },
    groups: [
      {
        name: 'overload-arm',
        forge: 'gh-overload',
        scope: SCOPE,
        placement: { mac: 1 },
        stack: 'docker',
      },
    ],
    ...overrides,
  } as GroveConfig;
}

function healthyMac(): FakeTransport {
  return new FakeTransport('mac')
    .on('uname', { stdout: 'Darwin arm64\n' })
    .on('sh -c printf', { stdout: '/Users/olivier' })
    .on('docker ps', { stdout: `${PS_LINE}\n` })
    .on('stat -f %d /Volumes/ci', { stdout: '17\n' })
    .on('stat -f %d /', { stdout: '16\n' });
}

function healthyLinux(): FakeTransport {
  return new FakeTransport('linux')
    .on('uname', { stdout: 'Linux x86_64\n' })
    .on('sh -c printf', { stdout: '/home/ci' })
    .on('docker ps', { stdout: '' });
}

function transports(map: Record<string, Transport>): Map<string, Transport> {
  return new Map(Object.entries(map));
}

describe('observeFleet', () => {
  it('reports containers, home, platform and a healthy work root', async () => {
    const observed = await observeFleet(config(), {
      transports: transports({ mac: healthyMac() }),
      forgeClients: new Map([
        [
          'gh-overload',
          new FakeForgeClient('gh-overload').addRunner({
            name: 'grove-overload-arm-1',
            id: '11',
          }),
        ],
      ]),
    });

    expect(observed.hosts).toHaveLength(1);
    expect(observed.hosts[0]).toMatchObject({
      host: 'mac',
      reachable: true,
      platform: 'Darwin',
      arch: 'arm64',
      home: '/Users/olivier',
    });
    expect(observed.hosts[0].containers.map((entry) => entry.name)).toEqual([
      'grove-overload-arm-1',
    ]);
    expect(observed.hosts[0].workRoots['overload-arm']).toEqual({
      guarded: true,
      ok: true,
      mountPoint: '/Volumes/ci',
    });
    expect(observed.forges[0]).toMatchObject({
      forge: 'gh-overload',
      reachable: true,
    });
    expect(observed.forges[0].runners[0]).toEqual({
      scope: SCOPE,
      runner: {
        id: '11',
        name: 'grove-overload-arm-1',
        status: 'online',
        busy: false,
        labels: [],
      },
    });
  });

  it('marks a host unreachable and asks it nothing else', async () => {
    const mac = new FakeTransport('mac').fail(
      'uname',
      'ssh: connect to host mac port 22: No route to host\n',
    );
    const observed = await observeFleet(config(), {
      transports: transports({ mac }),
      forgeClients: new Map([
        ['gh-overload', new FakeForgeClient('gh-overload')],
      ]),
    });

    expect(observed.hosts[0]).toMatchObject({
      host: 'mac',
      reachable: false,
      reason: 'ssh: connect to host mac port 22: No route to host',
      containers: [],
    });
    expect(mac.commandLines()).toEqual(['uname -sm']);
  });

  it('keeps a host without docker reachable and degrades that stack alone', async () => {
    const mac = new FakeTransport('mac')
      .on('uname', { stdout: 'Linux x86_64\n' })
      .on('sh -c printf', { stdout: '/home/ci' })
      .on('id -u', { stdout: '1000\n' })
      .fail('docker ps', 'docker: command not found\n', 127);
    const observed = await observeFleet(config(), {
      transports: transports({ mac }),
      forgeClients: new Map([
        ['gh-overload', new FakeForgeClient('gh-overload')],
      ]),
    });

    expect(observed.hosts[0].reachable).toBe(true);
    expect(observed.hosts[0].containers).toEqual([]);
    expect(observed.hosts[0].containersError).toMatch(/docker ps failed/);
    expect(observed.hosts[0].nativesError).toBeUndefined();
  });

  it('records a failed volume guard without failing the host', async () => {
    // Built from scratch rather than by overriding healthyMac, because
    // FakeTransport answers with the first script entry that matches.
    const mac = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('docker ps', { stdout: `${PS_LINE}\n` })
      .on('stat -f %d /Volumes/ci', { stdout: '16\n' })
      .on('stat -f %d /', { stdout: '16\n' });
    const observed = await observeFleet(config(), {
      transports: transports({ mac }),
      forgeClients: new Map([
        ['gh-overload', new FakeForgeClient('gh-overload')],
      ]),
    });

    expect(observed.hosts[0].reachable).toBe(true);
    expect(observed.hosts[0].workRoots['overload-arm'].ok).toBe(false);
  });

  it('keeps no $HOME that is not an absolute path', async () => {
    const transport = new FakeTransport('mac')
      .on('sh -c printf', { stdout: 'Users/o' })
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('docker ps', { stdout: '' });
    const observed = await observeFleet(config(), {
      transports: transports({ mac: transport }),
      forgeClients: new Map([
        ['gh-overload', new FakeForgeClient('gh-overload')],
      ]),
    });
    expect(observed.hosts[0].reachable).toBe(true);
    expect(observed.hosts[0].home).toBeUndefined();
  });

  it('marks one host unreachable on a home-read failure without touching another', async () => {
    const brokenHome = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .throwOn('sh -c printf', 'ssh: broken pipe');
    const observed = await observeFleet(
      config({
        hosts: {
          mac: { type: 'local', work_root: '/Volumes/ci/grove' },
          linux: { type: 'local', work_root: '/mnt/ci/grove' },
        },
      }),
      {
        transports: transports({ mac: brokenHome, linux: healthyLinux() }),
        forgeClients: new Map([
          ['gh-overload', new FakeForgeClient('gh-overload')],
        ]),
      },
    );

    const mac = observed.hosts.find((entry) => entry.host === 'mac');
    const linux = observed.hosts.find((entry) => entry.host === 'linux');
    expect(mac).toMatchObject({
      reachable: false,
      reason: 'ssh: broken pipe',
      containers: [],
      workRoots: {},
    });
    expect(linux?.reachable).toBe(true);
  });

  it('marks one host unreachable on a volume-guard stat failure without touching another', async () => {
    const brokenStat = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('docker ps', { stdout: `${PS_LINE}\n` })
      .throwOn('stat -f %d /Volumes/ci', 'stat: connection reset');
    const observed = await observeFleet(
      config({
        hosts: {
          mac: { type: 'local', work_root: '/Volumes/ci/grove' },
          linux: { type: 'local', work_root: '/mnt/ci/grove' },
        },
      }),
      {
        transports: transports({ mac: brokenStat, linux: healthyLinux() }),
        forgeClients: new Map([
          ['gh-overload', new FakeForgeClient('gh-overload')],
        ]),
      },
    );

    const mac = observed.hosts.find((entry) => entry.host === 'mac');
    const linux = observed.hosts.find((entry) => entry.host === 'linux');
    expect(mac).toMatchObject({
      reachable: false,
      reason: 'stat: connection reset',
      containers: [],
      workRoots: {},
    });
    expect(linux?.reachable).toBe(true);
  });

  it('marks a forge unreachable when the API fails', async () => {
    const client = new FakeForgeClient('gh-overload').failOn(
      'listRunners',
      'API rate limit exceeded',
    );
    const observed = await observeFleet(config(), {
      transports: transports({ mac: healthyMac() }),
      forgeClients: new Map([['gh-overload', client]]),
    });

    expect(observed.forges[0]).toMatchObject({
      forge: 'gh-overload',
      reachable: false,
      reason: 'API rate limit exceeded',
      runners: [],
    });
  });

  it('lists each scope once and merges the results', async () => {
    const desired = config({
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'docker',
        },
        {
          name: 'api',
          forge: 'gh-overload',
          scope: { level: 'repository', target: 'Overload-coach/api' },
          placement: { mac: 1 },
          stack: 'docker',
        },
        {
          name: 'more-arm',
          forge: 'gh-overload',
          scope: SCOPE,
          placement: { mac: 1 },
          stack: 'docker',
        },
      ],
    } as Partial<GroveConfig>);
    const client = new FakeForgeClient('gh-overload').addRunner({
      name: 'grove-overload-arm-1',
      id: '11',
    });
    const observed = await observeFleet(desired, {
      transports: transports({ mac: healthyMac() }),
      forgeClients: new Map([['gh-overload', client]]),
    });

    expect(client.scopesListed).toHaveLength(2);
    expect(observed.forges[0].runners).toHaveLength(1);
  });

  it('observes no forge for a group whose client was never built', async () => {
    const desired = config({
      forges: { 'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' } },
      groups: [
        {
          name: 'chevro-dind',
          forge: 'gl-chevro',
          scope: { level: 'instance' },
          placement: { mac: 1 },
          stack: 'docker',
        },
      ],
    } as Partial<GroveConfig>);
    const observed = await observeFleet(desired, {
      transports: transports({ mac: healthyMac() }),
      forgeClients: new Map(),
    });

    expect(observed.forges).toEqual([]);
    expect(observed.hosts[0].workRoots).toEqual({});
  });
});

describe('observeFleet, a GitLab group', () => {
  const gitlabConfig = {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: {
      atlas: { type: 'ssh', host: 'atlas', work_root: '/PROD/local/grove' },
    },
    forges: { 'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' } },
    groups: [
      {
        name: 'chevro-dind',
        forge: 'gl-chevro',
        scope: { level: 'instance' },
        placement: { atlas: 2 },
        stack: 'docker',
        tags: ['docker'],
      },
    ],
  } as GroveConfig;

  function atlasTransport(): FakeTransport {
    return new FakeTransport('atlas')
      .on('uname', { stdout: 'Linux x86_64\n' })
      .on('sh -c printf %s "$HOME"', { stdout: '/root' })
      .on('docker ps', {
        stdout: `${JSON.stringify({
          ID: 'a1',
          Names: 'grove-chevro-dind-1',
          State: 'running',
          Image: 'gitlab/gitlab-runner:latest',
          Status: 'Up 2 hours',
          CreatedAt: 'now',
        })}\n`,
      })
      .on('sh -c set --', {
        stdout: 'grove-chevro-dind-1\ts_aaaaaaaaaaaa\n',
      });
  }

  it('observes the host and the forge instead of skipping the group', async () => {
    const client = new FakeForgeClient('gl-chevro', {
      kind: 'gitlab',
      sharedRegistration: true,
    });
    const observed = await observeFleet(gitlabConfig, {
      transports: new Map([['atlas', atlasTransport()]]),
      forgeClients: new Map([['gl-chevro', client]]),
    });

    expect(observed.forges.map((forge) => forge.forge)).toEqual(['gl-chevro']);
    expect(observed.forges[0].shared).toBe(true);
    expect(client.scopesListed).toEqual([{ level: 'instance' }]);
  });

  it('reads a system id for every GitLab container it saw', async () => {
    const transport = atlasTransport();
    const observed = await observeFleet(gitlabConfig, {
      transports: new Map([['atlas', transport]]),
      forgeClients: new Map([
        [
          'gl-chevro',
          new FakeForgeClient('gl-chevro', {
            kind: 'gitlab',
            sharedRegistration: true,
          }),
        ],
      ]),
    });

    expect(observed.hosts[0].systemIds).toEqual({
      'grove-chevro-dind-1': 's_aaaaaaaaaaaa',
    });
    const asked = transport.calls.find((call) =>
      call.args.some((arg) => arg.includes('.runner_system_id')),
    );
    expect(asked?.args[1]).toContain(
      "'/PROD/local/grove/chevro-dind-1-config/.runner_system_id'",
    );
  });

  it('asks no host for a system id when every group is a GitHub group', async () => {
    const transport = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf %s "$HOME"', { stdout: '/Users/olivier' })
      .on('docker ps', { stdout: '' });
    const githubConfig = {
      ...gitlabConfig,
      hosts: { mac: { type: 'local' } },
      forges: { 'gh-overload': { kind: 'github' } },
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: { level: 'organization', target: 'Overload-coach' },
          placement: { mac: 1 },
          stack: 'docker',
        },
      ],
    } as GroveConfig;

    const observed = await observeFleet(githubConfig, {
      transports: new Map([['mac', transport]]),
      forgeClients: new Map([
        ['gh-overload', new FakeForgeClient('gh-overload')],
      ]),
    });

    expect(observed.hosts[0].systemIds).toBeUndefined();
    expect(observed.forges[0].shared).toBe(false);
    expect(
      transport.calls.some((call) =>
        call.args.some((arg) => arg.includes('.runner_system_id')),
      ),
    ).toBe(false);
  });
});

describe('observeFleet, native seats', () => {
  function nativeConfig(): GroveConfig {
    return {
      tick: { fast: 120_000, full: 1_800_000 },
      hosts: { mac: { type: 'local', work_root: '/Volumes/ci/grove' } },
      forges: { 'gh-overload': { kind: 'github' } },
      groups: [
        {
          name: 'ios',
          forge: 'gh-overload',
          scope: { level: 'organization', target: 'Overload-coach' },
          placement: { mac: 1 },
          stack: 'native',
          labels: ['macos'],
        },
      ],
    } as unknown as GroveConfig;
  }

  function clients() {
    return new Map([['gh-overload', new FakeForgeClient('gh-overload')]]);
  }

  it('reads the uid and lists what launchd loaded', async () => {
    const mac = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('id -u', { stdout: '501\n' })
      .on('docker ps', { stdout: '' })
      .on('stat', { stdout: '17\n' })
      .on('launchctl list', {
        stdout: 'PID\tStatus\tLabel\n4242\t0\tcom.cestoliv.grove.ios-1\n',
      });

    const observed = await observeFleet(nativeConfig(), {
      transports: transports({ mac }),
      forgeClients: clients(),
    });

    expect(observed.hosts[0].uid).toBe('501');
    expect(observed.hosts[0].natives).toEqual([
      {
        name: 'grove-ios-1',
        unit: 'com.cestoliv.grove.ios-1',
        state: 'running',
        pid: 4242,
        detail: 'pid 4242',
      },
    ]);
    expect(observed.hosts[0].nativesError).toBeUndefined();
  });

  it('guards the work root of a native group, as it does a Docker one', async () => {
    const mac = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('id -u', { stdout: '501\n' })
      .on('docker ps', { stdout: '' })
      .on('launchctl list', { stdout: 'PID\tStatus\tLabel\n' })
      .fail('stat', 'stat: /Volumes/ci: No such file or directory\n', 1);

    const observed = await observeFleet(
      {
        ...nativeConfig(),
        hosts: { mac: { type: 'local', work_root: '/Volumes/ci/grove' } },
      } as GroveConfig,
      { transports: transports({ mac }), forgeClients: clients() },
    );

    expect(observed.hosts[0].workRoots.ios.ok).toBe(false);
  });

  it('degrades the native stack alone when the user bus is missing', async () => {
    const atlas = new FakeTransport('atlas')
      .on('uname', { stdout: 'Linux x86_64\n' })
      .on('sh -c printf', { stdout: '/home/ci' })
      .on('id -u', { stdout: '1000\n' })
      .on('docker ps', { stdout: '' })
      .fail(
        'systemctl --user',
        'Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS not defined\n',
        1,
      );

    const observed = await observeFleet(
      {
        ...nativeConfig(),
        hosts: { atlas: { type: 'ssh', host: 'atlas' } },
        groups: [
          {
            name: 'ios',
            forge: 'gh-overload',
            scope: { level: 'organization', target: 'Overload-coach' },
            placement: { atlas: 1 },
            stack: 'native',
          },
        ],
      } as unknown as GroveConfig,
      { transports: transports({ atlas }), forgeClients: clients() },
    );

    expect(observed.hosts[0].reachable).toBe(true);
    expect(observed.hosts[0].natives).toBeUndefined();
    expect(observed.hosts[0].nativesError).toMatch(/loginctl enable-linger/);
  });

  it('asks the supervisor even on a host with no native group', async () => {
    const mac = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('id -u', { stdout: '501\n' })
      .on('docker ps', { stdout: '' })
      .on('launchctl list', {
        stdout: 'PID\tStatus\tLabel\n-\t0\tcom.cestoliv.grove.legacy-1\n',
      });

    const observed = await observeFleet(config(), {
      transports: transports({ mac }),
      forgeClients: new Map([
        ['gh-overload', new FakeForgeClient('gh-overload')],
      ]),
    });

    // Discovery is what makes the unmanaged cell of the ownership table real,
    // and a seat whose group left the config still has to be seen.
    expect(observed.hosts[0].natives).toEqual([
      {
        name: 'grove-legacy-1',
        unit: 'com.cestoliv.grove.legacy-1',
        state: 'stopped',
        detail: 'last exit 0',
      },
    ]);
  });
});

describe('observeFleet with skipForges', () => {
  it('calls no forge and reports none', async () => {
    const client = new FakeForgeClient('gh-overload');
    const observed = await observeFleet(config(), {
      transports: transports({ mac: healthyMac() }),
      forgeClients: new Map([['gh-overload', client]]),
      skipForges: true,
    });

    expect(observed.forges).toEqual([]);
    expect(client.scopesListed).toEqual([]);
    expect(observed.hosts[0].reachable).toBe(true);
  });

  it('still runs the absent-disk guard, because a start needs it', async () => {
    const observed = await observeFleet(config(), {
      transports: transports({ mac: healthyMac() }),
      // No client at all, which is what the fast tick would look like if the
      // flag also emptied the group list.
      forgeClients: new Map(),
      skipForges: true,
    });

    expect(Object.keys(observed.hosts[0].workRoots)).toEqual(['overload-arm']);
  });

  it('leaves the milestone 4 behaviour alone when the flag is absent', async () => {
    const observed = await observeFleet(config(), {
      transports: transports({ mac: healthyMac() }),
      forgeClients: new Map(),
    });

    expect(observed.forges).toEqual([]);
    // No client means no manageable group, which is what `grove logs` relies on.
    expect(Object.keys(observed.hosts[0].workRoots)).toEqual([]);
  });
});
