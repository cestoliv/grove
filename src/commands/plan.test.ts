import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTransport } from '../lib/transport/index.js';
import {
  EXIT_INVALID_CONFIG,
  EXIT_OK,
  EXIT_UNREACHABLE,
  runPlan,
} from './plan.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-plan-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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
    placement: { host: mac, count: 2 }
    arch: arm64
  - name: chevro-dind
    forge: gl-chevro
    scope: { level: instance }
    placement: { atlas: 3 }
    privileged: true
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
`;

async function write(text: string): Promise<string> {
  const path = join(dir, 'grove.yaml');
  await writeFile(path, text, 'utf8');
  return path;
}

function reachableFleet(): {
  transports: Record<string, FakeTransport>;
  connect: (name: string) => FakeTransport;
} {
  const transports: Record<string, FakeTransport> = {
    mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
    atlas: new FakeTransport('atlas').on('uname', { stdout: 'Linux x86_64\n' }),
  };
  return { transports, connect: (name: string) => transports[name] };
}

describe('runPlan', () => {
  it('exits zero and prints the report when every host answers', async () => {
    const path = await write(CONFIG);
    const out: string[] = [];
    const code = await runPlan({
      config: path,
      env: {},
      connect: reachableFleet().connect,
      color: false,
      stdout: (text) => out.push(text),
      stderr: () => undefined,
    });

    expect(code).toBe(EXIT_OK);
    const text = out.join('\n');
    expect(text).toContain('Hosts');
    expect(text).toContain('overload-arm');
    expect(text).toContain('chevro-dind');
    expect(text).toContain('Every host answered');
  });

  it('prints the privileged socket warning', async () => {
    const path = await write(CONFIG);
    const out: string[] = [];
    await runPlan({
      config: path,
      env: {},
      connect: reachableFleet().connect,
      color: false,
      stdout: (text) => out.push(text),
      stderr: () => undefined,
    });
    expect(out.join('\n')).toContain(
      'group "chevro-dind" runs privileged and mounts /var/run/docker.sock',
    );
  });

  it('exits one and names the reason when a host is unreachable', async () => {
    const path = await write(CONFIG);
    const out: string[] = [];
    const transports: Record<string, FakeTransport> = {
      mac: new FakeTransport('mac').on('uname', { stdout: 'Darwin arm64\n' }),
      atlas: new FakeTransport('atlas').fail(
        'uname',
        'ssh: connect to host atlas port 22: No route to host',
        255,
      ),
    };
    const code = await runPlan({
      config: path,
      env: {},
      connect: (name) => transports[name],
      color: false,
      stdout: (text) => out.push(text),
      stderr: () => undefined,
    });

    expect(code).toBe(EXIT_UNREACHABLE);
    const text = out.join('\n');
    expect(text).toContain('No route to host');
    expect(text).toContain('Unreachable hosts: atlas');
  });

  it('exits two and writes the config error to stderr', async () => {
    const path = await write(CONFIG.replace('kind: github', 'kind: gitea'));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runPlan({
      config: path,
      env: {},
      connect: reachableFleet().connect,
      color: false,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });

    expect(code).toBe(EXIT_INVALID_CONFIG);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('kind must be "github" or "gitlab"');
    expect(err.join('\n')).toContain(path);
  });

  it('exits two when the config file is missing', async () => {
    const err: string[] = [];
    const code = await runPlan({
      config: join(dir, 'nowhere.yaml'),
      env: {},
      color: false,
      stdout: () => undefined,
      stderr: (text) => err.push(text),
    });
    expect(code).toBe(EXIT_INVALID_CONFIG);
    expect(err.join('\n')).toContain('no config file at');
  });

  it('never touches a host when the config is invalid', async () => {
    const path = await write(
      CONFIG.replace('forge: gh-overload', 'forge: nope'),
    );
    const fleet = reachableFleet();
    await runPlan({
      config: path,
      env: {},
      connect: fleet.connect,
      color: false,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(fleet.transports.mac.calls).toEqual([]);
    expect(fleet.transports.atlas.calls).toEqual([]);
  });

  it('reads the path from GROVE_CONFIG', async () => {
    const path = await write(CONFIG);
    const out: string[] = [];
    const code = await runPlan({
      env: { GROVE_CONFIG: path },
      connect: reachableFleet().connect,
      color: false,
      stdout: (text) => out.push(text),
      stderr: () => undefined,
    });
    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain(path);
  });
});
