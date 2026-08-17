import { realpathSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import {
  ConfigError,
  CredentialError,
  type LoadConfigOptions,
  loadConfig,
  resolveConfigPath,
} from '../lib/config/index.js';
import {
  buildDaemonSpec,
  controlPersistFor,
  DAEMON_LOCK_FILE,
  DAEMON_LOG_FILE,
  DaemonLog,
  type DaemonUnitSpec,
  daemonUnitPathFor,
  isPidAlive as defaultIsPidAlive,
  runTick as defaultRunTick,
  installDaemon,
  LockHeldError,
  readDaemonInstalled,
  readLockHolder,
  refreshFleet,
  runDaemonLoop,
  StateLock,
  type StateLockOptions,
  type TickOptions,
  type TickSummary,
  tailFile,
  uninstallDaemon,
} from '../lib/daemon/index.js';
import { errorMessage } from '../lib/errors.js';
import {
  EXIT_INVALID_CONFIG,
  EXIT_OK,
  EXIT_UNREACHABLE,
} from '../lib/exit-codes.js';
import { DEFAULT_TAIL } from '../lib/log-defaults.js';
import {
  createCollector,
  type MetricsServer,
  MetricsState,
  startMetricsServer,
} from '../lib/metrics/index.js';
import { readUid } from '../lib/stack/index.js';
import {
  META_DAEMON_PID,
  META_DAEMON_STARTED_AT,
  META_LAST_FAST_TICK,
  META_LAST_FULL_TICK,
  resolveStateDir,
  STATE_DB_FILE,
  StateStore,
} from '../lib/state/index.js';
import { LocalTransport, type Transport } from '../lib/transport/index.js';
import {
  type FleetContext,
  type OpenFleet,
  type OpenFleetOptions,
  openFleet,
} from './context.js';

export interface DaemonCommonOptions {
  config?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stateDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function writers(options: DaemonCommonOptions): {
  write: (text: string) => void;
  writeError: (text: string) => void;
} {
  return {
    write: options.stdout ?? ((text: string) => console.log(text)),
    writeError: options.stderr ?? ((text: string) => console.error(text)),
  };
}

function stateDirFor(options: DaemonCommonOptions): string {
  return (
    options.stateDir ?? resolveStateDir({ env: options.env ?? process.env })
  );
}

/** What every subcommand hands `loadConfig`, spread so an absent key stays absent. */
function configOptions(options: DaemonCommonOptions): LoadConfigOptions {
  return {
    ...(options.config === undefined ? {} : { path: options.config }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
}

export interface DaemonRunOptions
  extends DaemonCommonOptions,
    OpenFleetOptions {
  openFleet?: OpenFleet;
  log?: DaemonLog;
  signal?: AbortSignal;
  runTick?: (options: TickOptions) => Promise<TickSummary>;
  isPidAlive?: (pid: number) => boolean;
  pid?: number;
  nativePollIntervalMs?: number;
  // Only a test injects one. The daemon builds its own.
  metricsState?: MetricsState;
}

export async function runDaemonRun(
  options: DaemonRunOptions = {},
): Promise<number> {
  const { write, writeError } = writers(options);
  const stateDir = stateDirFor(options);
  const ownsLog = options.log === undefined;
  const log = options.log ?? DaemonLog.open(join(stateDir, DAEMON_LOG_FILE));
  const pid = options.pid ?? process.pid;

  // Taken per tick rather than for the daemon's whole life, so an operator can
  // run `grove apply` in the gap between two ticks instead of having to
  // uninstall the daemon first. Two reconcilers still never overlap: whichever
  // one is inside a tick holds it, and the other waits or is refused.
  const lockOptions: StateLockOptions = {
    path: join(stateDir, DAEMON_LOCK_FILE),
    command: 'daemon',
    pid,
    ...(options.isPidAlive === undefined
      ? {}
      : { isPidAlive: options.isPidAlive }),
  };

  // The config is read here, before anything opens, purely to learn tick.fast.
  // ssh keeps its master socket for ControlPersist seconds after the last
  // call, so a window shorter than the fast tick means a fresh connection
  // every tick.
  let fastMs: number;
  try {
    const first = await loadConfig(configOptions(options));
    fastMs = first.config.tick.fast;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CredentialError) {
      writeError(error.message);
      log.error('', error.message);
      if (ownsLog) {
        log.close();
      }
      return EXIT_INVALID_CONFIG;
    }
    throw error;
  }

  const fleetOptions: DaemonRunOptions = {
    ...options,
    ssh: { ...options.ssh, controlPersist: controlPersistFor(fastMs) },
  };

  let fleet: FleetContext;
  try {
    fleet = await (options.openFleet ?? openFleet)(fleetOptions);
  } catch (error) {
    // A credential grove cannot resolve at startup exits, and the supervisor
    // restarts the daemon in ten seconds. That is the retry.
    const message = errorMessage(error);
    writeError(message);
    log.error('', `daemon could not open the fleet: ${message}`);
    if (ownsLog) {
      log.close();
    }
    return error instanceof ConfigError || error instanceof CredentialError
      ? EXIT_INVALID_CONFIG
      : EXIT_UNREACHABLE;
  }

  const metricsState = options.metricsState ?? new MetricsState();
  let metricsServer: MetricsServer | undefined;
  let metricsListen: string | undefined;
  // One line per transition, like the lock's `skipping` flag below. A port
  // taken for good is retried on every fast tick, and logging each attempt
  // would fill grove.log faster than anything else the daemon writes.
  let bindFailedFor: string | undefined;

  // Everything the collector reads is a thunk over the mutable `fleet`, so
  // reopening the fleet needs no rebuild and no rebind, and a scrape landing
  // mid-reopen reads the new store rather than the closed one.
  const collector = createCollector({
    state: metricsState,
    store: () => fleet.store,
    config: () => fleet.loaded.config,
    transports: () => fleet.transports,
    version: __VERSION__,
  });

  // The config is reloaded before every tick, so the exporter follows it: set
  // metrics.listen and it starts, remove it and it stops, change it and it
  // moves. An address grove cannot bind is logged and retried next tick,
  // because a control loop that stops converging over a taken port is worse
  // than one with no exporter.
  const syncMetrics = async (): Promise<void> => {
    const wanted = fleet.loaded.config.metrics?.listen;
    if (wanted === metricsListen) {
      return;
    }
    if (metricsServer !== undefined) {
      await metricsServer.close();
      metricsServer = undefined;
    }
    metricsListen = wanted;
    if (wanted === undefined) {
      bindFailedFor = undefined;
      log.info('', 'metrics exporter stopped');
      return;
    }
    try {
      metricsServer = await startMetricsServer({
        listen: wanted,
        collect: collector,
        onError: (error) =>
          log.warn('', `metrics scrape failed: ${errorMessage(error)}`),
      });
      bindFailedFor = undefined;
      log.info(
        '',
        `metrics exporter listening on ${metricsServer.host}:${metricsServer.port}`,
      );
    } catch (error) {
      // Cleared, so the next tick tries again rather than deciding the
      // exporter is permanently off.
      metricsListen = undefined;
      if (bindFailedFor !== wanted) {
        bindFailedFor = wanted;
        log.error(
          '',
          `metrics exporter could not bind ${wanted}: ${errorMessage(error)}`,
        );
      }
    }
  };

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  // launchd and systemd both stop a job with a signal, so the handlers are
  // always wired and an injected signal chains into the same controller.
  // The daemon then stops the same way under a test as it does under a
  // supervisor.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', stop, { once: true });
    }
  }

  const tick = options.runTick ?? defaultRunTick;
  fleet.store.setMeta(META_DAEMON_STARTED_AT, String(Date.now()));
  // Published for as long as the loop runs. The reconciler lock cannot answer
  // "is the daemon running" any more, because it is held only during a tick.
  fleet.store.setMeta(META_DAEMON_PID, String(pid));
  log.info(
    '',
    `daemon started, pid ${pid}, config ${fleet.loaded.path}, fast ${Math.round(fleet.loaded.config.tick.fast / 1000)}s, full ${Math.round(fleet.loaded.config.tick.full / 1000)}s`,
  );
  write(`grove daemon running, pid ${pid}`);

  // Last, so the exporter is the only thing between here and the loop: a throw
  // above it cannot leave a bound port behind, and a scrape landing on its
  // first second already sees the pid the daemon published.
  await syncMetrics();

  // One line per transition. A daemon that logged every skipped tick would
  // write one line every two minutes for as long as an apply takes.
  let skipping = false;

  try {
    await runDaemonLoop({
      intervals: () => ({
        fastMs: fleet.loaded.config.tick.fast,
        fullMs: fleet.loaded.config.tick.full,
      }),
      signal: controller.signal,
      onError: (error, kind) =>
        log.error('', `${kind} tick failed: ${errorMessage(error)}`),
      runTick: async (kind) => {
        let lock: StateLock;
        try {
          lock = StateLock.acquire(lockOptions);
        } catch (error) {
          if (!(error instanceof LockHeldError)) {
            throw error;
          }
          // An apply or a teardown is converging the same fleet right now.
          // Skipping costs one tick, and the next one picks up whatever it
          // left behind.
          if (!skipping) {
            log.warn(
              '',
              `tick skipped: lock held by ${error.holder.pid} (${error.holder.command})`,
            );
            skipping = true;
          }
          return;
        }
        skipping = false;
        try {
          const refreshed = await refreshFleet(fleet, fleetOptions);
          if (refreshed.error !== undefined) {
            log.warn('', `keeping the last good config: ${refreshed.error}`);
          }
          if (refreshed.reopened) {
            log.info(
              '',
              'the hosts or the forges changed, so grove reopened its connections',
            );
          }
          fleet = refreshed.fleet;
          await syncMetrics();
          await tick({
            fleet,
            kind,
            log,
            metrics: metricsState,
            ...(options.nativePollIntervalMs === undefined
              ? {}
              : { nativePollIntervalMs: options.nativePollIntervalMs }),
          });
        } finally {
          // Released whatever the tick did, so a failing tick does not leave
          // the fleet locked against the operator until the daemon stops.
          lock.release();
        }
      },
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
    // Cleared before the store closes, so a stopped daemon does not read as
    // running until some other process happens to take its pid.
    fleet.store.setMeta(META_DAEMON_PID, '');
    if (metricsServer !== undefined) {
      await metricsServer.close().catch(() => undefined);
    }
    await fleet.close().catch(() => undefined);
    log.info('', 'daemon stopped');
    if (ownsLog) {
      log.close();
    }
  }

  return EXIT_OK;
}

export interface DaemonUnitCommandOptions extends DaemonCommonOptions {
  store?: StateStore;
  transport?: Transport;
  // What `uname -s` would answer on the control node.
  platform?: string;
  home?: string;
  execPath?: string;
  script?: string;
}

interface UnitContext {
  transport: Transport;
  ownsTransport: boolean;
  platform: string;
  spec: DaemonUnitSpec;
  configPath: string;
  stateDir: string;
}

/**
 * The absolute file a supervisor can execute. npm installs `grove` as a
 * symlink whose own name has no `.js` suffix, and a supervisor follows
 * nothing, so the link is resolved to the script it points at.
 */
function resolveScriptPath(script: string): string {
  try {
    return realpathSync(script);
  } catch {
    // Nothing at that path to resolve. Keep the caller's answer absolute and
    // let `resolveDaemonCommand` explain what is wrong with it.
    return resolvePath(script);
  }
}

async function unitContext(
  options: DaemonUnitCommandOptions,
): Promise<UnitContext> {
  const env = options.env ?? process.env;
  // resolveConfigPath already resolves against the cwd, so this is absolute.
  const configPath = resolveConfigPath({
    ...(options.config === undefined ? {} : { explicit: options.config }),
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const stateDir = stateDirFor(options);
  const home = options.home ?? env.HOME ?? homedir();
  const platform = options.platform ?? osPlatform();
  const ownsTransport = options.transport === undefined;
  const transport = options.transport ?? new LocalTransport('control');
  const spec = buildDaemonSpec({
    home,
    stateDir,
    configPath,
    execPath: options.execPath ?? process.execPath,
    // process.argv[1] is the script the operator ran, and a supervisor has no
    // working directory to resolve a relative one against.
    script: resolveScriptPath(options.script ?? process.argv[1] ?? ''),
  });
  return { transport, ownsTransport, platform, spec, configPath, stateDir };
}

export async function runDaemonInstall(
  options: DaemonUnitCommandOptions = {},
): Promise<number> {
  const { write, writeError } = writers(options);
  try {
    // A daemon pointed at a config that does not parse would flap, so the
    // install refuses rather than the daemon.
    await loadConfig(configOptions(options));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CredentialError) {
      writeError(error.message);
      return EXIT_INVALID_CONFIG;
    }
    throw error;
  }

  let context: UnitContext | undefined;
  try {
    // Inside the try, because a source checkout has no script a supervisor
    // can run and grove owes the operator an exit code for that, not a stack.
    context = await unitContext(options);
    const uid = await readUid(context.transport);
    const result = await installDaemon({
      transport: context.transport,
      platform: context.platform,
      ...(uid === undefined ? {} : { uid }),
      spec: context.spec,
    });
    write(`wrote    ${result.path}`);
    write(`loaded   ${result.label}`);
    write(`config   ${context.configPath}`);
    write(`state    ${context.stateDir}`);
    write(`log      ${join(context.stateDir, DAEMON_LOG_FILE)}`);
    write('');
    write(
      'grove now converges the fleet on two cadences: a fast tick for liveness and a full tick that also calls the forges.',
    );
    write(
      'Reinstall after upgrading grove. The unit names this exact node binary and this exact script path.',
    );
    write('Follow the log with "grove daemon tail --follow".');
    return EXIT_OK;
  } catch (error) {
    writeError(errorMessage(error));
    return EXIT_UNREACHABLE;
  } finally {
    if (context?.ownsTransport === true) {
      await context.transport.close().catch(() => undefined);
    }
  }
}

export async function runDaemonUninstall(
  options: DaemonUnitCommandOptions = {},
): Promise<number> {
  const { write, writeError } = writers(options);
  const ownsStore = options.store === undefined;
  let context: UnitContext | undefined;
  let store: StateStore | undefined;
  try {
    context = await unitContext(options);
    const uid = await readUid(context.transport);
    const result = await uninstallDaemon({
      transport: context.transport,
      platform: context.platform,
      ...(uid === undefined ? {} : { uid }),
      spec: context.spec,
    });

    // Nothing watches the fleet from here, so a suspect the last control loop
    // named would stay in `grove status` for as long as its record lives, with
    // no tick left to clear it.
    store =
      options.store ?? StateStore.open(join(context.stateDir, STATE_DB_FILE));
    store.clearSuspects();

    write(`unloaded ${result.label}`);
    write(`removed  ${result.path}`);
    write('');
    write(
      'The runners keep running. grove no longer watches them, and nothing restarts one that wedges.',
    );
    return EXIT_OK;
  } catch (error) {
    writeError(errorMessage(error));
    return EXIT_UNREACHABLE;
  } finally {
    if (ownsStore && store !== undefined) {
      store.close();
    }
    if (context?.ownsTransport === true) {
      await context.transport.close().catch(() => undefined);
    }
  }
}

export interface DaemonTailOptions extends DaemonCommonOptions {
  lines?: number;
  follow?: boolean;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

export async function runDaemonTail(
  options: DaemonTailOptions = {},
): Promise<number> {
  const write =
    options.stdout ?? ((text: string) => process.stdout.write(text));
  const { writeError } = writers(options);
  const path = join(stateDirFor(options), DAEMON_LOG_FILE);
  try {
    await tailFile(path, {
      lines: options.lines ?? DEFAULT_TAIL,
      ...(options.follow === undefined ? {} : { follow: options.follow }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.pollIntervalMs }),
      write,
    });
    return EXIT_OK;
  } catch (error) {
    writeError(errorMessage(error));
    return EXIT_UNREACHABLE;
  }
}

export interface DaemonStatusOptions extends DaemonUnitCommandOptions {
  isPidAlive?: (pid: number) => boolean;
}

/**
 * The pid of the running control loop, or nothing. An empty value is a daemon
 * that stopped cleanly, which is not the same as one that never ran, but both
 * answer "not running" and neither is worth a second row.
 */
function readDaemonPid(store: StateStore): number | undefined {
  const raw = store.getMeta(META_DAEMON_PID);
  if (raw === undefined) {
    return undefined;
  }
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function when(value: string | undefined): string {
  if (value === undefined) {
    return 'never';
  }
  const ts = Number(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : 'never';
}

export async function runDaemonStatus(
  options: DaemonStatusOptions = {},
): Promise<number> {
  const { write, writeError } = writers(options);
  const alive = options.isPidAlive ?? defaultIsPidAlive;
  const ownsStore = options.store === undefined;

  let context: UnitContext | undefined;
  let store: StateStore | undefined;
  try {
    context = await unitContext(options);
    // The injected state dir wins, so a test never opens the operator's own
    // database to answer a question about a daemon that is not theirs.
    store =
      options.store ?? StateStore.open(join(context.stateDir, STATE_DB_FILE));

    // Three answers, not two. A control node that will not answer the probe
    // is not the same as a daemon that is not installed, and reporting it as
    // one would send the operator to reinstall something already there.
    let installed = 'unknown';
    try {
      installed = (await readDaemonInstalled({
        transport: context.transport,
        platform: context.platform,
        spec: context.spec,
      }))
        ? 'installed'
        : 'not installed';
    } catch (error) {
      writeError(errorMessage(error));
    }

    const pid = readDaemonPid(store);
    const running = pid !== undefined && alive(pid);
    // The reconciler lock is a different question: who is converging the fleet
    // right now. It is worth a line, because it is what an apply would be
    // refused by.
    const holder = readLockHolder(join(context.stateDir, DAEMON_LOCK_FILE));

    write(`config    ${context.configPath}`);
    write(`state     ${context.stateDir}`);
    write(`log       ${join(context.stateDir, DAEMON_LOG_FILE)}`);
    write(
      `unit      ${daemonUnitPathFor(context.spec, context.platform)} (${installed})`,
    );
    write(running ? `process   running, pid ${pid}` : 'process   not running');
    write(
      holder === undefined
        ? 'lock      free'
        : `lock      held by pid ${holder.pid} (${holder.command}) since ${holder.startedAt}`,
    );
    write(`started   ${when(store.getMeta(META_DAEMON_STARTED_AT))}`);
    write(`last fast ${when(store.getMeta(META_LAST_FAST_TICK))}`);
    write(`last full ${when(store.getMeta(META_LAST_FULL_TICK))}`);
    return running ? EXIT_OK : EXIT_UNREACHABLE;
  } catch (error) {
    writeError(errorMessage(error));
    return EXIT_UNREACHABLE;
  } finally {
    if (ownsStore && store !== undefined) {
      store.close();
    }
    if (context?.ownsTransport === true) {
      await context.transport.close().catch(() => undefined);
    }
  }
}
