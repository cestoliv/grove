import type { ForgeConfig, Scope } from '../config/index.js';
import { errorMessage } from '../errors.js';
import {
  type FetchFn,
  GITHUB_API_VERSION,
  githubEndpoints,
  gitlabApiBase,
  namespacePath,
  runnersListPath,
  runnersPath,
} from '../forge/index.js';

export interface ForgeProbeInput {
  name: string;
  forge: ForgeConfig;
  token: string;
  fetchFn: FetchFn;
}

/**
 * One shape for every answer, including the ones that never reached a server.
 * Status 0 means the request failed before a response existed, which the
 * checks report differently from a 401.
 */
export interface HttpAnswer {
  status: number;
  body: unknown;
  // The classic OAuth scopes GitHub puts on every response. Absent on a
  // fine-grained token, which carries no such header at all.
  scopes?: string[];
  error?: string;
}

function baseUrl(forge: ForgeConfig): string {
  return forge.kind === 'gitlab'
    ? gitlabApiBase(forge.url)
    : githubEndpoints(forge.url).api;
}

function headersFor(input: ForgeProbeInput): Record<string, string> {
  return input.forge.kind === 'gitlab'
    ? { Accept: 'application/json', 'PRIVATE-TOKEN': input.token }
    : {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${input.token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      };
}

export async function forgeGet(
  input: ForgeProbeInput,
  path: string,
): Promise<HttpAnswer> {
  let response: Response;
  try {
    response = await input.fetchFn(`${baseUrl(input.forge)}${path}`, {
      method: 'GET',
      headers: headersFor(input),
    });
  } catch (error) {
    return { status: 0, body: undefined, error: errorMessage(error) };
  }

  const raw = response.headers.get('x-oauth-scopes');
  const scopes =
    raw === null
      ? undefined
      : raw
          .split(',')
          .map((scope) => scope.trim())
          .filter((scope) => scope !== '');

  let body: unknown;
  try {
    const text = await response.text();
    body = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    // A proxy's HTML error page is not a body grove can read, and it is not
    // a reason to lose the status code either.
    body = undefined;
  }

  return {
    status: response.status,
    body,
    ...(scopes === undefined ? {} : { scopes }),
  };
}

// The classic scopes that let a token manage runners at a level. Either one
// is enough: manage_runners:* is the narrow scope GitHub added later, and
// admin:* is what a token minted before it carries.
export const GITHUB_SCOPES_FOR_LEVEL: Record<
  'enterprise' | 'organization' | 'repository',
  string[]
> = {
  enterprise: ['manage_runners:enterprise', 'admin:enterprise'],
  organization: ['manage_runners:org', 'admin:org'],
  repository: ['repo'],
};

export const GITLAB_CREATE_SCOPE = 'create_runner';
export const GITLAB_READ_SCOPES = ['api', 'read_api'];

export interface GithubIdentity {
  login?: string;
  scopes?: string[];
  answer: HttpAnswer;
}

export async function readGithubIdentity(
  input: ForgeProbeInput,
): Promise<GithubIdentity> {
  const answer = await forgeGet(input, '/user');
  const body = (answer.body ?? {}) as { login?: unknown };
  return {
    ...(typeof body.login === 'string' ? { login: body.login } : {}),
    ...(answer.scopes === undefined ? {} : { scopes: answer.scopes }),
    answer,
  };
}

/**
 * One page of runners at the declared scope. This is a read that needs the
 * same permission a registration does, which is what makes it a proof. grove
 * does not mint a registration token to find out, because minting one is a
 * write at the forge.
 */
export function readGithubScopeAccess(
  input: ForgeProbeInput,
  scope: Scope,
): Promise<HttpAnswer> {
  return forgeGet(input, `${runnersPath(scope)}?per_page=1`);
}

export interface GitlabIdentity {
  username?: string;
  isAdmin: boolean;
  answer: HttpAnswer;
}

export async function readGitlabIdentity(
  input: ForgeProbeInput,
): Promise<GitlabIdentity> {
  const answer = await forgeGet(input, '/user');
  const body = (answer.body ?? {}) as {
    username?: unknown;
    is_admin?: unknown;
  };
  return {
    ...(typeof body.username === 'string' ? { username: body.username } : {}),
    isAdmin: body.is_admin === true,
    answer,
  };
}

export async function readGitlabTokenScopes(
  input: ForgeProbeInput,
): Promise<{ scopes?: string[]; answer: HttpAnswer }> {
  // GitLab 15.x and later. An older instance answers 404, which the check
  // reads as "grove cannot tell", not as "the token is wrong".
  const answer = await forgeGet(input, '/personal_access_tokens/self');
  const body = (answer.body ?? {}) as { scopes?: unknown };
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.map((scope) => String(scope))
    : undefined;
  return { ...(scopes === undefined ? {} : { scopes }), answer };
}

/**
 * One page of runners under a group or a project. Seeing a namespace is not
 * the same permission as managing the runners in it, so this read is what
 * proves the token can do what the config asks. readGitlabNamespace is only
 * how grove learns the numeric id this path needs.
 */
export function readGitlabScopeRunners(
  input: ForgeProbeInput,
  scope: Scope,
  namespaceId: number,
): Promise<HttpAnswer> {
  return forgeGet(input, `${runnersListPath(scope, namespaceId)}?per_page=1`);
}

export function readGitlabNamespace(
  input: ForgeProbeInput,
  scope: Scope,
): Promise<HttpAnswer> {
  const path = namespacePath(scope);
  if (path === undefined) {
    // An instance scope names no namespace, so there is nothing to read and
    // no request to make.
    return Promise.resolve({ status: 0, body: undefined });
  }
  return forgeGet(input, path);
}
