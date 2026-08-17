import { access as fsAccess, stat as fsStat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import type { FleetContext } from '../../commands/context.js';
import type { ForgeConfig } from '../config/index.js';
import { errorMessage } from '../errors.js';
import { EXIT_OK, EXIT_UNREACHABLE } from '../exit-codes.js';
import { type FetchFn, resolveForgeToken } from '../forge/index.js';
import { resolveStateDir } from '../state/index.js';
import type { Transport } from '../transport/index.js';
import { runControlChecks } from './control.js';
import { forgeScopes, runForgeChecks } from './forge.js';
import { runGroupChecks } from './group.js';
import { runHostChecks } from './host.js';
import { createHostContext, type HostFacts } from './host-context.js';
import { type CheckReport, type CheckStatus, countStatuses } from './types.js';

export type CheckFamily = 'control' | 'host' | 'forge' | 'group';

const ALL_FAMILIES: CheckFamily[] = ['control', 'host', 'forge', 'group'];

// Printing order. Control first because a broken control node explains every
// other failure, then hosts, then forges, then the groups that depend on both.
const KIND_ORDER: Record<CheckFamily, number> = {
  control: 0,
  host: 1,
  forge: 2,
  group: 3,
};

export interface DoctorOptions {
  fleet: FleetContext;
  families?: CheckFamily[];
  // Which hosts to check. Every host in the config when absent, and the gate
  // in Task 16 passes the ones it has no record for.
  hosts?: string[];
  now?: () => number;
  probeTimeoutMs?: number;
  fetchFn?: FetchFn;
  resolveToken?: (
    name: string,
    forge: ForgeConfig,
    transport: Transport,
  ) => Promise<string>;
  platform?: string;
  home?: string;
  stateDir?: string;
  nodeVersion?: string;
  isPidAlive?: (pid: number) => boolean;
  env?: NodeJS.ProcessEnv;
  access?: (path: string, mode: number) => Promise<void>;
  stat?: (path: string) => Promise<{ mode: number }>;
}

export interface DoctorReport {
  configPath: string;
  checks: CheckReport[];
  counts: Record<CheckStatus, number>;
  // No fail. A warn leaves the fleet workable, which is what separates the
  // two, and --strict changes the exit code rather than this flag.
  ok: boolean;
  hostFacts: HostFacts[];
}

export async function runChecks(options: DoctorOptions): Promise<DoctorReport> {
  const { fleet } = options;
  const config = fleet.loaded.config;
  const families = new Set(options.families ?? ALL_FAMILIES);
  const env = options.env ?? process.env;

  const hostNames = (options.hosts ?? Object.keys(config.hosts)).filter(
    (name) => config.hosts[name] !== undefined,
  );

  const orderOf = new Map<string, number>();
  for (const [index, name] of Object.keys(config.hosts).entries()) {
    orderOf.set(`host:${name}`, index);
  }
  for (const [index, name] of Object.keys(config.forges).entries()) {
    orderOf.set(`forge:${name}`, index);
  }
  for (const [index, group] of config.groups.entries()) {
    orderOf.set(`group:${group.name}`, index);
  }

  // Parallel across hosts, serial within one, which is the rule the whole
  // reconciler follows and for the same reason: one SSH connection per host.
  const hostRuns =
    families.has('host') || families.has('group')
      ? hostNames.map(async (name) => {
          const transport = fleet.transports.get(name);
          const context = createHostContext({
            host: name,
            config,
            // A host with no transport cannot exist here: openFleet opens one
            // per declared host, and hostNames is filtered to declared hosts.
            transport: transport as Transport,
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.probeTimeoutMs === undefined
              ? {}
              : { probeTimeoutMs: options.probeTimeoutMs }),
          });
          const reports = await runHostChecks(context);
          return { reports, facts: context.facts };
        })
      : [];

  const controlRun = families.has('control')
    ? runControlChecks({
        config,
        configPath: fleet.loaded.path,
        transport: fleet.localTransport,
        platform: options.platform ?? osPlatform(),
        home: options.home ?? env.HOME ?? homedir(),
        stateDir: options.stateDir ?? resolveStateDir({ env }),
        store: fleet.store,
        nodeVersion: options.nodeVersion ?? process.version,
        isPidAlive:
          options.isPidAlive ??
          ((pid: number) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          }),
        access: options.access ?? fsAccess,
        stat: options.stat ?? ((path: string) => fsStat(path)),
      })
    : Promise.resolve([]);

  const scopes = forgeScopes(config);
  const resolveToken = options.resolveToken ?? resolveForgeToken;
  const forgeRuns = families.has('forge')
    ? Object.entries(config.forges).map(async ([name, forge]) => {
        let token: string | undefined;
        let tokenError: string | undefined;
        try {
          // Resolved here rather than in openFleet, because a token grove
          // cannot resolve is the finding, not a reason to stop the run.
          token = await resolveToken(name, forge, fleet.localTransport);
        } catch (error) {
          tokenError = errorMessage(error);
        }
        return runForgeChecks({
          name,
          forge,
          scopes: scopes.get(name) ?? [],
          ...(token === undefined ? {} : { token }),
          ...(tokenError === undefined ? {} : { tokenError }),
          fetchFn: options.fetchFn ?? fetch,
          limit: fleet.forgeLimit,
        });
      })
    : [];

  const [controlReports, hostResults, forgeResults] = await Promise.all([
    controlRun,
    Promise.all(hostRuns),
    Promise.all(forgeRuns),
  ]);

  const hostFacts = hostResults.map((result) => result.facts);
  const checks: CheckReport[] = [...controlReports];
  if (families.has('host')) {
    for (const result of hostResults) {
      checks.push(...result.reports);
    }
  }
  for (const reports of forgeResults) {
    checks.push(...reports);
  }
  if (families.has('group')) {
    checks.push(
      ...runGroupChecks({
        config,
        facts: new Map(hostFacts.map((fact) => [fact.host, fact])),
      }),
    );
  }

  // Stable sort by family then by config order, so --json and the table agree.
  const sorted = checks
    .map((check, index) => ({ check, index }))
    .sort((left, right) => {
      const kind =
        KIND_ORDER[left.check.target.kind] -
        KIND_ORDER[right.check.target.kind];
      if (kind !== 0) {
        return kind;
      }
      const order =
        (orderOf.get(`${left.check.target.kind}:${left.check.target.name}`) ??
          0) -
        (orderOf.get(`${right.check.target.kind}:${right.check.target.name}`) ??
          0);
      return order === 0 ? left.index - right.index : order;
    })
    .map((entry) => entry.check);

  const counts = countStatuses(sorted);
  return {
    configPath: fleet.loaded.path,
    checks: sorted,
    counts,
    ok: counts.fail === 0,
    hostFacts,
  };
}

export function doctorExitCode(report: DoctorReport, strict = false): number {
  if (report.counts.fail > 0) {
    return EXIT_UNREACHABLE;
  }
  return strict && report.counts.warn > 0 ? EXIT_UNREACHABLE : EXIT_OK;
}
