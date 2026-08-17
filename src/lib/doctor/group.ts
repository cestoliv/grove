import { formatBytes } from '../bytes.js';
import {
  archWarnings,
  type ConfigWarning,
  dockerOptionWarnings,
  type GroveConfig,
  nativeOptionWarnings,
  privilegedSocketWarnings,
  type WarningCode,
} from '../config/index.js';
import { errorMessage } from '../errors.js';
import { resolveWorkRoot } from '../naming.js';
import { expandHome } from '../paths.js';
import {
  groupMetricsPort,
  groupSeatCount,
  metricsPortRangeError,
  rawStackWarnings,
} from '../stack/index.js';
import type { HostFacts } from './host-context.js';
import {
  type CheckReport,
  type CheckResult,
  fail,
  ok,
  skip,
  warn,
} from './types.js';

export interface GroupCheckContext {
  config: GroveConfig;
  facts: ReadonlyMap<string, HostFacts>;
}

export const GROUP_CHECK_IDS = [
  'group.privileged-socket',
  'group.arch',
  'group.native-forge',
  'group.native-platform',
  'group.max-work-size',
  'group.raw',
  'group.native-option',
  'group.metrics-port',
];

// One fix per warning code. The warnings themselves are shared with `plan`
// and the loader, which say what is wrong. Doctor is the only one that owes
// the operator what to do about it.
export const WARNING_FIXES: Record<WarningCode, string> = {
  'privileged-docker-socket':
    'Either drop privileged: true, or drop the socket mount. If the group needs both, put it on a host whose compromise you can accept, and never point it at a repository that takes pull requests from outside the org.',
  'arch-mismatch':
    'Drop the arch: key to take the host architecture, move the group to a host of that architecture, or leave it as it is and accept emulation. Architecture is a request in grove, so nothing is blocked either way.',
  'raw-unused':
    'Check the key against the ones this stack reads. grove passes raw through without interpreting it, so a misspelled key is silently dropped rather than rejected.',
  'native-unused-option':
    'Drop the key, or move the group to stack: docker. A native group runs the runner as a process on the host, so nothing about a container applies to it.',
  'docker-unused-option':
    'Drop the key, or move the group to stack: native. A Docker group runs the runner in a container, so nothing about a host install applies to it.',
};

const MANAGED_PLATFORMS = ['darwin', 'linux'];

function warningsById(
  warnings: ConfigWarning[],
  config: GroveConfig,
): Map<string, ConfigWarning[]> {
  const byGroup = new Map<string, ConfigWarning[]>();
  for (const warning of warnings) {
    const index = Number(/^groups\[(\d+)\]/.exec(warning.path)?.[1] ?? -1);
    const group = config.groups[index];
    if (group === undefined) {
      continue;
    }
    const list = byGroup.get(group.name) ?? [];
    list.push(warning);
    byGroup.set(group.name, list);
  }
  return byGroup;
}

export function metricsPortsFor(
  config: GroveConfig,
  host: string,
): Array<{ group: string; ports: number[] }> {
  const entries: Array<{ group: string; ports: number[] }> = [];
  for (const group of config.groups) {
    const declared = groupMetricsPort(config, group);
    if (declared === undefined) {
      continue;
    }
    // Seat n takes metrics_port + n - 1, and n is the group-wide index the
    // planner assigns, so a group spanning two hosts never asks two seats for
    // the same port.
    const ports: number[] = [];
    let index = 0;
    for (const [placed, count] of Object.entries(group.placement)) {
      for (let seat = 0; seat < count; seat += 1) {
        index += 1;
        if (placed === host) {
          ports.push(declared + index - 1);
        }
      }
    }
    if (ports.length > 0) {
      entries.push({ group: group.name, ports });
    }
  }
  return entries;
}

export function runGroupChecks(context: GroupCheckContext): CheckReport[] {
  const { config, facts } = context;
  const reports: CheckReport[] = [];

  const archByHost = new Map<string, string>();
  const platformByHost = new Map<string, string>();
  for (const fact of facts.values()) {
    if (!fact.reachable) {
      continue;
    }
    if (fact.arch !== undefined) {
      archByHost.set(fact.host, fact.arch);
    }
    if (fact.platform !== undefined) {
      platformByHost.set(fact.host, fact.platform);
    }
  }

  const privileged = warningsById(privilegedSocketWarnings(config), config);
  const arch = warningsById(
    archWarnings(config, archByHost, platformByHost),
    config,
  );
  const nativeOptions = warningsById(nativeOptionWarnings(config), config);
  const dockerOptions = warningsById(dockerOptionWarnings(config), config);
  let raw: Map<string, ConfigWarning[]>;
  let rawError: string | undefined;
  try {
    raw = warningsById(rawStackWarnings(config), config);
  } catch (error) {
    raw = new Map();
    rawError = errorMessage(error);
  }

  for (const group of config.groups) {
    const target = { kind: 'group' as const, name: group.name };
    const push = (id: string, result: CheckResult): void => {
      reports.push({ ...result, id, target });
    };
    const fromWarnings = (
      id: string,
      found: ConfigWarning[] | undefined,
      code: WarningCode,
      nothing: string,
    ): void => {
      if (found === undefined || found.length === 0) {
        push(id, ok(nothing));
        return;
      }
      for (const finding of found) {
        push(
          id,
          warn(finding.message, WARNING_FIXES[code], {
            subject: finding.path,
          }),
        );
      }
    };

    fromWarnings(
      'group.privileged-socket',
      privileged.get(group.name),
      'privileged-docker-socket',
      'no privileged container mounts the host Docker socket',
    );

    if (group.arch === undefined) {
      push('group.arch', skip('the group names no architecture'));
    } else {
      fromWarnings(
        'group.arch',
        arch.get(group.name),
        'arch-mismatch',
        `every host placed runs ${group.arch} natively`,
      );
    }

    if (group.stack !== 'native') {
      push('group.native-forge', skip('the group runs on Docker'));
      push('group.native-platform', skip('the group runs on Docker'));
      // The mirror of the native reading of this check. install_root
      // describes where a host install goes, and a container has none.
      const strayed = dockerOptions.get(group.name) ?? [];
      if (strayed.length === 0) {
        push('group.native-option', skip('the group runs on Docker'));
      } else {
        for (const finding of strayed) {
          push(
            'group.native-option',
            warn(finding.message, WARNING_FIXES['docker-unused-option'], {
              subject: finding.path,
            }),
          );
        }
      }
    } else {
      const kind = config.forges[group.forge]?.kind;
      push(
        'group.native-forge',
        kind === 'gitlab'
          ? fail(
              `a native group cannot run on the GitLab forge "${group.forge}"`,
              'Move the group to stack: docker, or point it at a GitHub forge. gitlab-runner on a native host is not something grove manages, and grove builds no client for the group at all, so it silently never appears in a plan.',
            )
          : ok(`the forge "${group.forge}" is a GitHub forge`),
      );

      const platforms = Object.keys(group.placement).map((host) => ({
        host,
        platform: facts.get(host)?.platform,
      }));
      const unknown = platforms.filter((entry) => entry.platform === undefined);
      const unmanaged = platforms.filter(
        (entry) =>
          entry.platform !== undefined &&
          !MANAGED_PLATFORMS.includes(entry.platform.toLowerCase()),
      );
      push(
        'group.native-platform',
        unmanaged.length > 0
          ? fail(
              `${unmanaged.map((entry) => `${entry.host} runs ${entry.platform}`).join(', ')}`,
              'grove supervises a native runner with launchd on macOS and with a systemd user unit on Linux, and has nothing for any other platform. Move the group to a macOS or Linux host, or to stack: docker.',
            )
          : unknown.length > 0
            ? skip(
                `${unknown.map((entry) => entry.host).join(', ')} did not answer, so grove does not know the platform`,
              )
            : ok('every host placed runs launchd or systemd'),
      );

      fromWarnings(
        'group.native-option',
        nativeOptions.get(group.name),
        'native-unused-option',
        'the group sets no container option',
      );
    }

    if (group.max_work_size === undefined) {
      push('group.max-work-size', skip('the group sets no max_work_size'));
    } else {
      const roomy = Object.keys(group.placement)
        .map((host) => {
          const fact = facts.get(host);
          if (fact === undefined) {
            return undefined;
          }
          const hostConfig = config.hosts[host];
          if (hostConfig === undefined) {
            return undefined;
          }
          const root = expandHome(
            resolveWorkRoot(hostConfig, group),
            fact.home === undefined
              ? undefined
              : ({ HOME: fact.home } as NodeJS.ProcessEnv),
          );
          const free = fact.freeBytes[root];
          return free === undefined ? undefined : { host, root, free };
        })
        .filter(
          (entry): entry is { host: string; root: string; free: number } =>
            entry !== undefined,
        );
      const tight = roomy.filter(
        (entry) => entry.free < (group.max_work_size ?? 0),
      );
      push(
        'group.max-work-size',
        tight.length > 0
          ? warn(
              `max_work_size is ${formatBytes(group.max_work_size)} and ${tight
                .map(
                  (entry) =>
                    `${entry.host} has ${formatBytes(entry.free)} free`,
                )
                .join(', ')}`,
              'Lower max_work_size to something the disk can hold, or move work_root to a bigger disk. A ceiling above the free space never triggers, so the disk fills before grove prunes anything.',
            )
          : roomy.length === 0
            ? skip('no host placed answered with its free space')
            : ok(
                `max_work_size is ${formatBytes(group.max_work_size)} and every disk holds it`,
              ),
      );
    }

    if (rawError !== undefined) {
      push(
        'group.raw',
        fail(
          rawError,
          'Fix the raw block named in the message. grove reads a fixed set of keys out of raw and passes the rest through, and a value of the wrong type stops the whole config from loading.',
        ),
      );
    } else if (group.raw === undefined) {
      push('group.raw', skip('the group has no raw block'));
    } else {
      fromWarnings(
        'group.raw',
        raw.get(group.name),
        'raw-unused',
        'every raw key is one this stack reads',
      );
    }

    const declaredPort = group.raw?.metrics_port;
    // The same predicate `rawGitlabOptions` throws on, so `group.raw` and
    // `group.metrics-port` can never disagree about one number.
    const outOfRange =
      typeof declaredPort === 'number'
        ? metricsPortRangeError(declaredPort, groupSeatCount(group))
        : undefined;
    if (declaredPort === undefined) {
      push('group.metrics-port', skip('the group publishes no metrics port'));
    } else if (typeof declaredPort !== 'number') {
      push(
        'group.metrics-port',
        fail(
          `raw.metrics_port is ${JSON.stringify(declaredPort)}, which is not a port`,
          'Set raw.metrics_port to a number, for example 9252. grove publishes one host port per seat, counting up from it.',
        ),
      );
    } else if (groupMetricsPort(config, group) === undefined) {
      // Nothing publishes this port, so there is nothing to scrape and nothing
      // to clash with. The summary names the half of the config that is wrong,
      // and `group.raw` separately reports the key as one this stack does not
      // read.
      push(
        'group.metrics-port',
        skip(
          config.forges[group.forge]?.kind === 'gitlab'
            ? 'metrics_port applies to docker groups only'
            : 'metrics_port applies to gitlab groups only',
        ),
      );
    } else if (outOfRange !== undefined) {
      push(
        'group.metrics-port',
        fail(
          outOfRange,
          "Pick a base low enough that the group's last seat still fits under 65535. grove gives seat n the port metrics_port + n - 1, and docker run fails outright on a port above the range.",
        ),
      );
    } else if (config.metrics === undefined) {
      push(
        'group.metrics-port',
        warn(
          `raw.metrics_port is ${declaredPort} and no exporter is running`,
          'Set metrics.listen in the config so grove scrapes the port it publishes, or drop raw.metrics_port so the seat stops publishing one.',
        ),
      );
    } else {
      const clashes: string[] = [];
      for (const host of Object.keys(group.placement)) {
        const mine = new Set(
          metricsPortsFor(config, host).find(
            (entry) => entry.group === group.name,
          )?.ports ?? [],
        );
        for (const other of metricsPortsFor(config, host)) {
          if (other.group === group.name) {
            continue;
          }
          const shared = other.ports.filter((port) => mine.has(port));
          if (shared.length > 0) {
            clashes.push(
              `${shared.join(', ')} on ${host} with group "${other.group}"`,
            );
          }
        }
      }
      push(
        'group.metrics-port',
        clashes.length > 0
          ? warn(
              `the ports overlap: ${clashes.join('; ')}`,
              'Move one of the groups to a port range of its own. grove gives seat n the port metrics_port + n - 1, so a group of three starting at 9252 takes 9252, 9253 and 9254. Two seats on one host asking for the same port means the second docker run fails with "port is already allocated".',
            )
          : ok(`publishes ${declaredPort} and up, one port per seat`),
      );
    }
  }

  return reports;
}
