import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ListenAddress, parseListen } from '../config/index.js';

// The version Prometheus's text format has carried since 0.0.4, and the one
// every scraper accepts.
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const PLAIN_TEXT = 'text/plain; charset=utf-8';

export interface MetricsServerOptions {
  listen: string;
  collect: () => Promise<string>;
  onError?: (error: unknown) => void;
}

export interface MetricsServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

// A trailing `:0` on an address that is otherwise well formed.
const EPHEMERAL = /^(.+):0$/;

/**
 * `parseListen` refuses port 0, because an ephemeral port in a config file is
 * always a mistake: nobody could tell Prometheus where to scrape. Asking a
 * server to bind one is a different question, and the answer is yes. The host
 * still goes through `parseListen`, so every other rule holds.
 */
function bindAddress(listen: string): ListenAddress {
  const ephemeral = EPHEMERAL.exec(listen.trim());
  if (ephemeral === null) {
    return parseListen(listen);
  }
  return { host: parseListen(`${ephemeral[1]}:1`).host, port: 0 };
}

export async function startMetricsServer(
  options: MetricsServerOptions,
): Promise<MetricsServer> {
  const address = bindAddress(options.listen);

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    if (path === '/healthz') {
      // No collection at all, so a liveness probe never costs a scrape of
      // the fleet.
      response.writeHead(200, { 'Content-Type': PLAIN_TEXT });
      response.end('ok\n');
      return;
    }
    if (path !== '/metrics') {
      response.writeHead(404, { 'Content-Type': PLAIN_TEXT });
      response.end('not found\n');
      return;
    }
    // Wrapped rather than called straight, so a collector that throws on the
    // way in lands on the same 500 as one whose promise rejects.
    Promise.resolve()
      .then(() => options.collect())
      .then((body) => {
        response.writeHead(200, { 'Content-Type': METRICS_CONTENT_TYPE });
        response.end(body);
      })
      .catch((error: unknown) => {
        // The exporter is an accessory. A broken scrape answers 500 and the
        // control loop keeps converging the fleet.
        options.onError?.(error);
        response.writeHead(500, { 'Content-Type': PLAIN_TEXT });
        response.end('the collector failed\n');
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address.port, address.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // Past the bind there is nobody left to reject, and an unhandled 'error' on
  // an EventEmitter throws. The daemon hears about it instead.
  server.on('error', (error) => {
    options.onError?.(error);
  });

  const bound = server.address() as AddressInfo;
  return {
    host: address.host,
    port: bound.port,
    close: () =>
      new Promise<void>((resolve) => {
        // closeAllConnections, so a keep-alive scraper does not hold the
        // daemon open past its shutdown.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
