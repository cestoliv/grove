import { describe, expect, it } from 'vitest';
import { validateReferences } from './references.js';
import type { GroupConfig, GroveConfig } from './schema.js';

function buildConfig(overrides: Partial<GroupConfig> = {}): GroveConfig {
  const group = {
    name: 'overload-arm',
    forge: 'gh-overload',
    scope: { level: 'organization', target: 'Overload-coach' },
    placement: { mac: 2 },
    stack: 'docker',
    ...overrides,
  } as GroupConfig;
  return {
    tick: { fast: 120_000, full: 1_800_000 },
    hosts: {
      mac: { type: 'local' },
      atlas: { type: 'ssh', host: 'atlas' },
    },
    forges: {
      'gh-overload': { kind: 'github' },
      'gl-chevro': { kind: 'gitlab', url: 'https://git.chevro.fr' },
    },
    groups: [group],
  };
}

describe('validateReferences', () => {
  it('accepts a config whose references all resolve', () => {
    expect(validateReferences(buildConfig())).toEqual([]);
  });

  it('reports an unknown forge and lists the declared ones', () => {
    const issues = validateReferences(buildConfig({ forge: 'gh-nope' }));
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('groups[0].forge');
    expect(issues[0].message).toBe(
      'unknown forge "gh-nope". Declared forges: gh-overload, gl-chevro',
    );
  });

  it('reports an unknown placement host and lists the declared ones', () => {
    const issues = validateReferences(buildConfig({ placement: { nuc: 1 } }));
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('groups[0].placement.nuc');
    expect(issues[0].message).toBe(
      'unknown host "nuc". Declared hosts: mac, atlas',
    );
  });

  it('reports every unknown host in a map placement', () => {
    const issues = validateReferences(
      buildConfig({ placement: { nuc: 1, pi: 2, mac: 1 } }),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      'groups[0].placement.nuc',
      'groups[0].placement.pi',
    ]);
  });

  it('rejects a GitLab level on a GitHub forge and names the three valid values', () => {
    const issues = validateReferences(
      buildConfig({ scope: { level: 'instance' } }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('groups[0].scope.level');
    expect(issues[0].message).toBe(
      '"instance" is not valid for forge "gh-overload" of kind github. Valid values: enterprise, organization, repository',
    );
  });

  it('rejects a GitHub level on a GitLab forge and names the three valid values', () => {
    const issues = validateReferences(
      buildConfig({
        forge: 'gl-chevro',
        scope: { level: 'organization', target: 'Overload-coach' },
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      '"organization" is not valid for forge "gl-chevro" of kind gitlab. Valid values: instance, group, project',
    );
  });

  it('rejects tags on a GitHub group', () => {
    const issues = validateReferences(buildConfig({ tags: ['docker'] }));
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('groups[0].tags');
    expect(issues[0].message).toBe(
      'tags belong to GitLab. Forge "gh-overload" is a GitHub forge, so use labels.',
    );
  });

  it('rejects labels on a GitLab group', () => {
    const issues = validateReferences(
      buildConfig({
        forge: 'gl-chevro',
        scope: { level: 'instance' },
        labels: ['arm64'],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('groups[0].labels');
    expect(issues[0].message).toBe(
      'labels belong to GitHub. Forge "gl-chevro" is a GitLab forge, so use tags.',
    );
  });

  it('rejects a group that sets both image and build', () => {
    const issues = validateReferences(
      buildConfig({ image: 'node:22', build: './runners/Dockerfile' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('groups[0]');
    expect(issues[0].message).toBe(
      'set image or build, not both. image names a reference to pull, build names a Dockerfile on the host.',
    );
  });

  it('reports a duplicate group name, because derived artifact names would collide', () => {
    const config = buildConfig();
    config.groups = [config.groups[0], { ...config.groups[0] }];
    const issues = validateReferences(config);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('groups[1].name');
    expect(issues[0].message).toBe('duplicate group name "overload-arm"');
  });

  it('reports several independent problems in one pass', () => {
    const issues = validateReferences(
      buildConfig({ forge: 'gh-nope', placement: { nuc: 1 } }),
    );
    expect(issues).toHaveLength(2);
  });
});

describe('validateReferences, GitLab group names', () => {
  it('refuses a GitLab group whose name ends in a dash and digits', () => {
    const issues = validateReferences(
      buildConfig({
        name: 'chevro-2',
        forge: 'gl-chevro',
        scope: { level: 'instance' },
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('groups[0].name');
    expect(issues[0].message).toContain(
      'one runner entity described as "grove-chevro-2"',
    );
  });

  it('accepts the same name on a GitHub forge', () => {
    expect(validateReferences(buildConfig({ name: 'chevro-2' }))).toEqual([]);
  });

  it('accepts a GitLab group whose name ends in a letter', () => {
    expect(
      validateReferences(
        buildConfig({
          name: 'chevro-dind',
          forge: 'gl-chevro',
          scope: { level: 'instance' },
        }),
      ),
    ).toEqual([]);
  });
});
