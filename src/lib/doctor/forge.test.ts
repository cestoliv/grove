import { describe, expect, it } from 'vitest';
import type { ForgeConfig, GroveConfig, Scope } from '../config/index.js';
import type { FetchFn } from '../forge/index.js';
import { forgeScopes, runForgeChecks } from './forge.js';

const GH_TOKEN = ['ghp', '0123456789abcdefghij'].join('_');
const GL_TOKEN = ['glpat', 'abcdefghijklmnopqrst'].join('-');

interface Route {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fetchStub(routes: Record<string, Route>, calls?: string[]): FetchFn {
  return (async (input: unknown) => {
    const url = String(input);
    calls?.push(url);
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
}

const identity = <T>(task: () => Promise<T>): Promise<T> => task();

const GITHUB: ForgeConfig = { kind: 'github' } as ForgeConfig;
const GITLAB: ForgeConfig = {
  kind: 'gitlab',
  url: 'https://git.example.com',
} as ForgeConfig;

function reportsFor(
  context: Partial<Parameters<typeof runForgeChecks>[0]> & {
    fetchFn: FetchFn;
  },
) {
  return runForgeChecks({
    name: 'forge',
    forge: GITHUB,
    scopes: [{ level: 'organization', target: 'Acme' }],
    token: GH_TOKEN,
    limit: identity,
    ...context,
  });
}

function statusOf(
  reports: Awaited<ReturnType<typeof runForgeChecks>>,
  id: string,
) {
  return reports
    .filter((report) => report.id === id)
    .map((report) => report.status);
}

describe('forgeScopes', () => {
  it('lists each forge scope once, however many groups declare it', () => {
    const config = {
      forges: {
        gh: { kind: 'github' },
        gl: { kind: 'gitlab', url: 'https://g' },
      },
      groups: [
        {
          name: 'a',
          forge: 'gh',
          scope: { level: 'organization', target: 'Acme' },
          placement: { mac: 1 },
          stack: 'docker',
        },
        {
          name: 'b',
          forge: 'gh',
          scope: { level: 'organization', target: 'Acme' },
          placement: { mac: 1 },
          stack: 'docker',
        },
        {
          name: 'c',
          forge: 'gl',
          scope: { level: 'instance' },
          placement: { mac: 1 },
          stack: 'docker',
        },
      ],
    } as unknown as GroveConfig;

    const scopes = forgeScopes(config);
    expect(scopes.get('gh')).toEqual([
      { level: 'organization', target: 'Acme' },
    ]);
    expect(scopes.get('gl')).toEqual([{ level: 'instance' }]);
  });
});

describe('runForgeChecks, GitHub', () => {
  it('passes a token with the right scope and access', async () => {
    const reports = await reportsFor({
      fetchFn: fetchStub({
        '/user': {
          status: 200,
          body: { login: 'ci-bot' },
          headers: { 'x-oauth-scopes': 'repo, admin:org' },
        },
        '/actions/runners': { status: 200, body: { total_count: 2 } },
      }),
    });

    expect(statusOf(reports, 'forge.credential')).toEqual(['ok']);
    expect(statusOf(reports, 'forge.token')).toEqual(['ok']);
    expect(statusOf(reports, 'forge.scopes')).toEqual(['ok']);
    expect(statusOf(reports, 'forge.scope-access')).toEqual(['ok']);
    expect(reports.every((report) => report.target.kind === 'forge')).toBe(
      true,
    );
  });

  it('fails a token the forge rejected, and asks nothing else', async () => {
    const reports = await reportsFor({
      fetchFn: fetchStub({
        '/user': { status: 401, body: { message: 'Bad credentials' } },
      }),
    });

    expect(statusOf(reports, 'forge.token')).toEqual(['fail']);
    expect(statusOf(reports, 'forge.scopes')).toEqual(['skip']);
    expect(statusOf(reports, 'forge.scope-access')).toEqual(['skip']);
    expect(
      reports.find((report) => report.id === 'forge.token')?.fix,
    ).toContain('expired');
  });

  it('names the missing scope for the declared level', async () => {
    const reports = await reportsFor({
      fetchFn: fetchStub({
        '/user': {
          status: 200,
          body: { login: 'ci-bot' },
          headers: { 'x-oauth-scopes': 'repo' },
        },
        '/actions/runners': {
          status: 403,
          body: { message: 'Resource not accessible' },
        },
      }),
    });

    const scopes = reports.find((report) => report.id === 'forge.scopes');
    expect(scopes?.status).toBe('fail');
    expect(scopes?.summary).toContain('manage_runners:org');
    expect(scopes?.fix).toContain('organization level group');
    expect(statusOf(reports, 'forge.scope-access')).toEqual(['fail']);
  });

  it('skips the scope check for a fine-grained token and relies on the read', async () => {
    const reports = await reportsFor({
      fetchFn: fetchStub({
        '/user': { status: 200, body: { login: 'ci-bot' } },
        '/actions/runners': { status: 200, body: { total_count: 0 } },
      }),
    });

    expect(statusOf(reports, 'forge.scopes')).toEqual(['skip']);
    expect(statusOf(reports, 'forge.scope-access')).toEqual(['ok']);
  });

  it('fails the credential and asks the forge nothing at all', async () => {
    let called = 0;
    const fetchFn = (async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as FetchFn;

    const reports = await reportsFor({
      fetchFn,
      token: undefined,
      tokenError:
        'forge "gh": no auth block, and `gh auth token` printed nothing.',
    });

    expect(statusOf(reports, 'forge.credential')).toEqual(['fail']);
    expect(called).toBe(0);
    for (const id of ['forge.token', 'forge.scopes', 'forge.scope-access']) {
      expect(statusOf(reports, id)).toEqual(['skip']);
    }
  });

  it('reports a forge that did not answer at all', async () => {
    const fetchFn = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as unknown as FetchFn;

    const reports = await reportsFor({ fetchFn });
    const token = reports.find((report) => report.id === 'forge.token');
    expect(token?.status).toBe('fail');
    expect(token?.summary).toContain('ENOTFOUND');
  });
});

describe('runForgeChecks, GitLab', () => {
  const GROUP: Scope = { level: 'group', target: 'infra/ci' };

  function gitlabReports(
    routes: Record<string, Route>,
    scope: Scope = { level: 'instance' },
    calls?: string[],
  ) {
    return runForgeChecks({
      name: 'gl',
      forge: GITLAB,
      scopes: [scope],
      token: GL_TOKEN,
      fetchFn: fetchStub(routes, calls),
      limit: identity,
    });
  }

  // Every GitLab run reads the token itself, so the healthy answer lives here
  // rather than in each set of routes.
  const HEALTHY_TOKEN: Record<string, Route> = {
    '/user': { status: 200, body: { username: 'ci', is_admin: false } },
    '/personal_access_tokens/self': {
      status: 200,
      body: { scopes: ['api', 'create_runner'] },
    },
  };

  it('passes an admin token with create_runner and api', async () => {
    const reports = await gitlabReports({
      '/user': { status: 200, body: { username: 'ci', is_admin: true } },
      '/personal_access_tokens/self': {
        status: 200,
        body: { scopes: ['api', 'create_runner'] },
      },
      '/runners/all': { status: 200, body: [] },
    });

    expect(statusOf(reports, 'forge.token')).toEqual(['ok']);
    expect(statusOf(reports, 'forge.scopes')).toEqual(['ok']);
    expect(statusOf(reports, 'forge.admin')).toEqual(['ok']);
    expect(statusOf(reports, 'forge.scope-access')).toEqual(['ok']);
  });

  it('fails an instance level scope on a token that is not an administrator', async () => {
    const reports = await gitlabReports({
      '/user': { status: 200, body: { username: 'ci', is_admin: false } },
      '/personal_access_tokens/self': {
        status: 200,
        body: { scopes: ['api', 'create_runner'] },
      },
      '/runners/all': { status: 403, body: { message: '403 Forbidden' } },
    });

    const admin = reports.find((report) => report.id === 'forge.admin');
    expect(admin?.status).toBe('fail');
    expect(admin?.fix).toContain('administrator');
  });

  it('names create_runner when the token does not carry it', async () => {
    const reports = await gitlabReports({
      '/user': { status: 200, body: { username: 'ci', is_admin: true } },
      '/personal_access_tokens/self': {
        status: 200,
        body: { scopes: ['api'] },
      },
      '/runners/all': { status: 200, body: [] },
    });

    const scopes = reports.find((report) => report.id === 'forge.scopes');
    expect(scopes?.status).toBe('fail');
    expect(scopes?.summary).toContain('create_runner');
  });

  it('skips the scope check on a GitLab too old to answer for the token', async () => {
    const reports = await gitlabReports({
      '/user': { status: 200, body: { username: 'ci', is_admin: true } },
      '/personal_access_tokens/self': { status: 404 },
      '/runners/all': { status: 200, body: [] },
    });

    expect(statusOf(reports, 'forge.scopes')).toEqual(['skip']);
  });

  it('skips the admin check when no instance scope is declared, and lists the group runners', async () => {
    const calls: string[] = [];
    const reports = await gitlabReports(
      {
        ...HEALTHY_TOKEN,
        '/groups/7/runners': { status: 200, body: [] },
        '/groups/': { status: 200, body: { id: 7 } },
      },
      GROUP,
      calls,
    );

    expect(statusOf(reports, 'forge.admin')).toEqual(['skip']);
    expect(statusOf(reports, 'forge.scope-access')).toEqual(['ok']);
    // The namespace read is only how grove learns the id. The runners list is
    // the proof, so both requests have to happen, in that order.
    expect(calls.at(-2)).toContain('/groups/infra%2Fci');
    expect(calls.at(-1)).toBe(
      'https://git.example.com/api/v4/groups/7/runners?per_page=1',
    );
  });

  it('names the Owner role in the fix when a group scope is refused', async () => {
    const reports = await gitlabReports(
      {
        ...HEALTHY_TOKEN,
        '/groups/': { status: 403, body: { message: '403 Forbidden' } },
      },
      GROUP,
    );

    const access = reports.find((report) => report.id === 'forge.scope-access');
    expect(access?.status).toBe('fail');
    expect(access?.fix).toContain('Owner role');
  });

  it('fails a group whose namespace is visible but whose runners are not', async () => {
    const reports = await gitlabReports(
      {
        ...HEALTHY_TOKEN,
        '/groups/7/runners': {
          status: 403,
          body: { message: '403 Forbidden' },
        },
        '/groups/': { status: 200, body: { id: 7 } },
      },
      GROUP,
    );

    const access = reports.find((report) => report.id === 'forge.scope-access');
    expect(access?.status).toBe('fail');
    expect(access?.summary).toContain('403');
    expect(access?.fix).toContain('Owner role');
    expect(access?.fix).toContain('api scope');
  });

  it('fails a runners list the instance answered 404 for', async () => {
    const reports = await gitlabReports(
      {
        ...HEALTHY_TOKEN,
        '/groups/7/runners': {
          status: 404,
          body: { message: '404 Not Found' },
        },
        '/groups/': { status: 200, body: { id: 7 } },
      },
      GROUP,
    );

    const access = reports.find((report) => report.id === 'forge.scope-access');
    expect(access?.status).toBe('fail');
    expect(access?.fix).toContain('group infra/ci');
    expect(access?.fix).toContain('cannot see');
  });

  it('fails a runners list the instance rejected the token for', async () => {
    const reports = await gitlabReports(
      {
        ...HEALTHY_TOKEN,
        '/groups/7/runners': {
          status: 401,
          body: { message: '401 Unauthorized' },
        },
        '/groups/': { status: 200, body: { id: 7 } },
      },
      GROUP,
    );

    const access = reports.find((report) => report.id === 'forge.scope-access');
    expect(access?.status).toBe('fail');
    expect(access?.fix).toContain('expired');
  });

  it('lists the runners of a project scope by its numeric id', async () => {
    const calls: string[] = [];
    const reports = await gitlabReports(
      {
        ...HEALTHY_TOKEN,
        '/projects/9/runners': { status: 200, body: [] },
        '/projects/': { status: 200, body: { id: 9 } },
      },
      { level: 'project', target: 'infra/ci/web' },
      calls,
    );

    expect(statusOf(reports, 'forge.scope-access')).toEqual(['ok']);
    expect(calls.at(-1)).toBe(
      'https://git.example.com/api/v4/projects/9/runners?per_page=1',
    );
  });

  it('fails a namespace the forge answered without a numeric id', async () => {
    const reports = await gitlabReports(
      { ...HEALTHY_TOKEN, '/groups/': { status: 200, body: { name: 'ci' } } },
      GROUP,
    );

    const access = reports.find((report) => report.id === 'forge.scope-access');
    expect(access?.status).toBe('fail');
    expect(access?.summary).toContain('no numeric id');
    expect(access?.fix).toBeTruthy();
  });

  it('still prints a fix when the status carries no GitLab auth hint', async () => {
    const reports = await gitlabReports(
      {
        ...HEALTHY_TOKEN,
        '/groups/': {
          status: 500,
          body: { message: '500 Internal Server Error' },
        },
      },
      GROUP,
    );

    for (const report of reports.filter((entry) => entry.status === 'fail')) {
      expect(report.fix).toBeTruthy();
    }
  });
});
