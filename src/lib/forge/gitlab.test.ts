import { describe, expect, it } from 'vitest';
import type { Scope } from '../config/index.js';
import { GITLAB_MAX_PAGES, GitlabClient } from './gitlab.js';

// Built at runtime so no fixture in this repo ever looks like a real secret.
const TOKEN = ['glpat', 'A1b2C3d4E5f6G7h8I9j0'].join('-');
const RUNNER_TOKEN = ['glrt', 'K1l2M3n4O5p6Q7r8S9t0'].join('-');

const INSTANCE: Scope = { level: 'instance' };
const GROUP: Scope = { level: 'group', target: 'infra/ci' };

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
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
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
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
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function client(fetchFn: typeof fetch, perPage = 100): GitlabClient {
  return new GitlabClient({
    name: 'gl-chevro',
    url: 'https://git.chevro.fr',
    token: TOKEN,
    fetchFn,
    perPage,
  });
}

function bodyOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(call.body ?? '{}') as Record<string, unknown>;
}

describe('GitlabClient.createRegistration', () => {
  it('creates an instance runner and returns the entity id and the token', async () => {
    const { fetchFn, calls } = fakeFetch([
      json(
        { id: 48, token: RUNNER_TOKEN, token_expires_at: null },
        {
          status: 201,
        },
      ),
    ]);
    const registration = await client(fetchFn).createRegistration({
      scope: INSTANCE,
      group: 'chevro-dind',
      name: 'grove-chevro-dind',
      labels: [],
      tags: ['docker', 'dind'],
    });

    expect(calls[0].url).toBe('https://git.chevro.fr/api/v4/user/runners');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['private-token']).toBe(TOKEN);
    expect(bodyOf(calls[0])).toEqual({
      runner_type: 'instance_type',
      description: 'grove-chevro-dind',
      paused: false,
      locked: false,
      run_untagged: false,
      tag_list: 'docker,dind',
    });
    expect(registration).toEqual({
      token: RUNNER_TOKEN,
      url: 'https://git.chevro.fr',
      runnerId: '48',
    });
  });

  it('runs untagged when the group declares no tag', async () => {
    const { fetchFn, calls } = fakeFetch([
      json({ id: 7, token: RUNNER_TOKEN }, { status: 201 }),
    ]);
    await client(fetchFn).createRegistration({
      scope: INSTANCE,
      group: 'plain',
      name: 'grove-plain',
      labels: [],
      tags: [],
    });
    expect(bodyOf(calls[0]).run_untagged).toBe(true);
    expect(bodyOf(calls[0]).tag_list).toBeUndefined();
  });

  it('resolves the numeric group id before creating a group runner', async () => {
    const { fetchFn, calls } = fakeFetch([
      json({ id: 12, full_path: 'infra/ci' }),
      json({ id: 49, token: RUNNER_TOKEN }, { status: 201 }),
    ]);
    await client(fetchFn).createRegistration({
      scope: GROUP,
      group: 'chevro-dind',
      name: 'grove-chevro-dind',
      labels: [],
      tags: [],
    });

    expect(calls[0].url).toBe('https://git.chevro.fr/api/v4/groups/infra%2Fci');
    expect(bodyOf(calls[1])).toMatchObject({
      runner_type: 'group_type',
      group_id: 12,
    });
  });

  it('refuses a response with no token rather than starting a runner', async () => {
    const { fetchFn } = fakeFetch([json({ id: 5 }, { status: 201 })]);
    await expect(
      client(fetchFn).createRegistration({
        scope: INSTANCE,
        group: 'plain',
        name: 'grove-plain',
        labels: [],
      }),
    ).rejects.toThrow('returned no runner token');
  });

  it('names the administrator requirement on a 403 at instance level', async () => {
    const { fetchFn } = fakeFetch([
      json({ message: '403 Forbidden' }, { status: 403 }),
    ]);
    await expect(
      client(fetchFn).createRegistration({
        scope: INSTANCE,
        group: 'plain',
        name: 'grove-plain',
        labels: [],
      }),
    ).rejects.toThrow(/instance administrator/);
  });

  it('never puts the token in the error it throws', async () => {
    const { fetchFn } = fakeFetch([json({ message: 'nope' }, { status: 401 })]);
    const error = await client(fetchFn)
      .createRegistration({
        scope: INSTANCE,
        group: 'plain',
        name: 'grove-plain',
        labels: [],
      })
      .catch((thrown: Error) => thrown);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).toContain('personal access token');
  });
});

describe('GitlabClient.listRunners', () => {
  it('walks pages until GitLab stops naming a next one', async () => {
    const { fetchFn, calls } = fakeFetch([
      json([{ id: 1, description: 'other-1', status: 'online' }], {
        headers: { 'x-next-page': '2' },
      }),
      json([{ id: 2, description: 'other-2', status: 'offline' }], {
        headers: { 'x-next-page': '' },
      }),
    ]);
    const runners = await client(fetchFn, 100).listRunners(INSTANCE);

    expect(calls.map((call) => call.url)).toEqual([
      'https://git.chevro.fr/api/v4/runners/all?type=instance_type&per_page=100&page=1',
      'https://git.chevro.fr/api/v4/runners/all?type=instance_type&per_page=100&page=2',
    ]);
    expect(runners).toEqual([
      { id: '1', name: 'other-1', status: 'online', busy: false, labels: [] },
      { id: '2', name: 'other-2', status: 'offline', busy: false, labels: [] },
    ]);
  });

  it('skips an entry whose id is neither a string nor a number', async () => {
    const { fetchFn, calls } = fakeFetch([
      json(
        [
          { description: 'grove-chevro-dind', status: 'online' },
          { id: null, description: 'grove-other', status: 'online' },
          { id: { nested: 1 }, description: 'grove-third', status: 'online' },
          { id: '7', description: 'other-7', status: 'online' },
        ],
        { headers: { 'x-next-page': '' } },
      ),
    ]);
    const runners = await client(fetchFn).listRunners(INSTANCE);

    // A malformed entry never becomes the id "undefined", so grove never
    // spends a GET /runners/undefined that 404s and fails the whole listing.
    expect(runners).toEqual([
      { id: '7', name: 'other-7', status: 'online', busy: false, labels: [] },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('clamps per_page to the range GitLab accepts', async () => {
    for (const [asked, sent] of [
      [0, 1],
      [-5, 1],
      [250, 100],
      [50, 50],
    ] as const) {
      const { fetchFn, calls } = fakeFetch([
        json([], { headers: { 'x-next-page': '' } }),
      ]);
      await client(fetchFn, asked).listRunners(INSTANCE);
      expect(calls[0].url).toContain(`per_page=${sent}`);
    }
  });

  it('reads tags and managers only for an entity grove named', async () => {
    const { fetchFn, calls } = fakeFetch([
      json(
        [
          { id: 48, description: 'grove-chevro-dind', status: 'online' },
          { id: 90, description: 'somebody-else', status: 'online' },
        ],
        { headers: { 'x-next-page': '' } },
      ),
      json({ id: 48, tag_list: ['docker', 'dind'] }),
      json([
        {
          id: 1,
          system_id: 's_aaaaaaaaaaaa',
          status: 'online',
          contacted_at: '2026-08-16T10:00:00Z',
          version: '19.2.2',
          ip_address: '10.0.0.4',
          job_execution_status: 'active',
        },
        { id: 2, system_id: 'r_bbbbbbbbbbbb', status: 'stale' },
      ]),
    ]);
    const runners = await client(fetchFn).listRunners(INSTANCE);

    expect(calls.map((call) => call.url).slice(1)).toEqual([
      'https://git.chevro.fr/api/v4/runners/48',
      'https://git.chevro.fr/api/v4/runners/48/managers',
    ]);
    expect(runners[0]).toEqual({
      id: '48',
      name: 'grove-chevro-dind',
      status: 'online',
      busy: false,
      labels: ['docker', 'dind'],
      managers: [
        {
          systemId: 's_aaaaaaaaaaaa',
          status: 'online',
          busy: true,
          contactedAt: '2026-08-16T10:00:00Z',
          version: '19.2.2',
          ipAddress: '10.0.0.4',
        },
        { systemId: 'r_bbbbbbbbbbbb', status: 'stale', busy: false },
      ],
    });
    expect(runners[1].managers).toBeUndefined();
  });

  it('lists a group scope through the group endpoint, resolving the id once', async () => {
    const { fetchFn, calls } = fakeFetch([
      json({ id: 12, full_path: 'infra/ci' }),
      json([], { headers: { 'x-next-page': '' } }),
      json([], { headers: { 'x-next-page': '' } }),
    ]);
    const gitlab = client(fetchFn);
    await gitlab.listRunners(GROUP);
    await gitlab.listRunners(GROUP);

    expect(calls.map((call) => call.url)).toEqual([
      'https://git.chevro.fr/api/v4/groups/infra%2Fci',
      'https://git.chevro.fr/api/v4/groups/12/runners?type=group_type&per_page=100&page=1',
      'https://git.chevro.fr/api/v4/groups/12/runners?type=group_type&per_page=100&page=1',
    ]);
  });

  it('stops rather than walking pages forever', async () => {
    const pages = Array.from({ length: GITLAB_MAX_PAGES }, () =>
      json([{ id: 1, description: 'x' }], { headers: { 'x-next-page': '9' } }),
    );
    const { fetchFn } = fakeFetch(pages);
    await expect(client(fetchFn).listRunners(INSTANCE)).rejects.toThrow(
      `stopped after ${GITLAB_MAX_PAGES} pages`,
    );
  });

  it('reports a rate limit with the reset the response named', async () => {
    const { fetchFn } = fakeFetch([
      json(
        { message: 'Too many requests' },
        {
          status: 429,
          headers: { 'ratelimit-remaining': '0', 'retry-after': '60' },
        },
      ),
    ]);
    await expect(client(fetchFn).listRunners(INSTANCE)).rejects.toThrow(
      'Retry after 60 seconds',
    );
  });
});

describe('GitlabClient.deleteRunner', () => {
  it('deletes the entity by id', async () => {
    const { fetchFn, calls } = fakeFetch([new Response(null, { status: 204 })]);
    await client(fetchFn).deleteRunner(INSTANCE, '48');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('https://git.chevro.fr/api/v4/runners/48');
  });

  it('treats an entity that is already gone as the state grove asked for', async () => {
    const { fetchFn } = fakeFetch([
      json({ message: '404 Not found' }, { status: 404 }),
    ]);
    await expect(
      client(fetchFn).deleteRunner(INSTANCE, '48'),
    ).resolves.toBeUndefined();
  });
});

describe('GitlabClient shape', () => {
  it('registers once per group and says so', () => {
    const { fetchFn } = fakeFetch([]);
    const gitlab = client(fetchFn);
    expect(gitlab.kind).toBe('gitlab');
    expect(gitlab.sharedRegistration).toBe(true);
    expect(gitlab.name).toBe('gl-chevro');
  });
});
