import {
  DEFAULT_METRICS_SCRAPE_CACHE_MS,
  type GroveConfig,
} from '../config/index.js';
import type { StateStore } from '../state/index.js';
import type { Transport } from '../transport/index.js';
import {
  buildFamilies,
  type MetricsState,
  readStoreMetrics,
} from './collect.js';
import { mergeExposition, renderExposition } from './format.js';
import {
  scrapeSeatMetrics as defaultScrapeSeats,
  type SeatMetricsTarget,
  seatMetricsTargets,
} from './seats.js';

export interface CollectorOptions {
  state: MetricsState;
  // Read on every scrape rather than captured, because the daemon reloads the
  // config before every tick and a group added at 10:00 should appear at
  // 10:01. `store` is a thunk for the same reason: reopening the fleet closes
  // the store it was opened with, and a captured one would answer 500 from
  // then on.
  store: () => StateStore;
  config: () => GroveConfig;
  transports: () => ReadonlyMap<string, Transport>;
  version: string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  scrapeSeats?: (
    transports: ReadonlyMap<string, Transport>,
    targets: SeatMetricsTarget[],
  ) => Promise<string[]>;
}

/**
 * What the server calls on every scrape. grove's own gauges come from the
 * snapshot the tick published plus three SQLite reads, and cost nothing. The
 * seat re-export costs one `curl` per GitLab seat, so it is cached: two
 * Prometheus servers scraping every 15 seconds must not double the number of
 * calls landing on a host.
 */
export function createCollector(
  options: CollectorOptions,
): () => Promise<string> {
  const now = options.now ?? Date.now;
  const isPidAlive =
    options.isPidAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const scrapeSeats = options.scrapeSeats ?? defaultScrapeSeats;

  let cachedAt = Number.NEGATIVE_INFINITY;
  let cached: string[] = [];
  let inFlight: Promise<string[]> | undefined;

  function seats(): Promise<string[]> {
    // Reading the config is inside the guard with the scrape. The daemon
    // reloads it under the exporter, and a scrape that lands mid-reload should
    // lose the seat re-export rather than answer 500.
    let config: GroveConfig;
    try {
      config = options.config();
    } catch {
      return Promise.resolve([]);
    }
    const cacheMs =
      config.metrics?.scrapeCacheMs ?? DEFAULT_METRICS_SCRAPE_CACHE_MS;
    if (now() - cachedAt < cacheMs) {
      return Promise.resolve(cached);
    }
    // One in-flight scrape shared by every concurrent request, for the same
    // reason the cache exists.
    if (inFlight !== undefined) {
      return inFlight;
    }
    // Listing the targets and opening the transports sit inside the chain too,
    // so a throw from either degrades the same way a failed scrape does.
    inFlight = Promise.resolve()
      .then(() => scrapeSeats(options.transports(), seatMetricsTargets(config)))
      .then((blocks) => {
        cached = blocks;
        cachedAt = now();
        return blocks;
      })
      .catch(() => {
        // A scrape that failed as a whole is answered with nothing rather
        // than with a stale body pretending to be current.
        cached = [];
        cachedAt = now();
        return [];
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  return async (): Promise<string> => {
    const snapshot = options.state.snapshot();
    const families = buildFamilies({
      ...(snapshot === undefined ? {} : { snapshot }),
      storage: options.state.storage(),
      store: readStoreMetrics(options.store(), isPidAlive),
      version: options.version,
      now: now(),
    });
    return mergeExposition([renderExposition(families), ...(await seats())]);
  };
}
