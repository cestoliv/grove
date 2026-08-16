import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../lib/config/index.js';
import { FakeForgeClient } from '../lib/forge/index.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
import { openFleet } from './context.js';

const CONFIG = `
hosts:
  mac: { type: local }
  atlas: { type: ssh, host: atlas }

forges:
  gh-overload: { kind: github }
  gl-chevro: { kind: gitlab, url: https://git.chevro.fr }

groups:
  - name: overload-arm
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 1 }
  - name: chevro-dind
    forge: gl-chevro
    scope: { level: instance }
    placement: { atlas: 1 }
`;

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-context-'));
  store = StateStore.open(':memory:');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function write(text = CONFIG): Promise<string> {
  const path = join(dir, 'grove.yaml');
  await writeFile(path, text, 'utf8');
  return path;
}

function fakeTransports(): Record<string, FakeTransport> {
  return {
    mac: new FakeTransport('mac'),
    atlas: new FakeTransport('atlas'),
  };
}

describe('openFleet', () => {
  it('opens one transport and one stack per host', async () => {
    const path = await write();
    const transports = fakeTransports();
    const fleet = await openFleet({
      config: path,
      env: {},
      store,
      connect: (name) => transports[name],
      resolveToken: async () => 'token',
      createForgeClient: (name) => new FakeForgeClient(name),
    });

    expect([...fleet.transports.keys()]).toEqual(['mac', 'atlas']);
    expect([...fleet.stacks.keys()]).toEqual(['mac', 'atlas']);
    await fleet.close();
    expect(transports.mac.closed).toBe(true);
    expect(transports.atlas.closed).toBe(true);
  });

  it('builds a client for every Docker group forge, GitLab included', async () => {
    const path = await write();
    const transports = fakeTransports();
    const built: string[] = [];
    const fleet = await openFleet({
      config: path,
      env: {},
      store,
      connect: (name) => transports[name],
      resolveToken: async () => 'token',
      createForgeClient: (name) => {
        built.push(name);
        return new FakeForgeClient(name);
      },
    });

    expect(built.sort()).toEqual(['gh-overload', 'gl-chevro']);
    expect([...fleet.forgeClients.keys()].sort()).toEqual([
      'gh-overload',
      'gl-chevro',
    ]);
    await fleet.close();
  });

  it('picks the client class from the forge kind', async () => {
    const path = await write();
    const transports = fakeTransports();
    const fleet = await openFleet({
      config: path,
      env: {},
      store,
      connect: (name) => transports[name],
      resolveToken: async () => ['glpat', 'A1b2C3d4E5f6G7h8I9j0'].join('-'),
    });

    expect(fleet.forgeClients.get('gh-overload')?.kind).toBe('github');
    expect(fleet.forgeClients.get('gh-overload')?.sharedRegistration).toBe(
      false,
    );
    expect(fleet.forgeClients.get('gl-chevro')?.kind).toBe('gitlab');
    expect(fleet.forgeClients.get('gl-chevro')?.sharedRegistration).toBe(true);
    await fleet.close();
  });

  it('resolves the token through the local host transport', async () => {
    const path = await write();
    const transports = fakeTransports();
    const seen: string[] = [];
    const fleet = await openFleet({
      config: path,
      env: {},
      store,
      connect: (name) => transports[name],
      resolveToken: async (_name, _forge, transport) => {
        seen.push(transport.name);
        return 'token';
      },
      createForgeClient: (name) => new FakeForgeClient(name),
    });

    expect(seen).toEqual(['mac', 'mac']);
    await fleet.close();
  });

  it('throws a ConfigError for an invalid config and opens nothing', async () => {
    const path = await write(CONFIG.replace('kind: github', 'kind: gitea'));
    const transports = fakeTransports();
    await expect(
      openFleet({
        config: path,
        env: {},
        store,
        connect: (name) => transports[name],
        resolveToken: async () => 'token',
        createForgeClient: (name) => new FakeForgeClient(name),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(transports.mac.calls).toEqual([]);
  });

  it('throws a ConfigError for a malformed raw block before it resolves a token', async () => {
    const path = await write(`${CONFIG}    raw: { docker_run_args: 'nope' }\n`);
    const transports = fakeTransports();
    let resolved = 0;
    await expect(
      openFleet({
        config: path,
        env: {},
        store,
        connect: (name) => transports[name],
        resolveToken: async () => {
          resolved += 1;
          return 'token';
        },
        createForgeClient: (name) => new FakeForgeClient(name),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(resolved).toBe(0);
    expect(transports.mac.calls).toEqual([]);
  });

  it('closes the transports when a token cannot be resolved', async () => {
    const path = await write();
    const transports = fakeTransports();
    await expect(
      openFleet({
        config: path,
        env: {},
        store,
        connect: (name) => transports[name],
        resolveToken: async () => {
          throw new Error('gh auth token printed nothing');
        },
        createForgeClient: (name) => new FakeForgeClient(name),
      }),
    ).rejects.toThrow('gh auth token printed nothing');
    expect(transports.mac.closed).toBe(true);
  });

  it('opens the store at the state dir when none is given', async () => {
    const path = await write();
    const transports = fakeTransports();
    const fleet = await openFleet({
      config: path,
      env: { GROVE_STATE_DIR: join(dir, 'state') },
      connect: (name) => transports[name],
      resolveToken: async () => 'token',
      createForgeClient: (name) => new FakeForgeClient(name),
    });
    expect(fleet.store.activeRunners()).toEqual([]);
    await fleet.close();
  });
});
