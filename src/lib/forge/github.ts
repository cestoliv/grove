import type { Scope } from '../config/index.js';
import { errorMessage } from '../errors.js';
import {
  type GithubEndpoints,
  githubEndpoints,
  registrationUrl,
  runnersPath,
} from './github-scope.js';
import {
  type ForgeClient,
  ForgeError,
  type ForgeRunner,
  type RegistrationRequest,
  type RunnerRegistration,
} from './types.js';

export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_PER_PAGE = 100;

// GitHub caps a page at 100 whatever the caller asks for, so a larger value
// would make the short-page check below end the walk one page early.
const MAX_PER_PAGE = 100;

// A forge that ignores `page` would answer full pages forever. The walk stops
// well past any real fleet and says why, rather than hanging.
export const MAX_RUNNER_PAGES = 1000;

export type FetchFn = typeof fetch;

export interface GithubClientOptions {
  name: string;
  token: string;
  url?: string;
  fetchFn?: FetchFn;
  perPage?: number;
}

interface RegistrationTokenBody {
  token: string;
  expires_at?: string;
}

interface RunnerListBody {
  total_count?: number;
  runners?: Array<{
    id: number | string;
    name: string;
    status?: string;
    busy?: boolean;
    labels?: Array<{ name: string }>;
  }>;
}

function messageFromBody(text: string): string {
  if (text.trim() === '') {
    return '';
  }
  try {
    const body = JSON.parse(text) as { message?: unknown };
    return typeof body.message === 'string' ? `: ${body.message}` : '';
  } catch {
    return `: ${text.trim().slice(0, 200)}`;
  }
}

export class GithubClient implements ForgeClient {
  readonly kind = 'github' as const;
  readonly name: string;
  // GitHub mints one registration token per runner record.
  readonly sharedRegistration = false;

  private readonly endpoints: GithubEndpoints;
  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private readonly perPage: number;

  constructor(options: GithubClientOptions) {
    this.name = options.name;
    this.token = options.token;
    this.endpoints = githubEndpoints(options.url);
    this.fetchFn = options.fetchFn ?? fetch;
    this.perPage = Math.min(options.perPage ?? GITHUB_PER_PAGE, MAX_PER_PAGE);
  }

  async createRegistration(
    request: RegistrationRequest,
  ): Promise<RunnerRegistration> {
    const body = await this.request<RegistrationTokenBody>(
      'POST',
      `${runnersPath(request.scope)}/registration-token`,
    );
    if (body === undefined || typeof body.token !== 'string') {
      throw new ForgeError(
        `forge "${this.name}": the registration-token endpoint returned no token`,
        { forge: this.name },
      );
    }
    return {
      token: body.token,
      url: registrationUrl(this.endpoints.web, request.scope),
    };
  }

  async listRunners(scope: Scope): Promise<ForgeRunner[]> {
    const path = runnersPath(scope);
    const runners: ForgeRunner[] = [];
    for (let page = 1; page <= MAX_RUNNER_PAGES; page += 1) {
      const body = await this.request<RunnerListBody>(
        'GET',
        `${path}?per_page=${this.perPage}&page=${page}`,
      );
      const batch = body?.runners ?? [];
      for (const runner of batch) {
        runners.push({
          id: String(runner.id),
          name: runner.name,
          status: runner.status === 'online' ? 'online' : 'offline',
          busy: runner.busy === true,
          labels: (runner.labels ?? []).map((label) => label.name),
        });
      }
      if (batch.length < this.perPage) {
        return runners;
      }
    }
    throw new ForgeError(
      `forge "${this.name}": listing runners stopped after ${MAX_RUNNER_PAGES} pages`,
      { forge: this.name },
    );
  }

  async deleteRunner(scope: Scope, id: string): Promise<void> {
    try {
      await this.request(
        'DELETE',
        `${runnersPath(scope)}/${encodeURIComponent(id)}`,
      );
    } catch (error) {
      // A runner that is already gone is the state we asked for.
      if (error instanceof ForgeError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  private async request<T>(
    method: string,
    path: string,
  ): Promise<T | undefined> {
    const url = `${this.endpoints.api}${path}`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
      });
    } catch (error) {
      throw new ForgeError(
        `forge "${this.name}": ${method} ${path} failed: ${errorMessage(error)}`,
        { forge: this.name },
      );
    }

    const remainingHeader = response.headers.get('x-ratelimit-remaining');
    const remaining =
      remainingHeader === null ? undefined : Number(remainingHeader);

    if (response.status === 204) {
      return undefined;
    }

    const text = await response.text();
    if (!response.ok) {
      const reset = response.headers.get('x-ratelimit-reset');
      const rate =
        remaining === 0
          ? ` The GitHub rate limit is exhausted, it resets at ${reset === null ? 'an unknown time' : new Date(Number(reset) * 1000).toISOString()}.`
          : '';
      throw new ForgeError(
        `forge "${this.name}": ${method} ${path} returned ${response.status}${messageFromBody(text)}.${rate}`,
        {
          forge: this.name,
          status: response.status,
          rateLimitRemaining: remaining,
        },
      );
    }

    return text.trim() === '' ? undefined : (JSON.parse(text) as T);
  }
}
