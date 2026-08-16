import type {
  ConfigWarning,
  ForgeConfig,
  LoadedConfig,
} from '../lib/config/index.js';
import { loadConfig } from '../lib/config/index.js';
import {
  type ForgeClient,
  GithubClient,
  resolveForgeToken,
} from '../lib/forge/index.js';
import {
  createLimiter,
  FORGE_CONCURRENCY,
  type Limiter,
} from '../lib/reconcile/index.js';
import { DockerStack, rawDockerWarnings } from '../lib/stack/index.js';
import { resolveStateDbPath, StateStore } from '../lib/state/index.js';
import {
  type ConnectFn,
  connect as defaultConnect,
  LocalTransport,
  type Transport,
} from '../lib/transport/index.js';

export interface FleetContext {
  loaded: LoadedConfig;
  // A malformed `raw:` block only surfaces when the Docker stack reads it,
  // so every command gets the same reading from one place.
  rawWarnings: ConfigWarning[];
  transports: Map<string, Transport>;
  forgeClients: Map<string, ForgeClient>;
  stacks: Map<string, DockerStack>;
  store: StateStore;
  forgeLimit: Limiter;
  close(): Promise<void>;
}

export interface OpenFleetOptions {
  config?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  connect?: ConnectFn;
  store?: StateStore;
  stateDbPath?: string;
  resolveToken?: (
    name: string,
    forge: ForgeConfig,
    transport: Transport,
  ) => Promise<string>;
  createForgeClient?: (
    name: string,
    forge: ForgeConfig,
    token: string,
  ) => ForgeClient;
  // `logs` never calls a forge, and it is the command you reach for when the
  // setup is already broken. Set false and no token is resolved, so a missing
  // PAT cannot stop a read.
  forges?: boolean;
}

export type OpenFleet = (options: OpenFleetOptions) => Promise<FleetContext>;

export async function openFleet(
  options: OpenFleetOptions = {},
): Promise<FleetContext> {
  const env = options.env ?? process.env;
  const loaded = await loadConfig({
    path: options.config,
    env,
    cwd: options.cwd,
  });

  // Read `raw:` before anything opens, so a malformed block throws like a
  // load error instead of leaking a transport or a database handle.
  const rawWarnings = rawDockerWarnings(loaded.config);

  const connectFn = options.connect ?? defaultConnect;
  const transports = new Map<string, Transport>();
  const stacks = new Map<string, DockerStack>();
  for (const [name, host] of Object.entries(loaded.config.hosts)) {
    const transport = connectFn(name, host);
    transports.set(name, transport);
    stacks.set(name, new DockerStack({ transport, host: name }));
  }

  const closeTransports = async (): Promise<void> => {
    await Promise.all(
      [...transports.values()].map((transport) =>
        transport.close().catch(() => undefined),
      ),
    );
  };

  // A `command:` credential runs on the control node, so it never goes over
  // SSH. A declared local host already gives us that transport.
  const localName = Object.entries(loaded.config.hosts).find(
    ([, host]) => host.type === 'local',
  )?.[0];
  const localTransport =
    localName === undefined
      ? new LocalTransport('local')
      : (transports.get(localName) as Transport);

  const closeLocalTransport = async (): Promise<void> => {
    if (localName === undefined) {
      await localTransport.close().catch(() => undefined);
    }
  };

  const resolveToken = options.resolveToken ?? resolveForgeToken;
  const createForgeClient =
    options.createForgeClient ??
    ((name, forge, token) =>
      new GithubClient({
        name,
        token,
        ...(forge.url === undefined ? {} : { url: forge.url }),
      }));

  const wanted = new Set(
    loaded.config.groups
      .filter(
        (group) =>
          group.stack === 'docker' &&
          loaded.config.forges[group.forge]?.kind === 'github',
      )
      .map((group) => group.forge),
  );

  const forgeLimit = createLimiter(FORGE_CONCURRENCY);
  const forgeClients = new Map<string, ForgeClient>();
  let store: StateStore;
  try {
    if (options.forges !== false) {
      for (const name of wanted) {
        const forge = loaded.config.forges[name];
        const token = await resolveToken(name, forge, localTransport);
        forgeClients.set(name, createForgeClient(name, forge, token));
      }
    }
    store =
      options.store ??
      StateStore.open(options.stateDbPath ?? resolveStateDbPath({ env }));
  } catch (error) {
    await closeTransports();
    await closeLocalTransport();
    throw error;
  }

  return {
    loaded,
    rawWarnings,
    transports,
    forgeClients,
    stacks,
    store,
    forgeLimit,
    async close(): Promise<void> {
      await closeTransports();
      await closeLocalTransport();
      if (options.store === undefined) {
        store.close();
      }
    },
  };
}
