import { GITHUB_LEVELS, GITLAB_LEVELS, type Scope } from '../config/index.js';

export const GITHUB_API_URL = 'https://api.github.com';
export const GITHUB_WEB_URL = 'https://github.com';

export interface GithubEndpoints {
  api: string;
  web: string;
}

// github.com splits the API onto its own host. GitHub Enterprise Server
// serves it from /api/v3 on the same host, so one configured url gives both.
export function githubEndpoints(url?: string): GithubEndpoints {
  if (url === undefined) {
    return { api: GITHUB_API_URL, web: GITHUB_WEB_URL };
  }
  const web = url.replace(/\/+$/, '');
  return { api: `${web}/api/v3`, web };
}

export function parseRepository(target: string): {
  owner: string;
  repo: string;
} {
  const parts = target.split('/');
  if (parts.length !== 2 || parts.some((part) => part === '')) {
    throw new Error(
      `scope.target "${target}" must be owner/repo for a repository level GitHub group`,
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

function rejectLevel(scope: Scope): never {
  throw new Error(
    `scope level "${scope.level}" is a GitLab level. A GitHub forge takes ` +
      `${GITHUB_LEVELS[0]}, ${GITHUB_LEVELS[1]} or ${GITHUB_LEVELS[2]}, ` +
      `not ${GITLAB_LEVELS[0]}, ${GITLAB_LEVELS[1]} or ${GITLAB_LEVELS[2]}.`,
  );
}

export function runnersPath(scope: Scope): string {
  switch (scope.level) {
    case 'repository': {
      const { owner, repo } = parseRepository(scope.target);
      return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runners`;
    }
    case 'organization':
      return `/orgs/${encodeURIComponent(scope.target)}/actions/runners`;
    case 'enterprise':
      return `/enterprises/${encodeURIComponent(scope.target)}/actions/runners`;
    default:
      return rejectLevel(scope);
  }
}

export function registrationUrl(web: string, scope: Scope): string {
  switch (scope.level) {
    case 'repository': {
      const { owner, repo } = parseRepository(scope.target);
      return `${web}/${owner}/${repo}`;
    }
    case 'organization':
      return `${web}/${scope.target}`;
    case 'enterprise':
      return `${web}/enterprises/${scope.target}`;
    default:
      return rejectLevel(scope);
  }
}
