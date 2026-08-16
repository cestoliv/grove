import { describe, expect, it } from 'vitest';
import type { Scope } from '../config/index.js';
import {
  gitlabApiBase,
  gitlabAuthHint,
  namespacePath,
  runnersListPath,
  runnerTypeFor,
} from './gitlab-scope.js';

const instance: Scope = { level: 'instance' };
const group: Scope = { level: 'group', target: 'infra/ci' };
const project: Scope = { level: 'project', target: 'infra/ci/api' };

describe('gitlabApiBase', () => {
  it('appends the v4 prefix to the configured url', () => {
    expect(gitlabApiBase('https://git.chevro.fr')).toBe(
      'https://git.chevro.fr/api/v4',
    );
  });

  it('drops any trailing slash first', () => {
    expect(gitlabApiBase('https://git.chevro.fr///')).toBe(
      'https://git.chevro.fr/api/v4',
    );
  });
});

describe('runnerTypeFor', () => {
  it('maps every GitLab level to its runner type', () => {
    expect(runnerTypeFor(instance)).toBe('instance_type');
    expect(runnerTypeFor(group)).toBe('group_type');
    expect(runnerTypeFor(project)).toBe('project_type');
  });

  it('names the three valid levels when given a GitHub one', () => {
    expect(() =>
      runnerTypeFor({ level: 'organization', target: 'Overload-coach' }),
    ).toThrow(/instance, group or project/);
  });
});

describe('namespacePath', () => {
  it('has no namespace to look up at instance level', () => {
    expect(namespacePath(instance)).toBeUndefined();
  });

  it('url encodes the full path of a group', () => {
    expect(namespacePath(group)).toBe('/groups/infra%2Fci');
  });

  it('url encodes the full path of a project', () => {
    expect(namespacePath(project)).toBe('/projects/infra%2Fci%2Fapi');
  });

  it('refuses a target with a leading slash, which never resolves', () => {
    expect(() => namespacePath({ level: 'group', target: '/infra' })).toThrow(
      'scope.target "/infra" must be a namespace path',
    );
  });
});

describe('runnersListPath', () => {
  it('lists every instance runner through the admin endpoint', () => {
    expect(runnersListPath(instance)).toBe('/runners/all');
  });

  it('lists a group and a project through their own endpoint', () => {
    expect(runnersListPath(group, 12)).toBe('/groups/12/runners');
    expect(runnersListPath(project, 34)).toBe('/projects/34/runners');
  });

  it('refuses to guess a namespace id it was not given', () => {
    expect(() => runnersListPath(group)).toThrow(
      'needs the numeric id of group "infra/ci"',
    );
  });
});

describe('gitlabAuthHint', () => {
  it('says the token was rejected on 401', () => {
    expect(gitlabAuthHint(401, instance)).toContain(
      'personal access token for this GitLab instance',
    );
  });

  it('names the administrator requirement on 403 at instance level', () => {
    expect(gitlabAuthHint(403, instance)).toContain('instance administrator');
    expect(gitlabAuthHint(403, instance)).toContain('api scope');
  });

  it('names the owner requirement on 403 at group level', () => {
    const hint = gitlabAuthHint(403, group);
    expect(hint).toContain('Owner role on group "infra/ci"');
    expect(hint).toContain('api scope');
  });

  it('names the owner requirement on 403 at project level', () => {
    expect(gitlabAuthHint(403, project)).toContain(
      'Owner role on project "infra/ci/api"',
    );
  });

  it('has nothing to add to any other status', () => {
    expect(gitlabAuthHint(404, group)).toBe('');
    expect(gitlabAuthHint(500, instance)).toBe('');
  });
});
