import type { GroupConfig, GroveConfig } from '../config/index.js';
import { errorMessage } from '../errors.js';
import type { ForgeClient, RunnerRegistration } from '../forge/index.js';
import { parseManagedName } from '../naming.js';
import {
  buildRunnerDirs,
  buildRunnerSpec,
  type DockerStack,
} from '../stack/index.js';
import type { RunnerRecord, StateStore } from '../state/index.js';
import { type Action, describeAction, isReport } from './actions.js';
import { createLimiter, type Limiter } from './limiter.js';
import type { HostObservation } from './observed.js';

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

async function createRunner(
  action: Extract<Action, { kind: 'create-runner' }>,
  runtime: Runtime,
): Promise<void> {
  const group = groupFor(runtime.config, action.group);
  const host = runtime.config.hosts[action.host];
  const stack = stackFor(runtime, action.host);
  const client = clientFor(runtime, action.forge);
  const home = runtime.hosts.get(action.host)?.home;

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
