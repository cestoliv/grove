import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_INVALID_CONFIG } from '../lib/exit-codes.js';
import { FakeForgeClient } from '../lib/forge/index.js';
import type {
  Action,
  ExecutionResult,
  ObservedState,
} from '../lib/reconcile/index.js';
import { StateStore } from '../lib/state/index.js';
import { FakeTransport } from '../lib/transport/index.js';
import type { FleetContext } from './context.js';
import { confirmAndExecute, openFleetOrExit, planFleet } from './pipeline.js';

const CONFIG = `
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
`;

let dir: string;
let store: StateStore;
let client: FakeForgeClient;
let transports: Record<string, FakeTransport>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-pipeline-'));
  store = StateStore.open(':memory:');
  client = new FakeForgeClient('gh-overload');
  transports = {
    mac: new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('docker ps', { stdout: '' }),
    atlas: new FakeTransport('atlas').fail('uname', 'no route to host\n', 255),
  };
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

function options(extra: Record<string, unknown> = {}) {
  return {
    config: join(dir, 'grove.yaml'),
    env: {},
    store,
    connect: (name: string) => transports[name],
    resolveToken: async () => 'token',
    createForgeClient: () => client,
    ...extra,
  };
}

describe('openFleetOrExit', () => {
  it('opens the fleet when the config loads', async () => {
    await write();
    const opened = await openFleetOrExit(options(), () => undefined);

    expect(typeof opened).not.toBe('number');
    const fleet = opened as FleetContext;
    expect([...fleet.transports.keys()].sort()).toEqual(['atlas', 'mac']);
    await fleet.close();
  });

  it('reports the config error on stderr and returns exit code 2', async () => {
    const errors: string[] = [];
    const path = join(dir, 'nowhere.yaml');
    const opened = await openFleetOrExit(
      { config: path, env: {}, store },
      (text: string) => errors.push(text),
    );

    expect(opened).toBe(EXIT_INVALID_CONFIG);
    expect(errors.join('\n')).toContain(path);
  });

  it('lets an unexpected error through', async () => {
    await write();
    await expect(
      openFleetOrExit(
        options({
          connect: () => {
            throw new Error('the transport exploded');
          },
        }),
        () => undefined,
      ),
    ).rejects.toThrow('the transport exploded');
  });
});

describe('planFleet', () => {
  it('observes, reconciles and reports in one pass', async () => {
    await write();
    const fleet = (await openFleetOrExit(
      options(),
      () => undefined,
    )) as FleetContext;

    try {
      const { observed, actions, report } = await planFleet(fleet, options());

      expect(
        observed.hosts.map((entry) => [entry.host, entry.reachable]).sort(),
      ).toEqual([
        ['atlas', false],
        ['mac', true],
      ]);
      expect(
        actions.some(
          (action) =>
            action.kind === 'create-runner' &&
            action.name === 'grove-overload-arm-1',
        ),
      ).toBe(true);
      expect(report.unreachable).toEqual(['atlas']);
      expect(report.ok).toBe(false);
      expect(report.actions).toEqual(actions);
    } finally {
      await fleet.close();
    }
  });

  it('carries the raw docker warnings the fleet read into the report', async () => {
    await write(`${CONFIG}    raw: { "--memory": "4g", "--name": "mine" }\n`);
    const fleet = (await openFleetOrExit(
      options(),
      () => undefined,
    )) as FleetContext;

    try {
      expect(fleet.rawWarnings.length).toBeGreaterThan(0);
      const { report } = await planFleet(fleet, options());
      expect(report.warnings).toEqual(
        expect.arrayContaining(fleet.rawWarnings),
      );
    } finally {
      await fleet.close();
    }
  });
});

const NOTHING_OBSERVED: ObservedState = { hosts: [], forges: [] };

function stopAction(name: string): Action {
  return {
    kind: 'stop-container',
    host: 'mac',
    name,
    drainTimeoutMs: 1_000,
    destructive: true,
  };
}

function removeAction(name: string): Action {
  return { kind: 'remove-container', host: 'mac', name, destructive: true };
}

describe('confirmAndExecute', () => {
  async function open(
    extra: Record<string, unknown> = {},
  ): Promise<FleetContext> {
    await write();
    return (await openFleetOrExit(
      options(extra),
      () => undefined,
    )) as FleetContext;
  }

  it('prints the dry-run line and runs nothing', async () => {
    const fleet = await open();
    const out: string[] = [];

    try {
      const outcome = await confirmAndExecute(
        fleet,
        NOTHING_OBSERVED,
        [stopAction('grove-overload-arm-1')],
        {
          question: 'Tear down 1 runner? [y/N]',
          dryRun: true,
          write: (text: string) => out.push(text),
          writeError: () => undefined,
        },
      );

      expect(outcome).toBe('dry-run');
      expect(out.join('\n')).toContain('--dry-run: grove changed nothing.');
      expect(
        transports.mac.commandLines().some((line) => line.includes('docker')),
      ).toBe(false);
    } finally {
      await fleet.close();
    }
  });

  it('aborts on no and runs nothing', async () => {
    const fleet = await open();
    const out: string[] = [];

    try {
      const outcome = await confirmAndExecute(
        fleet,
        NOTHING_OBSERVED,
        [stopAction('grove-overload-arm-1')],
        {
          question: 'Tear down 1 runner? [y/N]',
          isTty: true,
          input: Readable.from(['n\n']),
          write: (text: string) => out.push(text),
          writeError: () => undefined,
        },
      );

      expect(outcome).toBe('aborted');
      expect(out.join('\n')).toContain('Tear down 1 runner? [y/N]');
      expect(out.join('\n')).toContain('Aborted. grove changed nothing.');
      expect(
        transports.mac.commandLines().some((line) => line.includes('docker')),
      ).toBe(false);
    } finally {
      await fleet.close();
    }
  });

  it('never asks when a caller already said yes', async () => {
    const fleet = await open();

    try {
      const outcome = await confirmAndExecute(
        fleet,
        NOTHING_OBSERVED,
        [stopAction('grove-overload-arm-1')],
        {
          question: 'Tear down 1 runner? [y/N]',
          yes: true,
          write: () => undefined,
          writeError: () => undefined,
        },
      );

      expect(outcome).not.toBe('aborted');
      expect(transports.mac.commandLines()).toContain(
        'docker stop -t 1 grove-overload-arm-1',
      );
    } finally {
      await fleet.close();
    }
  });

  it('names the failure and the actions it skipped after it', async () => {
    transports.mac = new FakeTransport('mac')
      .on('uname', { stdout: 'Darwin arm64\n' })
      .on('sh -c printf', { stdout: '/Users/olivier' })
      .on('docker ps', { stdout: '' })
      .fail('docker stop', 'container is wedged\n', 1);
    const fleet = await open();
    const errors: string[] = [];

    try {
      const outcome = await confirmAndExecute(
        fleet,
        NOTHING_OBSERVED,
        [
          stopAction('grove-overload-arm-1'),
          removeAction('grove-overload-arm-1'),
        ],
        {
          question: 'Tear down 1 runner? [y/N]',
          force: true,
          write: () => undefined,
          writeError: (text: string) => errors.push(text),
        },
      );

      expect(outcome).not.toBe('aborted');
      expect(outcome).not.toBe('dry-run');
      const result = outcome as ExecutionResult;
      expect(result.failed).toHaveLength(1);
      expect(result.skipped).toHaveLength(1);
      expect(errors.join('\n')).toContain(
        'failed: mac: docker stop grove-overload-arm-1',
      );
      expect(errors.join('\n')).toContain(
        'skipped after an earlier failure: remove-container grove-overload-arm-1',
      );
    } finally {
      await fleet.close();
    }
  });
});
