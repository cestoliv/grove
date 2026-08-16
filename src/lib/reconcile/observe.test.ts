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

  it('treats a host without docker as read only', async () => {
    const mac = new FakeTransport('mac')
      .on('uname', { stdout: 'Linux x86_64\n' })
      .on('sh -c printf', { stdout: '/home/ci' })
      .fail('docker ps', 'docker: command not found\n', 127);
    const observed = await observeFleet(config(), {
      transports: transports({ mac }),
      forgeClients: new Map([
        ['gh-overload', new FakeForgeClient('gh-overload')],
      ]),
    });

    expect(observed.hosts[0].reachable).toBe(false);
    expect(observed.hosts[0].reason).toMatch(/docker ps failed/);
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

  it('observes no forge for a group grove cannot manage yet', async () => {
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
