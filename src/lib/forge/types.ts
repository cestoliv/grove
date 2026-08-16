import type { ForgeKind, Scope } from '../config/index.js';

export interface ForgeRunner {
  id: string;
  name: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: string[];
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
  name: string;
  labels: string[];
}

export interface ForgeClient {
  readonly kind: ForgeKind;
  readonly name: string;
  // true when one registration covers every runner in a group.
  readonly sharedRegistration: boolean;
  createRegistration(request: RegistrationRequest): Promise<RunnerRegistration>;
  listRunners(scope: Scope): Promise<ForgeRunner[]>;
  deleteRunner(scope: Scope, id: string): Promise<void>;
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
