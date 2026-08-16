import type { GroveConfig } from './schema.js';

export type WarningCode =
  | 'privileged-docker-socket'
  | 'arch-mismatch'
  | 'raw-unused';

export interface ConfigWarning {
  code: WarningCode;
  path: string;
  message: string;
}

export const DOCKER_SOCKET_PATH = '/var/run/docker.sock';

export function privilegedSocketWarnings(config: GroveConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  for (const [index, group] of config.groups.entries()) {
    if (group.privileged !== true) {
      continue;
    }
    const mountsSocket = (group.volumes ?? []).some(
      (volume) => volume.split(':')[0] === DOCKER_SOCKET_PATH,
    );
    if (!mountsSocket) {
      continue;
    }
    warnings.push({
      code: 'privileged-docker-socket',
      path: `groups[${index}]`,
      message: `group "${group.name}" runs privileged and mounts ${DOCKER_SOCKET_PATH}. Any job on that runner can take root on the host. grove proceeds anyway.`,
    });
  }
  return warnings;
}

export function archWarnings(
  config: GroveConfig,
  hostArch: ReadonlyMap<string, string>,
): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  for (const [index, group] of config.groups.entries()) {
    if (group.arch === undefined) {
      continue;
    }
    for (const host of Object.keys(group.placement)) {
      const reported = hostArch.get(host);
      if (reported === undefined || reported === group.arch) {
        continue;
      }
      warnings.push({
        code: 'arch-mismatch',
        path: `groups[${index}].arch`,
        message: `group "${group.name}" asks for ${group.arch} on host "${host}", which reports ${reported}. Architecture is a request, so grove proceeds anyway.`,
      });
    }
  }
  return warnings;
}
