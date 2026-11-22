import {
  EXIT_ABORTED,
  EXIT_INVALID_CONFIG,
  EXIT_OK,
} from '../lib/exit-codes.js';
import { confirm } from '../lib/prompt.js';
import { openFleetOrExit, takeStateLockOrExit } from './pipeline.js';
import type { PlanCommandOptions } from './plan.js';

export interface ForgetCommandOptions extends PlanCommandOptions {
  names: string[];
  yes?: boolean;
  isTty?: boolean;
  input?: NodeJS.ReadableStream;
}

/**
 * Retire the records of runners whose host is gone for good. grove never
 * deletes what it cannot see, so `apply` and `teardown` keep such a record
 * forever. The operator's word replaces the observation here, and the rule
 * that keeps it safe is that the host has left grove.yaml: a host still in
 * the config, reachable or not, belongs to `apply` and `teardown`.
 */
export async function runForget(
  options: ForgetCommandOptions,
): Promise<number> {
  const write = options.stdout ?? ((text: string) => console.log(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));

  const lock = takeStateLockOrExit(
    {
      command: 'forget',
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      ...(options.isPidAlive === undefined
        ? {}
        : { isPidAlive: options.isPidAlive }),
    },
    writeError,
  );
  if (typeof lock === 'number') {
    return lock;
  }

  try {
    // No forge is opened and no host is contacted: forget only writes the
    // database.
    const fleet = await openFleetOrExit(
      { ...options, forges: false },
      writeError,
    );
    if (typeof fleet === 'number') {
      return fleet;
    }

    try {
      const hosts = fleet.loaded.config.hosts;
      const records = [];
      for (const name of new Set(options.names)) {
        const record = fleet.store.findActiveByName(name);
        if (record === undefined) {
          writeError(`grove has no active record of a runner named "${name}".`);
          return EXIT_INVALID_CONFIG;
        }
        if (Object.hasOwn(hosts, record.host)) {
          writeError(
            `${name} runs on host "${record.host}", which is still in grove.yaml. Remove the host from grove.yaml first, or use apply or teardown.`,
          );
          return EXIT_INVALID_CONFIG;
        }
        records.push(record);
      }

      write('Forget');
      for (const record of records) {
        write(
          `  retire  ${record.name}  host "${record.host}" left grove.yaml, so grove drops its record and touches nothing`,
        );
      }

      const count = records.length;
      const agreed = await confirm({
        question: `Forget ${count} runner${count === 1 ? '' : 's'}? [y/N]`,
        ...(options.yes === undefined ? {} : { assumeYes: options.yes }),
        ...(options.isTty === undefined ? {} : { isTty: options.isTty }),
        ...(options.input === undefined ? {} : { input: options.input }),
        write,
        warn: writeError,
      });
      if (!agreed) {
        write('Aborted. grove changed nothing.');
        return EXIT_ABORTED;
      }

      fleet.store.retireRunners(records.map((record) => record.id));
      for (const record of records) {
        write(`  retired ${record.name}`);
      }
      return EXIT_OK;
    } finally {
      await fleet.close();
    }
  } finally {
    lock.release();
  }
}
