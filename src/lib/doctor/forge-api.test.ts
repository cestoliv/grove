import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../config/index.js';
import type { FetchFn } from '../forge/index.js';
import {
  type ForgeProbeInput,
  forgeGet,
  readGithubIdentity,
  readGithubScopeAccess,
  readGitlabIdentity,
  readGitlabNamespace,
  readGitlabScopeRunners,
  readGitlabTokenScopes,
} from './forge-api.js';

// Built at runtime so secret scanners do not match the fixture.
const GH_TOKEN = ['ghp', '0123456789abcdefghij'].join('_');
const GL_TOKEN = ['glpat', 'abcdefghijklmnopqrst'].join('-');

interface Route {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fetchStub(routes: Record<string, Route>): {
  fetchFn: FetchFn;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const key = Object.keys(routes).find((route) => url.includes(route));
    if (key === undefined) {
      return new Response('{}', { status: 404 });
    }
    const route = routes[key];
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: route.headers ?? {},
    });
  }) as unknown as FetchFn;
  return { fetchFn, calls };
}

const GITHUB: ForgeConfig = { kind: 'github' } as ForgeConfig;
const GITLAB: ForgeConfig = {
  kind: 'gitlab',
  url: 'https://git.example.com',
} as ForgeConfig;

function githubInput(fetchFn: FetchFn): ForgeProbeInput {
  return { name: 'gh', forge: GITHUB, token: GH_TOKEN, fetchFn };
}

function gitlabInput(fetchFn: FetchFn): ForgeProbeInput {
  return { name: 'gl', forge: GITLAB, token: GL_TOKEN, fetchFn };
}

describe('forgeGet', () => {
  it('sends a bearer token to the GitHub API host', async () => {
    const { fetchFn, calls } = fetchStub({
      '/user': { status: 200, body: {} },
    });
    await forgeGet(githubInput(fetchFn), '/user');
    expect(calls[0].url).toBe('https://api.github.com/user');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${GH_TOKEN}`);
  });

  it('sends a private token to the GitLab API base', async () => {
    const { fetchFn, calls } = fetchStub({
      '/user': { status: 200, body: {} },
    });
    await forgeGet(gitlabInput(fetchFn), '/user');
    expect(calls[0].url).toBe('https://git.example.com/api/v4/user');
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe(GL_TOKEN);
  });

  it('turns a connection failure into an answer rather than a throw', async () => {
    const fetchFn = (async () => {
      throw new Error('getaddrinfo ENOTFOUND git.example.com');
    }) as unknown as FetchFn;
    const answer = await forgeGet(gitlabInput(fetchFn), '/user');
    expect(answer.status).toBe(0);
    expect(answer.error).toContain('ENOTFOUND');
  });

  it('carries a body that is not JSON without throwing', async () => {
    const fetchFn = (async () =>
      new Response('<html>502</html>', { status: 502 })) as unknown as FetchFn;
    const answer = await forgeGet(gitlabInput(fetchFn), '/user');
    expect(answer.status).toBe(502);
    expect(answer.body).toBeUndefined();
  });
});

describe('readGithubIdentity', () => {
  it('reads the login and the classic token scopes', async () => {
    const { fetchFn } = fetchStub({
      '/user': {
        status: 200,
        body: { login: 'ci-bot' },
        headers: { 'x-oauth-scopes': 'repo, admin:org, workflow' },
      },
    });
    const identity = await readGithubIdentity(githubInput(fetchFn));
    expect(identity.login).toBe('ci-bot');
    expect(identity.scopes).toEqual(['repo', 'admin:org', 'workflow']);
  });

  it('reports no scopes at all for a fine-grained token', async () => {
    const { fetchFn } = fetchStub({
      '/user': { status: 200, body: { login: 'ci-bot' } },
    });
    const identity = await readGithubIdentity(githubInput(fetchFn));
    expect(identity.scopes).toBeUndefined();
  });

  it('carries the status of a rejected token', async () => {
    const { fetchFn } = fetchStub({
      '/user': { status: 401, body: { message: 'Bad credentials' } },
    });
    const identity = await readGithubIdentity(githubInput(fetchFn));
    expect(identity.answer.status).toBe(401);
    expect(identity.login).toBeUndefined();
  });
});

describe('readGithubScopeAccess', () => {
  it('reads one page of runners at the scope, which proves the permission', async () => {
    const { fetchFn, calls } = fetchStub({
      '/actions/runners': { status: 200, body: { total_count: 3 } },
    });
    const answer = await readGithubScopeAccess(githubInput(fetchFn), {
      level: 'organization',
      target: 'Acme',
    });
    expect(answer.status).toBe(200);
    expect(calls[0].url).toBe(
      'https://api.github.com/orgs/Acme/actions/runners?per_page=1',
    );
  });
});

describe('readGitlabIdentity', () => {
  it('reads the username and the admin flag', async () => {
    const { fetchFn } = fetchStub({
      '/user': { status: 200, body: { username: 'ci', is_admin: true } },
    });
    const identity = await readGitlabIdentity(gitlabInput(fetchFn));
    expect(identity.username).toBe('ci');
    expect(identity.isAdmin).toBe(true);
  });

  it('reads a non-admin as not admin rather than as unknown', async () => {
    const { fetchFn } = fetchStub({
      '/user': { status: 200, body: { username: 'ci' } },
    });
    expect((await readGitlabIdentity(gitlabInput(fetchFn))).isAdmin).toBe(
      false,
    );
  });
});

describe('readGitlabTokenScopes', () => {
  it('reads the scopes of the token itself', async () => {
    const { fetchFn, calls } = fetchStub({
      '/personal_access_tokens/self': {
        status: 200,
        body: { scopes: ['api', 'create_runner'] },
      },
    });
    const answer = await readGitlabTokenScopes(gitlabInput(fetchFn));
    expect(answer.scopes).toEqual(['api', 'create_runner']);
    expect(calls[0].url).toContain('/api/v4/personal_access_tokens/self');
  });

  it('answers with no scopes on an older GitLab that has no such endpoint', async () => {
    const { fetchFn } = fetchStub({
      '/personal_access_tokens/self': { status: 404 },
    });
    const answer = await readGitlabTokenScopes(gitlabInput(fetchFn));
    expect(answer.scopes).toBeUndefined();
    expect(answer.answer.status).toBe(404);
  });
});

describe('readGitlabNamespace', () => {
  it('reads the group the scope names', async () => {
    const { fetchFn, calls } = fetchStub({
      '/groups/': { status: 200, body: { id: 42 } },
    });
    const answer = await readGitlabNamespace(gitlabInput(fetchFn), {
      level: 'group',
      target: 'infra/ci',
    });
    expect(answer.status).toBe(200);
    expect(calls[0].url).toContain('/groups/infra%2Fci');
  });

  it('turns an instance scope, which names no namespace, into an empty answer', async () => {
    const { fetchFn, calls } = fetchStub({});
    const answer = await readGitlabNamespace(gitlabInput(fetchFn), {
      level: 'instance',
    });
    expect(answer.status).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('readGitlabScopeRunners', () => {
  it('lists one page of runners under a group id, which is the permission a registration needs', async () => {
    const { fetchFn, calls } = fetchStub({
      '/groups/7/runners': { status: 200, body: [] },
    });
    const answer = await readGitlabScopeRunners(
      gitlabInput(fetchFn),
      { level: 'group', target: 'infra/ci' },
      7,
    );
    expect(answer.status).toBe(200);
    expect(calls[0].url).toBe(
      'https://git.example.com/api/v4/groups/7/runners?per_page=1',
    );
  });

  it('lists one page of runners under a project id', async () => {
    const { fetchFn, calls } = fetchStub({
      '/projects/9/runners': {
        status: 403,
        body: { message: '403 Forbidden' },
      },
    });
    const answer = await readGitlabScopeRunners(
      gitlabInput(fetchFn),
      { level: 'project', target: 'infra/ci/web' },
      9,
    );
    expect(answer.status).toBe(403);
    expect(calls[0].url).toBe(
      'https://git.example.com/api/v4/projects/9/runners?per_page=1',
    );
  });
});
