import { GITHUB_LEVELS, GITLAB_LEVELS, type Scope } from '../config/index.js';

export const GITLAB_API_SUFFIX = '/api/v4';

export type GitlabRunnerType = 'instance_type' | 'group_type' | 'project_type';

export function gitlabApiBase(url: string): string {
  return `${url.replace(/\/+$/, '')}${GITLAB_API_SUFFIX}`;
}

function rejectLevel(scope: Scope): never {
  throw new Error(
    `scope level "${scope.level}" is a GitHub level. A GitLab forge takes ` +
      `${GITLAB_LEVELS[0]}, ${GITLAB_LEVELS[1]} or ${GITLAB_LEVELS[2]}, ` +
      `not ${GITHUB_LEVELS[0]}, ${GITHUB_LEVELS[1]} or ${GITHUB_LEVELS[2]}.`,
  );
}

export function runnerTypeFor(scope: Scope): GitlabRunnerType {
  switch (scope.level) {
    case 'instance':
      return 'instance_type';
    case 'group':
      return 'group_type';
    case 'project':
      return 'project_type';
    default:
      return rejectLevel(scope);
  }
}

// GitLab resolves a namespace by numeric id or by url encoded full path. A
// leading slash makes the encoded path start with %2F, which resolves to
// nothing, so it is rejected here rather than becoming a 404 later.
function encodeTarget(target: string): string {
  if (target.startsWith('/') || target.endsWith('/') || target.trim() === '') {
    throw new Error(
      `scope.target "${target}" must be a namespace path, for example infra/ci`,
    );
  }
  return encodeURIComponent(target);
}

export function namespacePath(scope: Scope): string | undefined {
  switch (scope.level) {
    case 'instance':
      return undefined;
    case 'group':
      return `/groups/${encodeTarget(scope.target)}`;
    case 'project':
      return `/projects/${encodeTarget(scope.target)}`;
    default:
      return rejectLevel(scope);
  }
}

export function runnersListPath(scope: Scope, namespaceId?: number): string {
  if (scope.level === 'instance') {
    // Only the admin endpoint sees every instance runner. /runners alone
    // lists the ones the token's own user owns, which is not the fleet.
    return '/runners/all';
  }
  if (scope.level !== 'group' && scope.level !== 'project') {
    return rejectLevel(scope);
  }
  if (namespaceId === undefined) {
    throw new Error(
      `listing runners needs the numeric id of ${scope.level} "${scope.target}"`,
    );
  }
  const collection = scope.level === 'group' ? 'groups' : 'projects';
  return `/${collection}/${namespaceId}/runners`;
}

export function gitlabAuthHint(status: number, scope: Scope): string {
  if (status === 401) {
    return ' The token was rejected. Check that it is a personal access token for this GitLab instance and that it has not expired.';
  }
  if (status !== 403) {
    return '';
  }
  if (scope.level === 'instance') {
    return ' Creating or listing an instance level runner needs a personal access token that belongs to an instance administrator and carries the api scope.';
  }
  if (scope.level === 'group' || scope.level === 'project') {
    return ` The token needs the api scope and the Owner role on ${scope.level} "${scope.target}".`;
  }
  return '';
}
