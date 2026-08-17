import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeForgeClient } from '../lib/forge/index.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
import { runApply } from './apply.js';
import { EXIT_ABORTED, EXIT_OK, EXIT_UNREACHABLE } from './plan.js';

const CONFIG = `
hosts:
  mac: { type: local, work_root: /srv/grove }

forges:
  gh-overload: { kind: github }

groups:
  - name: overload-arm
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 1 }
    labels: [arm64]
`;

const TWO_HOST_CONFIG = `
hosts:
  mac: { type: local, work_root: /srv/grove }
  atlas: { type: ssh, host: atlas }

forges:
  gh-overload: { kind: github }

groups:
  - name: overload-arm
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 1 }
    labels: [arm64]
  - name: atlas-amd
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { atlas: 1 }
`;

let dir: string;
let store: StateStore;
let client: FakeForgeClient;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-apply-'));
  store = StateStore.open(':memory:');
  client = new FakeForgeClient('gh-overload');
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

function mac(psOutput = ''): FakeTransport {
  return new FakeTransport('mac')
    .on('uname', { stdout: 'Darwin arm64\n' })
    .on('sh -c printf', { stdout: '/Users/olivier' })
    .on('docker ps', { stdout: psOutput })
    .on('docker run', { stdout: 'c0ffee\n' });
}

function options(
  transport: FakeTransport,
  extra: Record<string, unknown> = {},
) {
  return {
    config: join(dir, 'grove.yaml'),
    env: {},
    store,
    connect: () => transport,
    resolveToken: async () => 'token',
    createForgeClient: () => client,
    color: false,
    isTty: false,
    stdout: () => undefined,
    stderr: () => undefined,
    ...extra,
  };
}

function psLine(name: string, state = 'running'): string {
  return `${JSON.stringify({
    ID: 'abc',
    Names: name,
    State: state,
    Image: 'ghcr.io/actions/actions-runner:latest',
    Status: 'Up 1 hour',
    CreatedAt: 'now',
  })}\n`;
}

describe('runApply', () => {
  it('creates the missing runner and records it', async () => {
    await write();
    const transport = mac();
    const out: string[] = [];
    const code = await runApply(
      options(transport, { stdout: (text: string) => out.push(text) }),
    );

    expect(code).toBe(EXIT_OK);
    expect(store.activeRunners().map((record) => record.name)).toEqual([
      'grove-overload-arm-1',
    ]);
    expect(client.registrations).toHaveLength(1);
    expect(
      transport.commandLines().some((line) => line.includes('docker run')),
    ).toBe(true);
    expect(out.join('\n')).toContain('create      grove-overload-arm-1');
  });

  it('changes nothing with --dry-run', async () => {
    await write();
    const transport = mac();
    const out: string[] = [];
    const code = await runApply(
      options(transport, {
        dryRun: true,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(store.activeRunners()).toEqual([]);
    expect(client.registrations).toEqual([]);
    expect(
      transport.commandLines().some((line) => line.includes('docker run')),
    ).toBe(false);
    expect(out.join('\n')).toContain('grove changed nothing');
  });

  it('asks before it destroys anything and aborts on no', async () => {
    await write();
    store.createRunner({
      group: 'overload-arm',
      index: 2,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-2',
    });
    const transport = mac(psLine('grove-overload-arm-2'));
    const out: string[] = [];
    const code = await runApply(
      options(transport, {
        isTty: true,
        input: Readable.from(['n\n']),
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_ABORTED);
    expect(out.join('\n')).toContain('Aborted');
    expect(
      transport.commandLines().some((line) => line.includes('docker stop')),
    ).toBe(false);
    expect(store.activeRunners()).toHaveLength(1);
  });

  it('drains, deregisters, removes and retires when the answer is yes', async () => {
    await write();
    store.createRunner({
      group: 'overload-arm',
      index: 2,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-2',
    });
    client.addRunner({ name: 'grove-overload-arm-2', id: '12' });
    const transport = mac(psLine('grove-overload-arm-2'));
    const code = await runApply(
      options(transport, { isTty: true, input: Readable.from(['yes\n']) }),
    );

    expect(code).toBe(EXIT_OK);
    const lines = transport.commandLines();
    expect(lines.some((line) => line.startsWith('docker stop -t 120'))).toBe(
      true,
    );
    expect(lines.some((line) => line.startsWith('docker rm -f'))).toBe(true);
    expect(client.deleted.map((entry) => entry.id)).toEqual(['12']);
    expect(store.findActiveByName('grove-overload-arm-2')).toBeUndefined();
  });

  it('skips the drain wait with --force and asks nothing', async () => {
    await write();
    store.createRunner({
      group: 'overload-arm',
      index: 2,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-2',
    });
    const transport = mac(psLine('grove-overload-arm-2'));
    const code = await runApply(options(transport, { force: true }));

    expect(code).toBe(EXIT_OK);
    expect(transport.commandLines()).toContain(
      'docker stop -t 0 grove-overload-arm-2',
    );
  });

  it('refuses to destroy without a terminal and without --yes', async () => {
    await write();
    store.createRunner({
      group: 'overload-arm',
      index: 2,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-2',
    });
    const transport = mac(psLine('grove-overload-arm-2'));
    const out: string[] = [];
    const errors: string[] = [];
    const code = await runApply(
      options(transport, {
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(EXIT_ABORTED);
    expect(errors.join('\n')).toContain('--yes');
    expect(out.join('\n')).toContain('Aborted');
    expect(store.activeRunners()).toHaveLength(1);
  });

  it('names the failure and the actions it skipped after it', async () => {
    await write();
    store.createRunner({
      group: 'overload-arm',
      index: 2,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-2',
    });
    const transport = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('docker ps', { stdout: psLine('grove-overload-arm-2') })
      .on('docker run', { code: 1, stderr: 'no space left on device\n' })
      .on('docker stop', { code: 1, stderr: 'container is wedged\n' });
    const errors: string[] = [];
    const code = await runApply(
      options(transport, {
        yes: true,
        stderr: (text: string) => errors.push(text),
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    const text = errors.join('\n');
    expect(text).toContain('failed: mac: docker run grove-overload-arm-1');
    expect(text).toContain('failed: mac: docker stop grove-overload-arm-2');
    expect(text).toContain(
      'skipped after an earlier failure: remove-container grove-overload-arm-2',
    );
    // A skipped line never trails a space, even when the action has no name.
    expect(errors.every((line) => line === line.trimEnd())).toBe(true);
    // The record lands before the container starts, so a failed `docker run`
    // leaves the row behind for the next pass to reuse.
    expect(
      store
        .activeRunners()
        .map((record) => record.name)
        .sort(),
    ).toEqual(['grove-overload-arm-1', 'grove-overload-arm-2']);
  });

  it('wipes the work dir before starting an exited container with --clean', async () => {
    await write();
    store.createRunner({
      group: 'overload-arm',
      index: 1,
      host: 'mac',
      forge: 'gh-overload',
      name: 'grove-overload-arm-1',
    });
    const transport = mac(psLine('grove-overload-arm-1', 'exited'));
    const code = await runApply(options(transport, { clean: true, yes: true }));

    expect(code).toBe(EXIT_OK);
    const lines = transport.commandLines();
    expect(lines.some((line) => line.includes('rm -rf'))).toBe(true);
    expect(lines).toContain('docker start grove-overload-arm-1');
  });

  it('exits non-zero and converges the rest when a host is unreachable', async () => {
    await write(TWO_HOST_CONFIG);
    const transports: Record<string, FakeTransport> = {
      mac: mac(),
      atlas: new FakeTransport('atlas').fail(
        'uname',
        'no route to host\n',
        255,
      ),
    };
    const code = await runApply(
      options(transports.mac, {
        connect: (name: string) => transports[name],
        yes: true,
      }),
    );

    expect(code).toBe(EXIT_UNREACHABLE);
    expect(store.activeRunners().map((record) => record.name)).toEqual([
      'grove-overload-arm-1',
    ]);
  });
});

const GITLAB_CONFIG = `
hosts:
  atlas: { type: ssh, host: atlas, work_root: /PROD/local/grove }

forges:
  gl-chevro: { kind: gitlab, url: https://git.chevro.fr }

groups:
  - name: chevro-dind
    forge: gl-chevro
    scope: { level: instance }
    placement: { atlas: 1 }
    tags: [docker]
`;

function atlas(psOutput = ''): FakeTransport {
  return new FakeTransport('atlas')
    .on('uname', { stdout: 'Linux x86_64\n' })
    .on('sh -c printf', { stdout: '/root' })
    .on('docker ps', { stdout: psOutput })
    .on('sh -c set --', { stdout: 'grove-chevro-dind-1\ts_aaaaaaaaaaaa\n' })
    .on('docker run', { stdout: 'beef42\n' });
}

function gitlabClient(): FakeForgeClient {
  return new FakeForgeClient('gl-chevro', {
    kind: 'gitlab',
    sharedRegistration: true,
  });
}

const RUNNING_DIND = `${JSON.stringify({
  ID: 'a1',
  Names: 'grove-chevro-dind-1',
  State: 'running',
  Image: 'gitlab/gitlab-runner:latest',
  Status: 'Up 2 hours',
  CreatedAt: 'now',
})}\n`;

describe('runApply, a GitLab group', () => {
  it('creates one entity for the group and registers the container against it', async () => {
    await write(GITLAB_CONFIG);
    const forge = gitlabClient();
    const transport = atlas();
    const code = await runApply({
      ...options(transport),
      createForgeClient: () => forge,
      yes: true,
    });

    expect(code).toBe(EXIT_OK);
    expect(forge.registrations).toHaveLength(1);
    expect(forge.registrations[0].name).toBe('grove-chevro-dind');
    expect(forge.registrations[0].tags).toEqual(['docker']);
    expect(store.activeGroupRegistrations()).toHaveLength(1);
    expect(
      transport
        .commandLines()
        .some((line) => line.includes('gitlab-runner register')),
    ).toBe(true);
  });

  it('learns the system id on the pass after the container started', async () => {
    await write(GITLAB_CONFIG);
    const forge = gitlabClient();

    await runApply({
      ...options(atlas()),
      createForgeClient: () => forge,
      yes: true,
    });
    await runApply({
      ...options(atlas(RUNNING_DIND)),
      createForgeClient: () => forge,
      yes: true,
    });

    const [record] = store.activeRunners();
    expect(record.systemId).toBe('s_aaaaaaaaaaaa');
    // Still one entity. The second pass had nothing to create.
    expect(forge.registrations).toHaveLength(1);
  });
});

describe('runApply, a native group', () => {
  const NATIVE_CONFIG = `
hosts:
  mac: { type: local, work_root: /srv/grove }

forges:
  gh-overload: { kind: github }

groups:
  - name: ios
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 1 }
    stack: native
    labels: [macos, xcode]
    raw:
      runner_version: "2.328.0"
      env:
        DEVELOPER_DIR: /Applications/Xcode.app/Contents/Developer
`;

  function nativeMac(): FakeTransport {
    return new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('id -u', { stdout: '501\n' })
      .on('docker ps', { stdout: '' })
      .on('launchctl list', { stdout: 'PID\tStatus\tLabel\n' });
  }

  it('installs the runner and loads the launchd agent end to end', async () => {
    await write(NATIVE_CONFIG);
    const transport = nativeMac();
    const code = await runApply(options(transport, { yes: true }));

    expect(code).toBe(EXIT_OK);
    expect(store.activeRunners().map((record) => record.name)).toEqual([
      'grove-ios-1',
    ]);
    expect(client.registrations).toHaveLength(1);
    const lines = transport.commandLines();
    expect(
      lines.some((line) =>
        line.includes('actions-runner-osx-arm64-2.328.0.tar.gz'),
      ),
    ).toBe(true);
    expect(lines).toContain(
      'launchctl bootstrap gui/501 /Users/olivier/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
    );
    expect(
      transport.writes.get(
        '/Users/olivier/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
      ),
    ).toContain('/Applications/Xcode.app/Contents/Developer');
  });
});
