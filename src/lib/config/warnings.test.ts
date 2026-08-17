import { describe, expect, it } from 'vitest';
import type { GroupConfig, GroveConfig } from './schema.js';
import {
  archWarnings,
  nativeOptionWarnings,
  privilegedSocketWarnings,
} from './warnings.js';

function buildConfig(...groups: Partial<GroupConfig>[]): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { mac: { type: 'local' }, atlas: { type: 'ssh', host: 'atlas' } },
    forges: {
      gh: { kind: 'github' },
      gl: { kind: 'gitlab', url: 'https://git.chevro.fr' },
    },
    groups: groups.map(
      (group, index) =>
        ({
          name: `group-${index}`,
          forge: 'gh',
          scope: { level: 'organization', target: 'Overload-coach' },
          placement: { mac: 1 },
          stack: 'docker',
          ...group,
        }) as GroupConfig,
    ),
  };
}

describe('privilegedSocketWarnings', () => {
  it('warns when a privileged group mounts the host docker socket', () => {
    const warnings = privilegedSocketWarnings(
      buildConfig({
        name: 'chevro-dind',
        privileged: true,
        volumes: ['/cache', '/var/run/docker.sock:/var/run/docker.sock'],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('privileged-docker-socket');
    expect(warnings[0].path).toBe('groups[0]');
    expect(warnings[0].message).toBe(
      'group "chevro-dind" runs privileged and mounts /var/run/docker.sock. Any job on that runner can take root on the host. grove proceeds anyway.',
    );
  });

  it('stays quiet when the group is privileged but mounts no socket', () => {
    expect(
      privilegedSocketWarnings(
        buildConfig({ privileged: true, volumes: ['/cache'] }),
      ),
    ).toEqual([]);
  });

  it('stays quiet when the socket is mounted without privileged', () => {
    expect(
      privilegedSocketWarnings(
        buildConfig({
          volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
        }),
      ),
    ).toEqual([]);
  });

  it('matches a read-only socket mount too', () => {
    const warnings = privilegedSocketWarnings(
      buildConfig({
        privileged: true,
        volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro'],
      }),
    );
    expect(warnings).toHaveLength(1);
  });

  it('warns for a privileged gitlab group that lists no socket', () => {
    const warnings = privilegedSocketWarnings(
      buildConfig({
        name: 'chevro-dind',
        forge: 'gl',
        scope: { level: 'instance' },
        privileged: true,
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('privileged-docker-socket');
    expect(warnings[0].path).toBe('groups[0]');
    expect(warnings[0].message).toBe(
      'group "chevro-dind" runs privileged job containers, and grove mounts /var/run/docker.sock into the runner. Any job on that runner can take root on the host. grove proceeds anyway.',
    );
  });

  it('warns once for a privileged gitlab group that also lists the socket', () => {
    const warnings = privilegedSocketWarnings(
      buildConfig({
        name: 'chevro-dind',
        forge: 'gl',
        scope: { level: 'instance' },
        privileged: true,
        volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('grove mounts');
  });

  it('stays quiet for a gitlab group that is not privileged', () => {
    expect(
      privilegedSocketWarnings(
        buildConfig({ forge: 'gl', scope: { level: 'instance' } }),
      ),
    ).toEqual([]);
  });

  it('warns once per offending group', () => {
    const warnings = privilegedSocketWarnings(
      buildConfig(
        {
          privileged: true,
          volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
        },
        { privileged: true, volumes: ['/cache'] },
        {
          privileged: true,
          volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
        },
      ),
    );
    expect(warnings.map((warning) => warning.path)).toEqual([
      'groups[0]',
      'groups[2]',
    ]);
  });
});

describe('archWarnings', () => {
  it('warns when a group asks for an architecture the host does not report', () => {
    const warnings = archWarnings(
      buildConfig({
        name: 'chevro-dind',
        arch: 'amd64',
        placement: { mac: 3 },
      }),
      new Map([['mac', 'arm64']]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('arch-mismatch');
    expect(warnings[0].path).toBe('groups[0].arch');
    expect(warnings[0].message).toBe(
      'group "chevro-dind" asks for amd64 on host "mac", which reports arm64. Architecture is a request, so grove proceeds anyway.',
    );
  });

  it('stays quiet when the architectures agree', () => {
    expect(
      archWarnings(buildConfig({ arch: 'arm64' }), new Map([['mac', 'arm64']])),
    ).toEqual([]);
  });

  it('stays quiet when the group declares no architecture', () => {
    expect(archWarnings(buildConfig({}), new Map([['mac', 'arm64']]))).toEqual(
      [],
    );
  });

  it('stays quiet for a host whose architecture is unknown', () => {
    expect(archWarnings(buildConfig({ arch: 'amd64' }), new Map())).toEqual([]);
  });

  it('warns once per mismatched host in a map placement', () => {
    const warnings = archWarnings(
      buildConfig({ arch: 'arm64', placement: { mac: 1, atlas: 2 } }),
      new Map([
        ['mac', 'arm64'],
        ['atlas', 'amd64'],
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('host "atlas"');
  });
});

describe('nativeOptionWarnings', () => {
  function native(overrides: Record<string, unknown> = {}): GroveConfig {
    return {
      tick: { fast: 120_000, full: 1_800_000 },
      hosts: { mac: { type: 'local' } },
      forges: { 'gh-overload': { kind: 'github' } },
      groups: [
        {
          name: 'ios',
          forge: 'gh-overload',
          scope: { level: 'organization', target: 'Overload-coach' },
          placement: { mac: 1 },
          stack: 'native',
          ...overrides,
        },
      ],
    } as unknown as GroveConfig;
  }

  it('names every Docker-only key a native group set', () => {
    const warnings = nativeOptionWarnings(
      native({ image: 'ubuntu:24.04', privileged: true }),
    );
    expect(warnings.map((warning) => warning.path)).toEqual([
      'groups[0].image',
      'groups[0].privileged',
    ]);
    expect(warnings[0].code).toBe('native-unused-option');
    expect(warnings[0].message).toContain('runs on the host itself');
  });

  it('says nothing about a native group that sets none of them', () => {
    expect(
      nativeOptionWarnings(native({ labels: ['macos'], max_work_size: 1024 })),
    ).toEqual([]);
  });

  it('says nothing about a Docker group, whatever it sets', () => {
    const config = native({ image: 'ubuntu:24.04' });
    config.groups[0].stack = 'docker';
    expect(nativeOptionWarnings(config)).toEqual([]);
  });

  it('keeps the privileged warning to the stack that has containers', () => {
    const config = native({
      privileged: true,
      volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
    });
    expect(privilegedSocketWarnings(config)).toEqual([]);
  });
});
