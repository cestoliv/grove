import { afterEach, describe, expect, it } from 'vitest';
import {
  METRICS_CONTENT_TYPE,
  type MetricsServer,
  startMetricsServer,
} from './server.js';

let server: MetricsServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(
  collect: () => Promise<string>,
  onError?: (error: unknown) => void,
): Promise<string> {
  // Port 0 asks the operating system for a free port, so the suite never
  // fights anything else on the machine for 9130.
  server = await startMetricsServer({
    listen: '127.0.0.1:0',
    collect,
    ...(onError === undefined ? {} : { onError }),
  });
  return `http://127.0.0.1:${server.port}`;
}

describe('startMetricsServer', () => {
  it('serves the exposition on /metrics with the Prometheus content type', async () => {
    const base = await start(async () => 'grove_up 1\n');
    const response = await fetch(`${base}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);
    expect(await response.text()).toBe('grove_up 1\n');
  });

  it('answers /healthz without collecting anything', async () => {
    let collected = 0;
    const base = await start(async () => {
      collected += 1;
      return '';
    });

    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok\n');
    expect(collected).toBe(0);
  });

  it('answers 404 on any other path', async () => {
    const base = await start(async () => '');
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics/extra`)).status).toBe(404);
  });

  it('answers 405 to a method that is not a read', async () => {
    const base = await start(async () => '');
    const response = await fetch(`${base}/metrics`, { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('answers 500 when the collector throws, and reports it once', async () => {
    const errors: unknown[] = [];
    const base = await start(
      async () => {
        throw new Error('the store is closed');
      },
      (error) => errors.push(error),
    );

    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(500);
    expect(errors).toHaveLength(1);
  });

  it('answers 500 when the collector throws before it returns a promise', async () => {
    const errors: unknown[] = [];
    // A collector that throws on the way in rather than rejecting. Unwrapped,
    // that throw escapes the request handler, the socket hangs and an
    // unhandled exception takes the daemon down with it.
    const base = await start(
      (() => {
        throw new Error('the config went away');
      }) as () => Promise<string>,
      (error) => errors.push(error),
    );

    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(500);
    expect(errors).toHaveLength(1);
  });

  it('reports the address it actually bound', async () => {
    await start(async () => '');
    expect(server?.host).toBe('127.0.0.1');
    expect(server?.port).toBeGreaterThan(0);
  });

  it('refuses an address that names no host, like the config does', async () => {
    await expect(
      startMetricsServer({ listen: ':9130', collect: async () => '' }),
    ).rejects.toThrow(RangeError);
  });

  it('stops answering once it is closed', async () => {
    const base = await start(async () => 'grove_up 1\n');
    const port = server?.port;
    await server?.close();
    server = undefined;
    await expect(fetch(`${base}/metrics`)).rejects.toThrow();
    expect(port).toBeGreaterThan(0);
  });
});
