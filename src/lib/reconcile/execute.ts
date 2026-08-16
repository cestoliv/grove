import type { GroupConfig, GroveConfig } from '../config/index.js';
import { errorMessage } from '../errors.js';
import type { ForgeClient, RunnerRegistration } from '../forge/index.js';
import { parseManagedName, sharedRunnerName } from '../naming.js';
import {
  buildGitlabRunnerSpec,
  buildRunnerDirs,
  buildRunnerSpec,
  type DockerStack,
} from '../stack/index.js';
import type { RunnerRecord, StateStore } from '../state/index.js';
import { type Action, describeAction, isReport } from './actions.js';
import { createLimiter, type Limiter } from './limiter.js';
import type { HostObservation, ObservedState } from './observed.js';
import { groupForgeKey } from './shared.js';

export const FORGE_CONCURRENCY = 4;

export interface ExecuteOptions {
  config: GroveConfig;
  hosts: ReadonlyMap<string, HostObservation>;
  stacks: ReadonlyMap<string, DockerStack>;
  forgeClients: ReadonlyMap<string, ForgeClient>;
  store: StateStore;
  log?: (line: string) => void;
  forgeConcurrency?: number;
  // Wipe the work dir before starting an existing container.
  clean?: boolean;
  // Skip the drain wait.
  force?: boolean;
}

export interface ActionFailure {
  action: Action;
  error: string;
}

export interface ExecutionResult {
  applied: Action[];
  failed: ActionFailure[];
  skipped: Action[];
}

interface Runtime extends ExecuteOptions {
  limiter: Limiter;
  // One mint per group and forge, even when the group's seats sit on two
  // hosts and therefore run in two parallel buckets.
  sharedRegistrations: Map<string, Promise<RunnerRegistration>>;
}

function groupFor(config: GroveConfig, name: string): GroupConfig {
  const group = config.groups.find((entry) => entry.name === name);
  if (group === undefined) {
    throw new Error(`group "${name}" is no longer in the config`);
  }
  return group;
}

function stackFor(runtime: Runtime, host: string): DockerStack {
  const stack = runtime.stacks.get(host);
  if (stack === undefined) {
    throw new Error(`no Docker stack was opened for host "${host}"`);
  }
  return stack;
}

function clientFor(runtime: Runtime, forge: string): ForgeClient {
  const client = runtime.forgeClients.get(forge);
  if (client === undefined) {
    throw new Error(`no client was built for forge "${forge}"`);
  }
  return client;
}

async function mintSharedRegistration(
  action: Extract<Action, { kind: 'create-runner' }>,
  group: GroupConfig,
  client: ForgeClient,
  runtime: Runtime,
): Promise<RunnerRegistration> {
  const existing = runtime.store.findActiveGroupRegistration(
    action.group,
    action.forge,
  );
  // Only the row the planner looked at may be retired. Another process may
  // have minted a fresh one between plan and apply, and its token is live.
  const renewing =
    existing !== undefined &&
    action.renewRegistration !== undefined &&
    existing.forgeRunnerId === action.renewRegistration;
  if (existing !== undefined && !renewing) {
    // GitLab never shows the token again, so the stored row is the only
    // place a second manager can get it from.
    return {
      token: existing.token,
      url: existing.url,
      runnerId: existing.forgeRunnerId,
    };
  }
  if (existing !== undefined) {
    // The entity behind this row is gone at the forge, so its token is dead.
    runtime.store.retireGroupRegistration(existing.id);
  }

  const registration = await runtime.limiter(() =>
    client.createRegistration({
      scope: group.scope,
      group: group.name,
      // The entity describes the whole group, so it carries no index.
      name: sharedRunnerName(group.name),
      labels: group.labels ?? [],
      tags: group.tags ?? [],
    }),
  );
  const runnerId = registration.runnerId;
  if (runnerId === undefined) {
    throw new Error(
      `forge "${action.forge}" registers once per group but returned no runner id for group "${action.group}"`,
    );
  }
  try {
    runtime.store.createGroupRegistration({
      group: action.group,
      forge: action.forge,
      forgeRunnerId: runnerId,
      url: registration.url,
      token: registration.token,
    });
  } catch (error) {
    // The entity exists at the forge and no row holds its token, so nothing
    // will ever reach it again. Take it back down rather than leave a runner
    // grove cannot manage.
    try {
      await runtime.limiter(() => client.deleteRunner(group.scope, runnerId));
    } catch {
      // The delete is best effort. The write that failed is what the
      // operator has to see, so the original error is the one that travels.
    }
    throw error;
  }
  return registration;
}

// The first seat of a group decides, and the rest await its promise. The
// planner reads `renewRegistration` from the state of the whole group, so
// every seat of one group carries the same value and the winner does not
// matter.
function sharedRegistrationFor(
  action: Extract<Action, { kind: 'create-runner' }>,
  group: GroupConfig,
  client: ForgeClient,
  runtime: Runtime,
): Promise<RunnerRegistration> {
  const key = groupForgeKey(action.group, action.forge);
  const pending = runtime.sharedRegistrations.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const task = mintSharedRegistration(action, group, client, runtime);
  runtime.sharedRegistrations.set(key, task);
  return task;
}

async function createRunner(
  action: Extract<Action, { kind: 'create-runner' }>,
  runtime: Runtime,
): Promise<void> {
  const group = groupFor(runtime.config, action.group);
  const host = runtime.config.hosts[action.host];
  const stack = stackFor(runtime, action.host);
  const client = clientFor(runtime, action.forge);
  const home = runtime.hosts.get(action.host)?.home;

  if (client.sharedRegistration) {
    const registration = await sharedRegistrationFor(
      action,
      group,
      client,
      runtime,
    );
    const spec = buildGitlabRunnerSpec({
      group,
      host,
      index: action.index,
      registration,
      home,
    });
    if (group.build !== undefined) {
      await stack.build(spec.image, group.build, group.arch);
    }
    await stack.prepareDirs(spec, { wipe: true });
    // A fresh config dir is what makes the container register against the
    // token this create resolved, instead of reusing a stale config.toml.
    await stack.prepareConfigDir(spec, { wipe: true });
    const record = resolveRecord(action, registration, runtime);
    await stack.createGitlabRunner(spec);
    runtime.store.recordEvent(record.id, 'created');
    runtime.store.recordEvent(record.id, 'started');
    return;
  }

  const registration = await runtime.limiter(() =>
    client.createRegistration({
      scope: group.scope,
      group: group.name,
      name: action.name,
      labels: group.labels ?? [],
    }),
  );

  const spec = buildRunnerSpec({
    group,
    host,
    index: action.index,
    registration,
    home,
  });

  if (group.build !== undefined) {
    await stack.build(spec.image, group.build, group.arch);
  }

  // The work dir is wiped when a runner is created, and kept across restarts.
  await stack.prepareDirs(spec, { wipe: true });

  // The record lands before the container starts, so grove never owns a
  // runner it has no row for. A record that vanished between plan and apply
  // fails the action here, rather than starting an unrecorded container.
  const record = resolveRecord(action, registration, runtime);

  await stack.create(spec);

  runtime.store.recordEvent(record.id, 'created');
  runtime.store.recordEvent(record.id, 'started');
}

function resolveRecord(
  action: Extract<Action, { kind: 'create-runner' }>,
  registration: RunnerRegistration,
  runtime: Runtime,
): RunnerRecord {
  if (action.recordId === undefined) {
    return runtime.store.createRunner({
      group: action.group,
      index: action.index,
      host: action.host,
      forge: action.forge,
      name: action.name,
      forgeRunnerId: registration.runnerId ?? null,
    });
  }
  const existing = runtime.store.getRunner(action.recordId);
  if (existing === undefined) {
    throw new Error(`record ${action.recordId} no longer exists`);
  }
  // A forge that mints the runner id up front hands back a new one on every
  // registration, so the reused record has to learn it.
  if (registration.runnerId !== undefined) {
    runtime.store.setForgeRunnerId(existing.id, registration.runnerId);
  }
  return existing;
}

async function startContainer(
  action: Extract<Action, { kind: 'start-container' }>,
  runtime: Runtime,
): Promise<void> {
  const stack = stackFor(runtime, action.host);
  const parsed = parseManagedName(action.name);
  if (runtime.clean === true && parsed !== null) {
    const dirs = buildRunnerDirs({
      group: groupFor(runtime.config, parsed.group),
      host: runtime.config.hosts[action.host],
      index: parsed.index,
      home: runtime.hosts.get(action.host)?.home,
    });
    await stack.prepareDirs(dirs, { wipe: true });
  }
  await stack.start(action.name);
  if (action.recordId !== undefined) {
    runtime.store.recordEvent(action.recordId, 'started');
  }
}

async function runAction(action: Action, runtime: Runtime): Promise<void> {
  switch (action.kind) {
    case 'create-runner':
      return createRunner(action, runtime);
    case 'start-container':
      return startContainer(action, runtime);
    case 'stop-container': {
      await stackFor(runtime, action.host).stop(
        action.name,
        runtime.force === true ? 0 : action.drainTimeoutMs,
      );
      if (action.recordId !== undefined) {
        runtime.store.recordEvent(action.recordId, 'stopped');
      }
      return;
    }
    case 'remove-container': {
      await stackFor(runtime, action.host).remove(action.name);
      if (action.recordId !== undefined) {
        runtime.store.recordEvent(action.recordId, 'removed');
      }
      return;
    }
    case 'deregister-runner': {
      const client = clientFor(runtime, action.forge);
      await runtime.limiter(() =>
        client.deleteRunner(action.scope, action.forgeRunnerId),
      );
      if (action.recordId !== undefined) {
        runtime.store.recordEvent(action.recordId, 'deregistered');
      }
      return;
    }
    case 'delete-shared-runner': {
      const client = clientFor(runtime, action.forge);
      await runtime.limiter(() =>
        client.deleteRunner(action.scope, action.forgeRunnerId),
      );
      if (action.registrationId !== undefined) {
        runtime.store.retireGroupRegistration(action.registrationId);
      }
      return;
    }
    case 'retire-record': {
      runtime.store.retireRunner(action.recordId);
      return;
    }
    default:
      // Report kinds are filtered out before a bucket is built, so nothing
      // should arrive here. A new action kind that does is a bug, and calling
      // it applied would report a success that never happened.
      throw new Error(`grove has no executor for action "${action.kind}"`);
  }
}

export async function executeActions(
  actions: Action[],
  options: ExecuteOptions,
): Promise<ExecutionResult> {
  const runtime: Runtime = {
    ...options,
    limiter: createLimiter(options.forgeConcurrency ?? FORGE_CONCURRENCY),
    sharedRegistrations: new Map(),
  };
  const log = options.log ?? (() => undefined);

  const buckets = new Map<string, Action[]>();
  for (const action of actions) {
    if (isReport(action)) {
      log(describeAction(action));
      continue;
    }
    const key =
      'host' in action && action.host !== undefined ? action.host : '';
    const bucket = buckets.get(key) ?? [];
    bucket.push(action);
    buckets.set(key, bucket);
  }

  const applied: Action[] = [];
  const failed: ActionFailure[] = [];
  const skipped: Action[] = [];

  await Promise.all(
    [...buckets.values()].map(async (bucket) => {
      // One failure poisons its own runner, and nothing else on the host.
      const poisoned = new Set<string>();
      for (const action of bucket) {
        const name = 'name' in action ? action.name : undefined;
        if (name !== undefined && poisoned.has(name)) {
          skipped.push(action);
          continue;
        }
        try {
          await runAction(action, runtime);
          applied.push(action);
          log(describeAction(action));
        } catch (error) {
          failed.push({
            action,
            error: errorMessage(error),
          });
          if (name !== undefined) {
            poisoned.add(name);
          }
        }
      }
    }),
  );

  return { applied, failed, skipped };
}

/**
 * Write the system ids the hosts reported onto the records they belong to.
 * Observation reads them and this writes them, because writing to the
 * database is an act, and `grove plan` performs none.
 */
export function persistSystemIds(
  observed: ObservedState,
  records: RunnerRecord[],
  store: StateStore,
): number {
  // Keyed by host and name together. One name can belong to a record on each
  // of two hosts, and each host reports the id of the container it runs.
  const byHostName = new Map(
    records
      .filter((record) => record.retiredAt === null)
      .map((record) => [`${record.host} ${record.name}`, record] as const),
  );
  let learned = 0;
  for (const host of observed.hosts) {
    for (const [name, systemId] of Object.entries(host.systemIds ?? {})) {
      const record = byHostName.get(`${host.host} ${name}`);
      // A name no record claims on this host is a collision, not this
      // runner, so nothing is written for it.
      if (record === undefined || record.systemId === systemId) {
        continue;
      }
      store.setSystemId(record.id, systemId);
      learned += 1;
    }
  }
  return learned;
}
