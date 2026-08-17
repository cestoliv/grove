import type { GroveConfig } from '../config/index.js';
import { runnerName } from '../naming.js';
import { groupMetricsPort } from '../stack/index.js';
import type { Transport } from '../transport/index.js';
import { relabelExposition } from './format.js';

export interface SeatMetricsTarget {
  host: string;
  runner: string;
  port: number;
}

/**
 * Every seat whose group publishes a gitlab-runner metrics port. Only a
 * GitLab Docker group has one: a GitHub Actions runner exposes no metrics
 * endpoint at all, and a native seat has no container to publish a port from.
 */
export function seatMetricsTargets(config: GroveConfig): SeatMetricsTarget[] {
  const targets: SeatMetricsTarget[] = [];
  for (const group of config.groups) {
    const declared = groupMetricsPort(config, group);
    if (declared === undefined) {
      continue;
    }
    // The planner's index scheme: 1..count for the whole group, in placement
    // key order, so a seat's port is the same wherever it is placed.
    let index = 0;
    for (const [host, count] of Object.entries(group.placement)) {
      for (let seat = 0; seat < count; seat += 1) {
        index += 1;
        targets.push({
          host,
          runner: runnerName(group.name, index),
          port: declared + index - 1,
        });
      }
    }
  }
  return targets;
}

export const SEAT_SCRAPE_TIMEOUT_SECONDS = 5;

export function seatScrapeArgs(port: number): string[] {
  return [
    '-sS',
    '--max-time',
    String(SEAT_SCRAPE_TIMEOUT_SECONDS),
    `http://127.0.0.1:${port}/metrics`,
  ];
}

/**
 * One `curl` per seat, over the transport rather than over the network. The
 * port is bound to the host's loopback, so this is the only way to reach it
 * from the control node, and it needs no tunnel and no open port.
 *
 * Nothing here throws. A seat that is down, a host that is unreachable and a
 * host with no curl all contribute nothing, which is what a scrape of a
 * partly broken fleet should do.
 */
export async function scrapeSeatMetrics(
  transports: ReadonlyMap<string, Transport>,
  targets: SeatMetricsTarget[],
): Promise<string[]> {
  const blocks = await Promise.all(
    targets.map(async (target) => {
      const transport = transports.get(target.host);
      if (transport === undefined) {
        return undefined;
      }
      try {
        const result = await transport.exec(
          'curl',
          seatScrapeArgs(target.port),
        );
        if (result.code !== 0 || result.stdout.trim() === '') {
          return undefined;
        }
        // Without this every seat exposes the same series and Prometheus
        // rejects the whole scrape. `grove_runner` is namespaced because
        // gitlab-runner exports a `runner` label of its own, and `host`
        // matches what grove's own gauges call the machine, so one PromQL
        // join covers both halves of the endpoint.
        return relabelExposition(result.stdout, {
          grove_runner: target.runner,
          host: target.host,
        });
      } catch {
        // Recorded nowhere: the exporter answers a scrape, and a log line per
        // scrape per seat would fill grove.log faster than anything else.
        return undefined;
      }
    }),
  );
  return blocks.filter((block): block is string => block !== undefined);
}
