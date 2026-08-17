import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config/errors.js';
import type { GroupConfig, GroveConfig } from '../config/index.js';
import { rawStackWarnings } from './raw-warnings.js';

function config(groups: Array<Partial<GroupConfig>>): GroveConfig {
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: { atlas: { type: 'ssh', host: 'atlas' } },
    forges: {
      'gh-overload': { kind: 'github' },
      'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' },
    },
    groups: groups.map(
      (group) =>
        ({
          name: 'g',
          forge: 'gh-overload',
          scope: { level: 'organization', target: 'Overload-coach' },
          placement: { atlas: 1 },
          stack: 'docker',
          ...group,
        }) as GroupConfig,
    ),
  };
}

describe('rawStackWarnings', () => {
  it('says nothing about a group with no raw block', () => {
    expect(rawStackWarnings(config([{}]))).toEqual([]);
  });

  it('names the two keys the GitHub stack reads', () => {
    const warnings = rawStackWarnings(config([{ raw: { launchd_plist: {} } }]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('raw-unused');
    expect(warnings[0].path).toBe('groups[0].raw.launchd_plist');
    expect(warnings[0].message).toContain('docker_run_args and env');
  });

  it('names the five keys the GitLab stack reads', () => {
    const warnings = rawStackWarnings(
      config([
        {
          forge: 'gl-chevro',
          scope: { level: 'instance' },
          raw: { launchd_plist: {} },
        },
      ]),
    );
    expect(warnings[0].message).toContain(
      'docker_run_args, env, job_image, metrics_port and register_args',
    );
  });

  it('turns a malformed raw block into a config error, with the key named', () => {
    expect(() =>
      rawStackWarnings(config([{ raw: { docker_run_args: 'nope' } }])),
    ).toThrow(ConfigError);
  });

  it('reads the GitLab keys through the GitLab reader', () => {
    expect(() =>
      rawStackWarnings(
        config([
          {
            forge: 'gl-chevro',
            scope: { level: 'instance' },
            raw: { job_image: 3 },
          },
        ]),
      ),
    ).toThrow(ConfigError);
  });
});

function configWith(overrides: Record<string, unknown>): GroveConfig {
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
        stack: 'docker',
        ...overrides,
      },
    ],
  } as unknown as GroveConfig;
}

describe('rawStackWarnings, native groups', () => {
  it('reads env and runner_version and warns about everything else', () => {
    const warnings = rawStackWarnings(
      configWith({
        stack: 'native',
        raw: {
          env: { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' },
          runner_version: '2.328.0',
          docker_run_args: ['--dns', '1.1.1.1'],
        },
      }),
    );
    expect(warnings).toEqual([
      {
        code: 'raw-unused',
        path: 'groups[0].raw.docker_run_args',
        message:
          'this stack reads env and runner_version from raw, and passes nothing else through. grove proceeds anyway.',
      },
    ]);
  });

  it('turns a malformed native raw block into a config error', () => {
    expect(() =>
      rawStackWarnings(
        configWith({ stack: 'native', raw: { runner_version: 2 } }),
      ),
    ).toThrow('groups[0].raw.runner_version');
  });

  it('says nothing about a native group with no raw block', () => {
    expect(rawStackWarnings(configWith({ stack: 'native' }))).toEqual([]);
  });
});
