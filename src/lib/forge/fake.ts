import type { ForgeKind, Scope } from '../config/index.js';
import type {
  ForgeClient,
  ForgeRunner,
  ForgeRunnerManager,
  RegistrationRequest,
  RunnerRegistration,
} from './types.js';
import { ForgeError } from './types.js';

type FakeMethod = 'createRegistration' | 'listRunners' | 'deleteRunner';

export interface DeletedRunner {
  scope: Scope;
  id: string;
}

export interface FakeForgeClientOptions {
  kind?: ForgeKind;
  sharedRegistration?: boolean;
}

function scopeLabel(scope: Scope): string {
  return 'target' in scope ? scope.target : scope.level;
}

export class FakeForgeClient implements ForgeClient {
  readonly kind: ForgeKind;
  readonly name: string;
  readonly sharedRegistration: boolean;
  readonly registrations: RegistrationRequest[] = [];
  // The scope rides along, so a test can assert where a delete landed and not
  // only that one happened. Deleting at the wrong scope is unrecoverable.
  readonly deleted: DeletedRunner[] = [];
  readonly scopesListed: Scope[] = [];

  private runners: ForgeRunner[] = [];
  private readonly failures = new Map<FakeMethod, string>();
  private minted = 0;

  constructor(name = 'fake-forge', options: FakeForgeClientOptions = {}) {
    this.name = name;
    this.kind = options.kind ?? 'github';
    this.sharedRegistration = options.sharedRegistration ?? false;
  }

  setRunners(runners: ForgeRunner[]): this {
    this.runners = [...runners];
    return this;
  }

  addRunner(runner: Partial<ForgeRunner> & { name: string }): this {
    this.runners.push({
      id: runner.id ?? String(this.runners.length + 1),
      name: runner.name,
      status: runner.status ?? 'online',
      busy: runner.busy ?? false,
      labels: runner.labels ?? [],
      ...(runner.managers === undefined ? {} : { managers: runner.managers }),
    });
    return this;
  }

  addManager(
    runnerId: string,
    manager: Partial<ForgeRunnerManager> & { systemId: string },
  ): this {
    const entity = this.runners.find((runner) => runner.id === runnerId);
    if (entity === undefined) {
      throw new Error(`no runner ${runnerId} to attach a manager to`);
    }
    entity.managers = [
      ...(entity.managers ?? []),
      {
        systemId: manager.systemId,
        status: manager.status ?? 'online',
        busy: manager.busy ?? false,
        ...(manager.contactedAt === undefined
          ? {}
          : { contactedAt: manager.contactedAt }),
        ...(manager.version === undefined ? {} : { version: manager.version }),
        ...(manager.ipAddress === undefined
          ? {}
          : { ipAddress: manager.ipAddress }),
      },
    ];
    return this;
  }

  failOn(method: FakeMethod, message: string): this {
    this.failures.set(method, message);
    return this;
  }

  private guard(method: FakeMethod): void {
    const message = this.failures.get(method);
    if (message !== undefined) {
      throw new ForgeError(message, { forge: this.name });
    }
  }

  async createRegistration(
    request: RegistrationRequest,
  ): Promise<RunnerRegistration> {
    this.guard('createRegistration');
    this.registrations.push(request);

    if (!this.sharedRegistration) {
      this.minted += 1;
      return {
        token: `fake-registration-token-${this.minted}`,
        url: `https://forge.test/${scopeLabel(request.scope)}`,
      };
    }

    // GitLab mints a new entity on every POST. Reusing one is grove's job,
    // through the row it stores, so the fake never does it here.
    this.minted += 1;
    const runnerId = String(100 + this.minted);
    this.runners.push({
      id: runnerId,
      name: request.name,
      status: 'online',
      busy: false,
      labels: request.tags ?? [],
      managers: [],
    });
    return {
      token: `fake-registration-token-${this.minted}`,
      url: `https://forge.test/${scopeLabel(request.scope)}`,
      runnerId,
    };
  }

  async listRunners(scope: Scope): Promise<ForgeRunner[]> {
    this.guard('listRunners');
    this.scopesListed.push(scope);
    return this.runners.map((runner) => ({
      ...runner,
      ...(runner.managers === undefined
        ? {}
        : { managers: runner.managers.map((manager) => ({ ...manager })) }),
    }));
  }

  async deleteRunner(scope: Scope, id: string): Promise<void> {
    this.guard('deleteRunner');
    this.runners = this.runners.filter((runner) => runner.id !== id);
    this.deleted.push({ scope, id });
  }
}
