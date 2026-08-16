import { describe, expect, it } from 'vitest';
import type { Scope } from '../config/index.js';
import { GithubClient, MAX_RUNNER_PAGES } from './github.js';

const TOKEN = ['ghp', '0123456789abcdefghij'].join('_');
const ORG: Scope = { level: 'organization', target: 'Overload-coach' };

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function fakeFetch(responses: Response[]): {
  fetchFn: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`no fake response left for ${String(input)}`);
    }
    return next;
  }) as typeof fetch;
  return { fetchFn, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

function client(fetchFn: typeof fetch, perPage = 100): GithubClient {
  return new GithubClient({
    name: 'gh-overload',
    token: TOKEN,
    fetchFn,
    perPage,
  });
}

describe('GithubClient.createRegistration', () => {
  it('posts to the registration-token endpoint for the level', async () => {
    const { fetchFn, calls } = fakeFetch([
      json(
        { token: 'AABBCC', expires_at: '2026-08-16T12:00:00Z' },
        { status: 201 },
      ),
    ]);
    const registration = await client(fetchFn).createRegistration({
      scope: ORG,
      group: 'overload-arm',
      name: 'grove-overload-arm-1',
      labels: ['arm64'],
    });

    expect(registration).toEqual({
      token: 'AABBCC',
      url: 'https://github.com/Overload-coach',
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/orgs/Overload-coach/actions/runners/registration-token',
      method: 'POST',
    });
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].headers.accept).toBe('application/vnd.github+json');
    expect(calls[0].headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('uses the repository endpoint for a repository scope', async () => {
    const { fetchFn, calls } = fakeFetch([
      json({ token: 'A' }, { status: 201 }),
    ]);
    await client(fetchFn).createRegistration({
      scope: { level: 'repository', target: 'Overload-coach/api' },
      group: 'api',
      name: 'grove-api-1',
      labels: [],
    });
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/Overload-coach/api/actions/runners/registration-token',
    );
  });
});

describe('GithubClient.listRunners', () => {
  it('flattens labels and follows pagination', async () => {
    const { fetchFn, calls } = fakeFetch([
      json({
        total_count: 3,
        runners: [
          {
            id: 11,
            name: 'grove-overload-arm-1',
            status: 'online',
            busy: true,
            labels: [{ name: 'self-hosted' }, { name: 'arm64' }],
          },
          {
            id: 12,
            name: 'grove-overload-arm-2',
            status: 'offline',
            busy: false,
            labels: [],
          },
        ],
      }),
      json({
        total_count: 3,
        runners: [
          {
            id: 13,
            name: 'someone-else',
            status: 'online',
            busy: false,
            labels: [],
          },
        ],
      }),
    ]);

    const runners = await client(fetchFn, 2).listRunners(ORG);

    expect(runners).toEqual([
      {
        id: '11',
        name: 'grove-overload-arm-1',
        status: 'online',
        busy: true,
        labels: ['self-hosted', 'arm64'],
      },
      {
        id: '12',
        name: 'grove-overload-arm-2',
        status: 'offline',
        busy: false,
        labels: [],
      },
      {
        id: '13',
        name: 'someone-else',
        status: 'online',
        busy: false,
        labels: [],
      },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/orgs/Overload-coach/actions/runners?per_page=2&page=1',
      'https://api.github.com/orgs/Overload-coach/actions/runners?per_page=2&page=2',
    ]);
  });

  it('asks for at most 100 per page, whatever it was given', async () => {
    const { fetchFn, calls } = fakeFetch([
      json({ total_count: 0, runners: [] }),
    ]);
    await client(fetchFn, 500).listRunners(ORG);
    expect(calls[0].url).toContain('per_page=100');
  });

  it('gives up rather than paging forever on a forge that ignores page', async () => {
    const page = () =>
      json({
        total_count: 2,
        runners: [
          { id: 1, name: 'a', status: 'online', busy: false, labels: [] },
          { id: 2, name: 'b', status: 'online', busy: false, labels: [] },
        ],
      });
    const { fetchFn } = fakeFetch(
      Array.from({ length: MAX_RUNNER_PAGES + 1 }, page),
    );

    await expect(client(fetchFn, 2).listRunners(ORG)).rejects.toThrow(
      /stopped after 1000 pages/,
    );
  });

  it('stops after a short page', async () => {
    const { fetchFn, calls } = fakeFetch([
      json({
        total_count: 1,
        runners: [
          { id: 1, name: 'a', status: 'online', busy: false, labels: [] },
        ],
      }),
    ]);
    await client(fetchFn, 100).listRunners(ORG);
    expect(calls).toHaveLength(1);
  });
});

describe('GithubClient.deleteRunner', () => {
  it('deletes by id', async () => {
    const { fetchFn, calls } = fakeFetch([new Response(null, { status: 204 })]);
    await client(fetchFn).deleteRunner(ORG, '11');
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/orgs/Overload-coach/actions/runners/11',
      method: 'DELETE',
    });
  });

  it('treats a runner that is already gone as deleted', async () => {
    const { fetchFn } = fakeFetch([
      json({ message: 'Not Found' }, { status: 404 }),
    ]);
    await expect(
      client(fetchFn).deleteRunner(ORG, '11'),
    ).resolves.toBeUndefined();
  });
});

describe('GithubClient error reporting', () => {
  it('names the status and the GitHub message', async () => {
    const { fetchFn } = fakeFetch([
      json(
        { message: 'Resource not accessible by personal access token' },
        { status: 403 },
      ),
    ]);
    await expect(client(fetchFn).listRunners(ORG)).rejects.toThrow(
      /returned 403: Resource not accessible by personal access token/,
    );
  });

  it('says so when the rate limit is exhausted', async () => {
    const { fetchFn } = fakeFetch([
      json(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1755345600',
          },
        },
      ),
    ]);
    await expect(client(fetchFn).listRunners(ORG)).rejects.toThrow(
      /rate limit is exhausted, it resets at 2025-08-16T12:00:00.000Z/,
    );
  });

  it('wraps a transport failure', async () => {
    const fetchFn = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as typeof fetch;
    await expect(client(fetchFn).listRunners(ORG)).rejects.toThrow(
      /ENOTFOUND api.github.com/,
    );
  });
});
