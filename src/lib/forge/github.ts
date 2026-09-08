import type { Scope } from '../config/index.js';
import { errorMessage } from '../errors.js';
import {
  type GithubEndpoints,
  githubEndpoints,
  parseRepository,
  registrationUrl,
  runnersPath,
} from './github-scope.js';
import {
  type ForgeClient,
  ForgeError,
  type ForgeRunner,
  type QueuedJob,
  type QueueSweepOptions,
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

interface RepoListBody {
  full_name: string;
  pushed_at?: string;
}

interface RunListBody {
  workflow_runs?: Array<{ id: number | string; created_at?: string }>;
}

interface JobListBody {
  jobs?: Array<{
    name: string;
    status?: string;
    labels?: string[];
    started_at?: string | null;
    html_url?: string;
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

  async listQueuedJobs(
    scope: Scope,
    options: QueueSweepOptions,
  ): Promise<QueuedJob[]> {
    const limit = options.limit ?? (<T>(task: () => Promise<T>) => task());
    const repos = await this.sweepTargets(scope, options.activeSince, limit);
    const found = await Promise.all(
      repos.map((repo) =>
        // One repository's failure, an archived repo or an odd permission,
        // is one repository grove cannot see, never a failed sweep.
        this.queuedJobsIn(repo, limit).catch((error) => {
          if (
            error instanceof ForgeError &&
            (error.status === 403 || error.status === 404)
          ) {
            return [] as QueuedJob[];
          }
          throw error;
        }),
      ),
    );
    return found.flat();
  }

  // GitHub sorts by push date, so the first repository outside the window
  // ends the walk: everything after it is older still.
  private async sweepTargets(
    scope: Scope,
    activeSince: number,
    limit: <T>(task: () => Promise<T>) => Promise<T>,
  ): Promise<string[]> {
    if (scope.level === 'repository') {
      const { owner, repo } = parseRepository(scope.target);
      return [`${owner}/${repo}`];
    }
    if (scope.level !== 'organization') {
      throw new ForgeError(
        `forge "${this.name}": a queue sweep is not supported at enterprise scope, because GitHub lists no repositories for an enterprise`,
        { forge: this.name },
      );
    }
    const org = encodeURIComponent(scope.target);
    const repos: string[] = [];
    for (let page = 1; page <= MAX_RUNNER_PAGES; page += 1) {
      const batch =
        (await limit(() =>
          this.request<RepoListBody[]>(
            'GET',
            `/orgs/${org}/repos?sort=pushed&direction=desc&per_page=${this.perPage}&page=${page}`,
          ),
        )) ?? [];
      for (const repo of batch) {
        const pushed = Date.parse(repo.pushed_at ?? '');
        if (!Number.isFinite(pushed) || pushed < activeSince) {
          return repos;
        }
        repos.push(repo.full_name);
      }
      if (batch.length < this.perPage) {
        return repos;
      }
    }
    return repos;
  }

  private async queuedJobsIn(
    fullName: string,
    limit: <T>(task: () => Promise<T>) => Promise<T>,
  ): Promise<QueuedJob[]> {
    const runs =
      (
        await limit(() =>
          this.request<RunListBody>(
            'GET',
            `/repos/${fullName}/actions/runs?status=queued&per_page=${this.perPage}`,
          ),
        )
      )?.workflow_runs ?? [];
    const perRun = await Promise.all(
      runs.map(async (run) => {
        const body = await limit(() =>
          this.request<JobListBody>(
            'GET',
            `/repos/${fullName}/actions/runs/${run.id}/jobs?per_page=${this.perPage}`,
          ),
        );
        const queuedAt = Date.parse(run.created_at ?? '') || 0;
        return (body?.jobs ?? [])
          .filter((job) => job.status === 'queued')
          .map((job) => ({
            project: fullName,
            name: job.name,
            labels: job.labels ?? [],
            queuedAt: Number.isFinite(Date.parse(job.started_at ?? ''))
              ? Date.parse(job.started_at as string)
              : queuedAt,
            url: job.html_url ?? '',
          }));
      }),
    );
    return perRun.flat();
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
