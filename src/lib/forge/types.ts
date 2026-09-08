import type { ForgeKind, Scope } from '../config/index.js';

// One running gitlab-runner process attached to a runner entity. The managers
// endpoint exposes no name, so `systemId` is the only field that tells two
// managers of the same entity apart.
export interface ForgeRunnerManager {
  systemId: string;
  // GitLab answers online, offline, stale or never_contacted. The raw string
  // travels, because "stale" and "offline" mean different things to a reader.
  status: string;
  busy: boolean;
  contactedAt?: string;
  version?: string;
  ipAddress?: string;
}

// One job waiting for a runner. `labels` carries GitHub labels and GitLab
// tags alike, because both answer the same question: which runner may take
// this job.
export interface QueuedJob {
  // owner/repo on GitHub, the full namespace path on GitLab.
  project: string;
  name: string;
  labels: string[];
  queuedAt: number;
  url: string;
}

export interface QueueSweepOptions {
  // Epoch milliseconds. A repository or project untouched since then is not
  // swept, because a job queues after activity.
  activeSince: number;
  // Bounds the sweep's own HTTP calls under the caller's concurrency gate.
  // Absent runs unbounded, which only the fakes and tests do.
  limit?: <T>(task: () => Promise<T>) => Promise<T>;
}

export interface ForgeRunner {
  id: string;
  name: string;
  status: 'online' | 'offline';
  busy: boolean;
  // GitHub labels and GitLab tags both land here, because both answer the
  // same question about one runner: which jobs may it take.
  labels: string[];
  // Set by a forge that runs one entity with many managers, absent otherwise.
  managers?: ForgeRunnerManager[];
}

// What the runner process needs in order to register itself. GitHub mints a
// short-lived registration token per runner and only learns the runner id
// once the process calls home. GitLab creates the entity up front, so it
// fills runnerId and every manager in the group reuses one token.
export interface RunnerRegistration {
  token: string;
  url: string;
  runnerId?: string;
}

export interface RegistrationRequest {
  scope: Scope;
  group: string;
  // The runner name for a per-runner forge, and the entity description for a
  // forge with one entity per group.
  name: string;
  labels: string[];
  // GitLab tags belong to the entity and are set once, at creation.
  tags?: string[];
}

export interface ForgeClient {
  readonly kind: ForgeKind;
  readonly name: string;
  // true when one registration covers every runner in a group.
  readonly sharedRegistration: boolean;
  createRegistration(request: RegistrationRequest): Promise<RunnerRegistration>;
  listRunners(scope: Scope): Promise<ForgeRunner[]>;
  deleteRunner(scope: Scope, id: string): Promise<void>;
  // Absent on a client that cannot enumerate what to sweep. The reader turns
  // that into a note, never a failure.
  listQueuedJobs?(
    scope: Scope,
    options: QueueSweepOptions,
  ): Promise<QueuedJob[]>;
}

export interface ForgeErrorDetails {
  forge: string;
  status?: number;
  rateLimitRemaining?: number;
}

export class ForgeError extends Error {
  readonly forge: string;
  readonly status?: number;
  readonly rateLimitRemaining?: number;

  constructor(message: string, details: ForgeErrorDetails) {
    super(message);
    this.name = 'ForgeError';
    this.forge = details.forge;
    this.status = details.status;
    this.rateLimitRemaining = details.rateLimitRemaining;
  }
}
