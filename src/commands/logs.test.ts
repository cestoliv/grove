import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeForgeClient } from '../lib/forge/index.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
import { matchLogTargets, runLogs } from './logs.js';
import { EXIT_OK, EXIT_UNREACHABLE } from './plan.js';

const CONFIG = `
hosts:
  mac: { type: local }

forges:
  gh-overload: { kind: github }

groups:
  - name: overload-arm
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 2 }
`;

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-logs-'));
  store = StateStore.open(':memory:');
  await writeFile(join(dir, 'grove.yaml'), CONFIG, 'utf8');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function psLine(name: string): string {
  return JSON.stringify({
    ID: 'abc',
    Names: name,
    State: 'running',
    Image: 'ghcr.io/actions/actions-runner:latest',
    Status: 'Up 1 hour',
    CreatedAt: 'now',
  });
}

function mac(): FakeTransport {
  return new FakeTransport('mac')
    .on('docker ps', {
      stdout: `${psLine('grove-overload-arm-1')}\n${psLine('grove-overload-arm-2')}\n`,
    })
    .on('docker logs', { stdout: 'job started\n' });
}

function macFailingLogs(): FakeTransport {
  return new FakeTransport('mac')
    .on('docker ps', {
      stdout: `${psLine('grove-overload-arm-1')}\n${psLine('grove-overload-arm-2')}\n`,
    })
    .fail('docker logs', 'permission denied', 1);
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
    createForgeClient: (name: string) => new FakeForgeClient(name),
    stdout: () => undefined,
    stderr: () => undefined,
    ...extra,
  };
}

describe('matchLogTargets', () => {
  const found = [
    { name: 'grove-overload-arm-1', host: 'mac' },
    { name: 'grove-overload-arm-2', host: 'mac' },
    { name: 'grove-ios-1', host: 'mac' },
  ];

  it('matches one runner by its full name', () => {
    expect(matchLogTargets('grove-overload-arm-1', found)).toEqual([found[0]]);
  });

  it('matches every runner in a group', () => {
    expect(matchLogTargets('overload-arm', found)).toEqual([
      found[0],
      found[1],
    ]);
  });

  it('matches nothing for an unknown target', () => {
    expect(matchLogTargets('nope', found)).toEqual([]);
  });
});

describe('runLogs and the forge', () => {
  it('streams logs when no forge token can be resolved', async () => {
    const resolveToken = vi.fn(async () => {
      throw new Error('gh auth token failed');
    });
    const out: string[] = [];

    const code = await runLogs(
      options(mac(), {
        target: 'grove-overload-arm-1',
        resolveToken,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(out.join('')).toContain('job started');
    expect(resolveToken).not.toHaveBeenCalled();
  });
});

describe('runLogs', () => {
  it('prints the tail of one runner', async () => {
    const transport = mac();
    const out: string[] = [];
    const code = await runLogs(
      options(transport, {
        target: 'grove-overload-arm-1',
        tail: 50,
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    expect(transport.commandLines()).toContain(
      'docker logs --tail 50 grove-overload-arm-1',
    );
    expect(out.join('')).toContain('job started');
  });

  it('prints every runner of a group with a header each', async () => {
    const transport = mac();
    const out: string[] = [];
    const code = await runLogs(
      options(transport, {
        target: 'overload-arm',
        stdout: (text: string) => out.push(text),
      }),
    );

    expect(code).toBe(EXIT_OK);
    const text = out.join('');
    expect(text).toContain('==> grove-overload-arm-1 on mac <==');
    expect(text).toContain('==> grove-overload-arm-2 on mac <==');
  });

  it('follows a single runner', async () => {
    const transport = mac();
    await runLogs(
      options(transport, { target: 'grove-overload-arm-2', follow: true }),
    );
    expect(transport.commandLines()).toContain(
      'docker logs --follow --tail 200 grove-overload-arm-2',
    );
  });

  it('refuses to follow a group with several runners', async () => {
    const err: string[] = [];
    const code = await runLogs(
      options(mac(), {
        target: 'overload-arm',
        follow: true,
        stderr: (text: string) => err.push(text),
      }),
    );
    expect(code).toBe(EXIT_UNREACHABLE);
    expect(err.join('\n')).toContain('--follow needs exactly one runner');
  });

  it('names what it did find when the target matches nothing', async () => {
    const err: string[] = [];
    const code = await runLogs(
      options(mac(), {
        target: 'nope',
        stderr: (text: string) => err.push(text),
      }),
    );
    expect(code).toBe(EXIT_UNREACHABLE);
    expect(err.join('\n')).toContain('grove-overload-arm-1');
  });

  it('writes chunks verbatim through the default stdout writer', async () => {
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(chunk.toString());
        return true;
      });
    let code: number;
    try {
      const opts = options(mac(), { target: 'grove-overload-arm-1' });
      delete (opts as { stdout?: unknown }).stdout;
      code = await runLogs(opts);
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(EXIT_OK);
    // Verbatim: no header (a single match) and no newline the chunk didn't
    // already carry, unlike console.log which would add one of its own.
    expect(chunks.join('')).toBe('job started\n');
  });

  it('reports a non-zero docker logs exit code as a failure', async () => {
    const err: string[] = [];
    const code = await runLogs(
      options(macFailingLogs(), {
        target: 'grove-overload-arm-1',
        stderr: (text: string) => err.push(text),
      }),
    );
    expect(code).toBe(EXIT_UNREACHABLE);
    expect(err.join('\n')).toContain(
      'logs for grove-overload-arm-1 on mac failed (exit 1)',
    );
  });
});
