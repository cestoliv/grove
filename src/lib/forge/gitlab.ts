import type { Scope } from '../config/index.js';
import { errorMessage } from '../errors.js';
import { parseSharedName } from '../naming.js';
import type { FetchFn } from './github.js';
import {
  gitlabApiBase,
  gitlabAuthHint,
  namespacePath,
  runnersListPath,
  runnerTypeFor,
} from './gitlab-scope.js';
import {
  type ForgeClient,
  ForgeError,
  type ForgeRunner,
  type ForgeRunnerManager,
  type RegistrationRequest,
  type RunnerRegistration,
} from './types.js';

export const GITLAB_PER_PAGE = 100;

// GitLab caps a page at 100 whatever the caller asks for, and a page of
// nothing would walk forever.
const MAX_PER_PAGE = 100;
const MIN_PER_PAGE = 1;

// A forge that ignores `page` would answer full pages forever. The walk stops
// well past any real fleet and says why, rather than hanging.
export const GITLAB_MAX_PAGES = 1000;

export interface GitlabClientOptions {
  name: string;
  url: string;
  token: string;
  fetchFn?: FetchFn;
  perPage?: number;
}

interface Answer {
  data: unknown;
  headers: Headers;
}

interface RawRunner {
  id?: unknown;
  description?: unknown;
  status?: unknown;
  job_execution_status?: unknown;
  tag_list?: unknown;
}

interface RawManager {
  system_id?: unknown;
  status?: unknown;
  job_execution_status?: unknown;
  contacted_at?: unknown;
  version?: unknown;
  ip_address?: unknown;
}

function messageFromBody(data: unknown, text: string): string {
  if (data !== null && typeof data === 'object') {
    const body = data as { message?: unknown; error?: unknown };
    if (typeof body.message === 'string') {
      return `: ${body.message}`;
    }
    if (typeof body.error === 'string') {
      return `: ${body.error}`;
    }
  }
  return text.trim() === '' ? '' : `: ${text.trim().slice(0, 200)}`;
}

function toManager(raw: RawManager): ForgeRunnerManager {
  const manager: ForgeRunnerManager = {
    systemId: typeof raw.system_id === 'string' ? raw.system_id : '',
    // GitLab answers online, offline, stale or never_contacted, and the raw
    // word travels because stale and offline are different problems.
    status: typeof raw.status === 'string' ? raw.status : 'offline',
    busy: raw.job_execution_status === 'active',
  };
  if (typeof raw.contacted_at === 'string' && raw.contacted_at !== '') {
    manager.contactedAt = raw.contacted_at;
  }
  if (typeof raw.version === 'string' && raw.version !== '') {
    manager.version = raw.version;
  }
  if (typeof raw.ip_address === 'string' && raw.ip_address !== '') {
    manager.ipAddress = raw.ip_address;
  }
  return manager;
}

export class GitlabClient implements ForgeClient {
  readonly kind = 'gitlab' as const;
  readonly name: string;
  // One entity per group, with one manager per container behind it.
  readonly sharedRegistration = true;

  private readonly api: string;
  private readonly instanceUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private readonly perPage: number;
  // A namespace path never changes its id inside one run, and every runner
  // call in a group scope needs it, so it is resolved once.
  private readonly namespaceIds = new Map<string, number>();

  constructor(options: GitlabClientOptions) {
    this.name = options.name;
    this.token = options.token;
    this.instanceUrl = options.url.replace(/\/+$/, '');
    this.api = gitlabApiBase(options.url);
    this.fetchFn = options.fetchFn ?? fetch;
    this.perPage = Math.min(
      Math.max(options.perPage ?? GITLAB_PER_PAGE, MIN_PER_PAGE),
      MAX_PER_PAGE,
    );
  }

  async createRegistration(
    request: RegistrationRequest,
  ): Promise<RunnerRegistration> {
    const { scope } = request;
    const tags = request.tags ?? [];
    const body: Record<string, unknown> = {
      runner_type: runnerTypeFor(scope),
      description: request.name,
      paused: false,
      locked: false,
      // A tagged runner that also takes untagged jobs surprises people, so
      // grove only leaves untagged jobs on when the group declares no tag.
      run_untagged: tags.length === 0,
    };
    if (tags.length > 0) {
      body.tag_list = tags.join(',');
    }
    if (scope.level === 'group') {
      body.group_id = await this.namespaceId(scope);
    }
    if (scope.level === 'project') {
      body.project_id = await this.namespaceId(scope);
    }

    const { data } = await this.send('POST', '/user/runners', scope, body);
    const created = (data ?? {}) as { id?: unknown; token?: unknown };
    if (typeof created.token !== 'string' || created.token === '') {
      throw new ForgeError(
        `forge "${this.name}": POST /user/runners returned no runner token`,
        { forge: this.name },
      );
    }
    if (created.id === undefined || created.id === null) {
      throw new ForgeError(
        `forge "${this.name}": POST /user/runners returned no runner id`,
        { forge: this.name },
      );
    }
    return {
      token: created.token,
      url: this.instanceUrl,
      runnerId: String(created.id),
    };
  }

  async listRunners(scope: Scope): Promise<ForgeRunner[]> {
    const namespaceId =
      scope.level === 'instance' ? undefined : await this.namespaceId(scope);
    const path = runnersListPath(scope, namespaceId);
    const type = runnerTypeFor(scope);

    const raw: RawRunner[] = [];
    let walked = false;
    for (let page = 1; page <= GITLAB_MAX_PAGES; page += 1) {
      const { data, headers } = await this.send(
        'GET',
        `${path}?type=${type}&per_page=${this.perPage}&page=${page}`,
        scope,
      );
      if (Array.isArray(data)) {
        raw.push(...(data as RawRunner[]));
      }
      const next = headers.get('x-next-page');
      if (next === null || next.trim() === '') {
        walked = true;
        break;
      }
    }
    if (!walked) {
      throw new ForgeError(
        `forge "${this.name}": listing runners stopped after ${GITLAB_MAX_PAGES} pages`,
        { forge: this.name },
      );
    }

    const runners: ForgeRunner[] = [];
    for (const entity of raw) {
      // An entry with no usable id would become the string "undefined", and
      // grove would spend a GET on it. Skipping is silence, never deletion.
      if (typeof entity.id !== 'string' && typeof entity.id !== 'number') {
        continue;
      }
      const id = String(entity.id);
      const name =
        typeof entity.description === 'string' ? entity.description : '';
      const runner: ForgeRunner = {
        id,
        name,
        status: entity.status === 'online' ? 'online' : 'offline',
        busy: entity.job_execution_status === 'active',
        labels: [],
      };
      // The list endpoint carries no tags and no managers. Two more calls are
      // worth it for an entity grove named, and worth nothing for one it did
      // not, so a fleet full of other people's runners costs one call.
      if (parseSharedName(name) !== null) {
        runner.labels = await this.tagsFor(id, scope);
        runner.managers = await this.managersFor(id, scope);
      }
      runners.push(runner);
    }
    return runners;
  }

  async deleteRunner(scope: Scope, id: string): Promise<void> {
    try {
      await this.send('DELETE', `/runners/${encodeURIComponent(id)}`, scope);
    } catch (error) {
      // A runner that is already gone is the state grove asked for.
      if (error instanceof ForgeError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  private async tagsFor(id: string, scope: Scope): Promise<string[]> {
    const { data } = await this.send(
      'GET',
      `/runners/${encodeURIComponent(id)}`,
      scope,
    );
    const detail = (data ?? {}) as RawRunner;
    return Array.isArray(detail.tag_list)
      ? detail.tag_list.map((tag) => String(tag))
      : [];
  }

  private async managersFor(
    id: string,
    scope: Scope,
  ): Promise<ForgeRunnerManager[]> {
    const { data } = await this.send(
      'GET',
      `/runners/${encodeURIComponent(id)}/managers`,
      scope,
    );
    return Array.isArray(data) ? (data as RawManager[]).map(toManager) : [];
  }

  private async namespaceId(scope: Scope): Promise<number> {
    const path = namespacePath(scope);
    if (path === undefined) {
      throw new Error(`scope level "${scope.level}" has no namespace to read`);
    }
    const cached = this.namespaceIds.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const { data } = await this.send('GET', path, scope);
    const id = Number((data as { id?: unknown } | null)?.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ForgeError(
        `forge "${this.name}": GET ${path} returned no numeric id`,
        { forge: this.name },
      );
    }
    this.namespaceIds.set(path, id);
    return id;
  }

  private async send(
    method: string,
    path: string,
    scope: Scope,
    body?: Record<string, unknown>,
  ): Promise<Answer> {
    const url = `${this.api}${path}`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers: {
          Accept: 'application/json',
          'PRIVATE-TOKEN': this.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ForgeError(
        `forge "${this.name}": ${method} ${path} failed: ${errorMessage(error)}`,
        { forge: this.name },
      );
    }

    const remainingHeader = response.headers.get('ratelimit-remaining');
    const remaining =
      remainingHeader === null ? undefined : Number(remainingHeader);

    if (response.status === 204) {
      return { data: undefined, headers: response.headers };
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = text.trim() === '' ? undefined : JSON.parse(text);
    } catch {
      data = undefined;
    }

    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const rate =
        response.status === 429
          ? ` GitLab rate limited this request.${retryAfter === null ? '' : ` Retry after ${retryAfter} seconds.`}`
          : '';
      throw new ForgeError(
        `forge "${this.name}": ${method} ${path} returned ${response.status}${messageFromBody(data, text)}.${gitlabAuthHint(response.status, scope)}${rate}`,
        {
          forge: this.name,
          status: response.status,
          ...(remaining === undefined ? {} : { rateLimitRemaining: remaining }),
        },
      );
    }

    return { data, headers: response.headers };
  }
}
