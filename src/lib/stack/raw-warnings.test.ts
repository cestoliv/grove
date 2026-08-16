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

  it('names the four keys the GitLab stack reads', () => {
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
      'docker_run_args, env, job_image and register_args',
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

  it('says nothing about a native group, which has no Docker raw block', () => {
    expect(
      rawStackWarnings(config([{ stack: 'native', raw: { anything: 1 } }])),
    ).toEqual([]);
  });
});
