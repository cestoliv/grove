import { describe, expect, it } from 'vitest';
import { issuesFromZod } from './errors.js';
import {
  configSchema,
  DEFAULT_HISTORY_RETENTION_MS,
  DEFAULT_TICK,
  forgeSchema,
  groupSchema,
  historySchema,
  hostSchema,
  placementSchema,
  scopeSchema,
  tickSchema,
} from './schema.js';

describe('tickSchema', () => {
  it('converts duration strings to milliseconds', () => {
    expect(tickSchema.parse({ fast: '2m', full: '30m' })).toEqual({
      fast: 120_000,
      full: 1_800_000,
    });
  });

  it('leaves absent fields absent so the loader can default them', () => {
    expect(tickSchema.parse({})).toEqual({});
    expect(DEFAULT_TICK).toEqual({ fast: 120_000, full: 1_800_000 });
  });

  it('rejects a duration with no unit', () => {
    const result = tickSchema.safeParse({ fast: '2' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].message).toMatch(
      /expected a duration/,
    );
  });
});

describe('hostSchema', () => {
  it('accepts a local host', () => {
    expect(
      hostSchema.parse({ type: 'local', work_root: '/Volumes/ci/grove' }),
    ).toEqual({
      type: 'local',
      work_root: '/Volumes/ci/grove',
    });
  });

  it('accepts an ssh host addressed by its ssh config alias', () => {
    expect(
      hostSchema.parse({
        type: 'ssh',
        host: 'atlas',
        work_root: '/PROD/local/grove',
      }),
    ).toEqual({ type: 'ssh', host: 'atlas', work_root: '/PROD/local/grove' });
  });

  it('requires host on an ssh entry', () => {
    const result = hostSchema.safeParse({ type: 'ssh' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].path).toBe('host');
  });

  it('names both valid types when type is wrong', () => {
    const result = hostSchema.safeParse({ type: 'podman' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].message).toBe(
      'type must be "local" or "ssh"',
    );
  });

  it('rejects an unknown key', () => {
    const result = hostSchema.safeParse({ type: 'local', worck_root: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('rejects an ssh host value that starts with -, which ssh would parse as a flag', () => {
    const result = hostSchema.safeParse({
      type: 'ssh',
      host: '-oProxyCommand=x',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].message).toBe(
      'host must not start with "-"',
    );
  });
});

describe('forgeSchema', () => {
  it('tags a token auth block', () => {
    expect(
      forgeSchema.parse({ kind: 'github', auth: { token: 'secret-value' } }),
    ).toEqual({
      kind: 'github',
      auth: { source: 'token', token: 'secret-value' },
    });
  });

  it('tags a command auth block', () => {
    expect(
      forgeSchema.parse({
        kind: 'gitlab',
        url: 'https://git.chevro.fr',
        auth: { command: 'op read op://infra/gitlab/pat' },
      }),
    ).toEqual({
      kind: 'gitlab',
      url: 'https://git.chevro.fr',
      auth: { source: 'command', command: 'op read op://infra/gitlab/pat' },
    });
  });

  it('allows an absent auth block, which means CLI delegation', () => {
    expect(forgeSchema.parse({ kind: 'github' })).toEqual({ kind: 'github' });
  });

  it('requires url on a gitlab forge', () => {
    const result = forgeSchema.safeParse({ kind: 'gitlab' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].path).toBe('url');
  });

  it('names both valid kinds when kind is wrong', () => {
    const result = forgeSchema.safeParse({ kind: 'gitea' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].message).toBe(
      'kind must be "github" or "gitlab"',
    );
  });

  it('rejects an auth block that sets both token and command', () => {
    const result = forgeSchema.safeParse({
      kind: 'github',
      auth: { token: 'a', command: 'b' },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].message).toMatch(/auth must be/);
  });
});

describe('scopeSchema', () => {
  it('accepts every GitHub level with a target', () => {
    expect(
      scopeSchema.parse({ level: 'organization', target: 'Overload-coach' }),
    ).toEqual({
      level: 'organization',
      target: 'Overload-coach',
    });
    expect(
      scopeSchema.parse({ level: 'enterprise', target: 'acme' }).level,
    ).toBe('enterprise');
    expect(
      scopeSchema.parse({ level: 'repository', target: 'acme/api' }).level,
    ).toBe('repository');
  });

  it('accepts the GitLab instance level with no target', () => {
    expect(scopeSchema.parse({ level: 'instance' })).toEqual({
      level: 'instance',
    });
  });

  it('requires a target on the GitLab group and project levels', () => {
    expect(scopeSchema.safeParse({ level: 'group' }).success).toBe(false);
    expect(scopeSchema.safeParse({ level: 'project' }).success).toBe(false);
  });

  it('lists every level when the level is unknown', () => {
    const result = scopeSchema.safeParse({ level: 'workspace', target: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].message).toBe(
      'level must be one of enterprise, organization, repository, instance, group, project',
    );
  });
});

describe('placementSchema', () => {
  it('normalises the object form', () => {
    expect(placementSchema.parse({ host: 'mac', count: 2 })).toEqual({
      mac: 2,
    });
  });

  it('keeps the map form, which spans hosts', () => {
    expect(placementSchema.parse({ atlas: 3, mac: 1 })).toEqual({
      atlas: 3,
      mac: 1,
    });
  });

  it('rejects a zero or negative count', () => {
    expect(placementSchema.safeParse({ host: 'mac', count: 0 }).success).toBe(
      false,
    );
    expect(placementSchema.safeParse({ atlas: -1 }).success).toBe(false);
  });

  it('explains both forms when neither matches', () => {
    const result = placementSchema.safeParse('mac');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].message).toMatch(
      /placement must be \{ host: <name>, count: <n> \}/,
    );
  });

  it('rejects an empty map, which would declare a group that manages nothing', () => {
    const result = placementSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].message).toBe(
      'placement must name at least one host',
    );
  });
});

describe('groupSchema', () => {
  const base = {
    name: 'overload-arm',
    forge: 'gh-overload',
    scope: { level: 'organization', target: 'Overload-coach' },
    placement: { host: 'mac', count: 2 },
  };

  it('defaults the stack to docker', () => {
    expect(groupSchema.parse(base).stack).toBe('docker');
  });

  it('keeps every first-class key and converts durations and sizes', () => {
    const group = groupSchema.parse({
      ...base,
      stack: 'native',
      arch: 'arm64',
      labels: ['macos', 'xcode'],
      work_root: '~/ci/ios',
      cache_root: '~/ci/cache',
      max_job_duration: '90m',
      drain_timeout: '5m',
      max_work_size: '120G',
      concurrent: 4,
      limit: 2,
      pull_policy: 'always',
    });
    expect(group.max_job_duration).toBe(5_400_000);
    expect(group.drain_timeout).toBe(300_000);
    expect(group.max_work_size).toBe(120 * 1024 ** 3);
    expect(group.labels).toEqual(['macos', 'xcode']);
    expect(group.pull_policy).toBe('always');
  });

  it('keeps the docker keys the spec names', () => {
    const group = groupSchema.parse({
      ...base,
      tags: ['docker', 'dind'],
      image: 'gitlab/gitlab-runner:latest',
      privileged: true,
      volumes: ['/cache', '/var/run/docker.sock:/var/run/docker.sock'],
    });
    expect(group.privileged).toBe(true);
    expect(group.volumes).toEqual([
      '/cache',
      '/var/run/docker.sock:/var/run/docker.sock',
    ]);
  });

  it('passes a raw block through untouched', () => {
    const group = groupSchema.parse({
      ...base,
      raw: { docker: { shm_size: '2g' }, anything: [1, 2] },
    });
    expect(group.raw).toEqual({ docker: { shm_size: '2g' }, anything: [1, 2] });
  });

  it('rejects a name that breaks the naming convention', () => {
    for (const name of ['Overload', 'over_load', '-lead', 'trail-', '']) {
      expect(groupSchema.safeParse({ ...base, name }).success).toBe(false);
    }
  });

  it('rejects a name longer than 40 characters', () => {
    const result = groupSchema.safeParse({ ...base, name: 'a'.repeat(41) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuesFromZod(result.error)[0].message).toMatch(
      /at most 40 characters/,
    );
  });

  it('rejects an unknown key so typos surface instead of being ignored', () => {
    expect(groupSchema.safeParse({ ...base, privilege: true }).success).toBe(
      false,
    );
  });
});

describe('configSchema', () => {
  it('parses the config from the spec', () => {
    const parsed = configSchema.parse({
      tick: { fast: '2m', full: '30m' },
      hosts: {
        mac: { type: 'local', work_root: '/Volumes/ci/grove' },
        atlas: { type: 'ssh', host: 'atlas', work_root: '/PROD/local/grove' },
      },
      forges: {
        'gh-overload': { kind: 'github', auth: { token: 'value-from-env' } },
        'gl-chevro': {
          kind: 'gitlab',
          url: 'https://git.chevro.fr',
          auth: { command: 'op read op://infra/gitlab/pat' },
        },
      },
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: { level: 'organization', target: 'Overload-coach' },
          placement: { host: 'mac', count: 2 },
          stack: 'docker',
          arch: 'arm64',
          labels: ['arm64'],
          build: './runners/Dockerfile',
        },
        {
          name: 'chevro-dind',
          forge: 'gl-chevro',
          scope: { level: 'instance' },
          placement: { atlas: 3 },
          stack: 'docker',
          arch: 'amd64',
          tags: ['docker', 'dind'],
          image: 'gitlab/gitlab-runner:latest',
          privileged: true,
          volumes: ['/cache', '/var/run/docker.sock:/var/run/docker.sock'],
          concurrent: 4,
        },
      ],
    });
    expect(parsed.tick).toEqual({ fast: 120_000, full: 1_800_000 });
    expect(parsed.groups[0].placement).toEqual({ mac: 2 });
    expect(parsed.groups[1].placement).toEqual({ atlas: 3 });
  });

  it('requires at least one group', () => {
    const result = configSchema.safeParse({
      hosts: {},
      forges: {},
      groups: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    const result = configSchema.safeParse({
      hosts: {},
      forges: {},
      groups: [
        {
          name: 'overload-arm',
          forge: 'gh-overload',
          scope: { level: 'organization', target: 'Overload-coach' },
          placement: { host: 'mac', count: 2 },
        },
      ],
      runners: [],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('history', () => {
  it('parses a retention duration into milliseconds', () => {
    const parsed = historySchema.parse({ retention: '30d' });
    expect(parsed.retention).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('accepts an empty block and refuses an unknown key', () => {
    expect(historySchema.parse({})).toEqual({});
    expect(() => historySchema.parse({ keep: '30d' })).toThrow();
  });

  it('defaults to ninety days', () => {
    expect(DEFAULT_HISTORY_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });
});
