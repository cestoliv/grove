import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { metricsPortsFor, runGroupChecks } from './group.js';
import type { HostFacts } from './host-context.js';

function facts(overrides: Partial<HostFacts> = {}): HostFacts {
  return {
    host: 'mac',
    reachable: true,
    platform: 'Darwin',
    arch: 'arm64',
    freeBytes: {},
    ...overrides,
  };
}

function configWith(groups: unknown[], forges?: unknown): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { mac: { type: 'local', work_root: '/Volumes/ci/grove' } },
    forges: forges ?? { gh: { kind: 'github' } },
    groups,
  } as unknown as GroveConfig;
}

const BASE = {
  forge: 'gh',
  scope: { level: 'organization', target: 'Acme' },
  placement: { mac: 1 },
};

function findings(config: GroveConfig, factsFor: HostFacts = facts()) {
  return runGroupChecks({
    config,
    facts: new Map([[factsFor.host, factsFor]]),
  });
}

function pick(
  reports: ReturnType<typeof runGroupChecks>,
  id: string,
  group: string,
) {
  return reports.find(
    (report) => report.id === id && report.target.name === group,
  );
}

describe('runGroupChecks', () => {
  it('warns about privileged with a host docker socket, and prints the fix', () => {
    const config = configWith([
      {
        ...BASE,
        name: 'dind',
        stack: 'docker',
        privileged: true,
        volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
      },
    ]);
    const report = pick(findings(config), 'group.privileged-socket', 'dind');
    expect(report?.status).toBe('warn');
    expect(report?.summary).toContain('root on the host');
    expect(report?.fix).toContain('drop the socket mount');
  });

  it('says nothing is wrong when privileged is not combined with the socket', () => {
    const config = configWith([
      { ...BASE, name: 'plain', stack: 'docker', privileged: true },
    ]);
    expect(
      pick(findings(config), 'group.privileged-socket', 'plain')?.status,
    ).toBe('ok');
  });

  it('warns on an architecture the host does not report', () => {
    const config = configWith([
      { ...BASE, name: 'amd', stack: 'docker', arch: 'amd64' },
    ]);
    const report = pick(findings(config), 'group.arch', 'amd');
    expect(report?.status).toBe('warn');
    expect(report?.fix).toContain('emulation');
  });

  it('skips the architecture check for a group that names none', () => {
    const config = configWith([{ ...BASE, name: 'any', stack: 'docker' }]);
    expect(pick(findings(config), 'group.arch', 'any')?.status).toBe('skip');
  });

  it('fails a native group on a GitLab forge', () => {
    const config = configWith(
      [
        {
          ...BASE,
          forge: 'gl',
          scope: { level: 'instance' },
          name: 'ios',
          stack: 'native',
        },
      ],
      { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
    );
    const report = pick(findings(config), 'group.native-forge', 'ios');
    expect(report?.status).toBe('fail');
    expect(report?.fix).toContain('stack: docker');
  });

  it('fails a native group on a platform with no supervisor', () => {
    const config = configWith([{ ...BASE, name: 'ios', stack: 'native' }]);
    const report = pick(
      findings(config, facts({ platform: 'FreeBSD' })),
      'group.native-platform',
      'ios',
    );
    expect(report?.status).toBe('fail');
  });

  it('skips the platform check when the host did not answer', () => {
    const config = configWith([{ ...BASE, name: 'ios', stack: 'native' }]);
    const report = pick(
      findings(config, facts({ reachable: false, platform: undefined })),
      'group.native-platform',
      'ios',
    );
    expect(report?.status).toBe('skip');
  });

  it('warns when max_work_size is larger than the disk that would hold it', () => {
    const config = configWith([
      { ...BASE, name: 'big', stack: 'docker', max_work_size: 500 * 1024 ** 3 },
    ]);
    const report = pick(
      findings(
        config,
        facts({ freeBytes: { '/Volumes/ci/grove': 40 * 1024 ** 3 } }),
      ),
      'group.max-work-size',
      'big',
    );
    expect(report?.status).toBe('warn');
    expect(report?.summary).toContain('500.0 GiB');
  });

  it('warns about an unused raw key', () => {
    const config = configWith([
      { ...BASE, name: 'typo', stack: 'docker', raw: { docker_args: ['--x'] } },
    ]);
    const report = pick(findings(config), 'group.raw', 'typo');
    expect(report?.status).toBe('warn');
    expect(report?.summary).toContain('docker_run_args');
    expect(report?.fix).toContain('passes raw through');
  });

  it('warns about a container option on a native group', () => {
    const config = configWith([
      { ...BASE, name: 'ios', stack: 'native', image: 'ghcr.io/x:1' },
    ]);
    expect(pick(findings(config), 'group.native-option', 'ios')?.status).toBe(
      'warn',
    );
  });

  it('warns when a metrics port is declared and the exporter is off', () => {
    const config = configWith(
      [
        {
          ...BASE,
          forge: 'gl',
          scope: { level: 'instance' },
          name: 'dind',
          stack: 'docker',
          raw: { metrics_port: 9252 },
        },
      ],
      { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
    );
    const report = pick(findings(config), 'group.metrics-port', 'dind');
    expect(report?.status).toBe('warn');
    expect(report?.fix).toContain('metrics.listen');
  });

  it('skips the metrics port on a group no gitlab-runner container backs', () => {
    // The exporter scrapes GitLab Docker seats and nothing else, so a port on
    // anything else publishes nothing. Reporting ok would say grove is
    // scraping a port that was never bound.
    const github = {
      ...configWith([
        { ...BASE, name: 'gha', stack: 'docker', raw: { metrics_port: 9252 } },
      ]),
      metrics: { listen: '127.0.0.1:9130', scrapeCacheMs: 10_000 },
    } as unknown as GroveConfig;
    const onGithub = pick(findings(github), 'group.metrics-port', 'gha');
    expect(onGithub?.status).toBe('skip');
    expect(onGithub?.summary).toBe(
      'metrics_port applies to gitlab groups only',
    );

    const native = {
      ...configWith(
        [
          {
            ...BASE,
            forge: 'gl',
            scope: { level: 'instance' },
            name: 'shell',
            stack: 'native',
            raw: { metrics_port: 9252 },
          },
        ],
        { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
      ),
      metrics: { listen: '127.0.0.1:9130', scrapeCacheMs: 10_000 },
    } as unknown as GroveConfig;
    const onNative = pick(findings(native), 'group.metrics-port', 'shell');
    expect(onNative?.status).toBe('skip');
    // The reason names the half of the config that is wrong. A native seat
    // has no container to publish a port from, which is not the same problem
    // as being on the wrong forge.
    expect(onNative?.summary).toBe(
      'metrics_port applies to docker groups only',
    );
  });

  it('warns when two groups on one host publish overlapping ports', () => {
    const config = {
      ...configWith(
        [
          {
            ...BASE,
            forge: 'gl',
            scope: { level: 'instance' },
            name: 'a',
            stack: 'docker',
            placement: { mac: 3 },
            raw: { metrics_port: 9252 },
          },
          {
            ...BASE,
            forge: 'gl',
            scope: { level: 'instance' },
            name: 'b',
            stack: 'docker',
            placement: { mac: 2 },
            raw: { metrics_port: 9254 },
          },
        ],
        { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
      ),
      metrics: { listen: '127.0.0.1:9130', scrapeCacheMs: 10_000 },
    } as unknown as GroveConfig;

    const report = pick(findings(config), 'group.metrics-port', 'b');
    expect(report?.status).toBe('warn');
    expect(report?.summary).toContain('9254');
  });

  it('fails the metrics port when the last seat lands above the port range', () => {
    const config = {
      ...configWith(
        [
          {
            ...BASE,
            forge: 'gl',
            scope: { level: 'instance' },
            name: 'dind',
            stack: 'docker',
            placement: { mac: 10 },
            raw: { metrics_port: 65_530 },
          },
        ],
        { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
      ),
      metrics: { listen: '127.0.0.1:9130', scrapeCacheMs: 10_000 },
    } as unknown as GroveConfig;

    const report = pick(findings(config), 'group.metrics-port', 'dind');
    expect(report?.status).toBe('fail');
    expect(report?.summary).toContain('65539');
  });

  it('agrees with group.raw when the base itself is out of range', () => {
    // Two checks on one target disagreeing is what an operator stops reading
    // at, so the range predicate is the same one rawGitlabOptions throws on.
    const config = {
      ...configWith(
        [
          {
            ...BASE,
            forge: 'gl',
            scope: { level: 'instance' },
            name: 'dind',
            stack: 'docker',
            raw: { metrics_port: 70_000 },
          },
        ],
        { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
      ),
      metrics: { listen: '127.0.0.1:9130', scrapeCacheMs: 10_000 },
    } as unknown as GroveConfig;

    const reports = findings(config);
    expect(pick(reports, 'group.raw', 'dind')?.status).toBe('fail');
    expect(pick(reports, 'group.metrics-port', 'dind')?.status).toBe('fail');
  });

  it('gives every group a row for every check', () => {
    const config = configWith([
      { ...BASE, name: 'one', stack: 'docker' },
      { ...BASE, name: 'two', stack: 'docker' },
    ]);
    const reports = findings(config);
    expect(
      reports.filter((report) => report.target.name === 'one'),
    ).toHaveLength(8);
    expect(reports.every((report) => report.target.kind === 'group')).toBe(
      true,
    );
  });
});

describe('metricsPortsFor', () => {
  it('gives each seat on the host its own port, counting up from the declared one', () => {
    const config = configWith(
      [
        {
          ...BASE,
          forge: 'gl',
          scope: { level: 'instance' },
          name: 'dind',
          stack: 'docker',
          placement: { mac: 3 },
          raw: { metrics_port: 9252 },
        },
      ],
      { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
    );
    expect(metricsPortsFor(config, 'mac')).toEqual([
      { group: 'dind', ports: [9252, 9253, 9254] },
    ]);
  });

  it('gives nothing for a group no gitlab-runner container backs', () => {
    // The same filter `seatMetricsTargets` applies. A GitHub Actions runner
    // exposes no metrics endpoint, and a native seat has no container to
    // publish a port from, so neither has a port to report.
    const github = configWith([
      { ...BASE, name: 'gha', stack: 'docker', raw: { metrics_port: 9252 } },
    ]);
    expect(metricsPortsFor(github, 'mac')).toEqual([]);

    const native = configWith(
      [
        {
          ...BASE,
          forge: 'gl',
          scope: { level: 'instance' },
          name: 'shell',
          stack: 'native',
          raw: { metrics_port: 9252 },
        },
      ],
      { gl: { kind: 'gitlab', url: 'https://git.example.com' } },
    );
    expect(metricsPortsFor(native, 'mac')).toEqual([]);
  });

  it('gives nothing for a group that declares none', () => {
    const config = configWith([{ ...BASE, name: 'plain', stack: 'docker' }]);
    expect(metricsPortsFor(config, 'mac')).toEqual([]);
  });
});
