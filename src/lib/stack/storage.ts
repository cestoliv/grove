import { errorMessage } from '../errors.js';
import { firstLine, type Transport } from '../transport/index.js';
import { buildUsageScript, parseUsage, type WorkDirTarget } from './usage.js';

// docker prints decimal units, not binary ones: 1kB is 1000 bytes.
const DOCKER_UNITS: Record<string, number> = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  PB: 1000 ** 5,
};

const DOCKER_SIZE = /^(\d+(?:\.\d+)?)\s*([kmgtp]?b)\b/i;

// One row per type, tab separated, so no column ever has to be split on a
// space that also appears inside "Local Volumes".
export const DOCKER_DF_ARGS = [
  'system',
  'df',
  '--format',
  '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}',
];

export interface DockerDiskUsage {
  imagesBytes: number;
  imagesReclaimableBytes: number;
  containersBytes: number;
  volumesBytes: number;
  buildCacheBytes: number;
}

export function parseDockerSize(value: string): number | undefined {
  const match = DOCKER_SIZE.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const unit = DOCKER_UNITS[match[2].toUpperCase()];
  return unit === undefined ? undefined : Math.round(Number(match[1]) * unit);
}

export function parseDockerDiskUsage(
  text: string,
): DockerDiskUsage | undefined {
  const usage: DockerDiskUsage = {
    imagesBytes: 0,
    imagesReclaimableBytes: 0,
    containersBytes: 0,
    volumesBytes: 0,
    buildCacheBytes: 0,
  };
  let recognised = false;
  for (const line of text.split('\n')) {
    const [type, size, reclaimable] = line.split('\t');
    if (type === undefined || size === undefined) {
      continue;
    }
    const bytes = parseDockerSize(size);
    if (bytes === undefined) {
      continue;
    }
    switch (type.trim()) {
      case 'Images':
        usage.imagesBytes = bytes;
        // The percentage docker puts in parentheses is dropped. The ratio is
        // derived from the two numbers, so a docker that stops printing it
        // changes nothing here.
        usage.imagesReclaimableBytes = parseDockerSize(reclaimable ?? '') ?? 0;
        recognised = true;
        break;
      case 'Containers':
        usage.containersBytes = bytes;
        recognised = true;
        break;
      case 'Local Volumes':
        usage.volumesBytes = bytes;
        recognised = true;
        break;
      case 'Build Cache':
        usage.buildCacheBytes = bytes;
        recognised = true;
        break;
      default:
        break;
    }
  }
  return recognised ? usage : undefined;
}

export interface HostStorage {
  host: string;
  docker?: DockerDiskUsage;
  dockerError?: string;
  workDirBytes?: number;
  workDirs: Array<{ name: string; bytes: number }>;
  workDirError?: string;
}

/**
 * What one host spends on grove, in two reads. Nothing here throws: this runs
 * inside `status`, inside `doctor` and on every full tick, and a host that
 * cannot be measured must not stop any of the three.
 */
export async function readHostStorage(
  transport: Transport,
  host: string,
  targets: WorkDirTarget[],
  options: { docker?: boolean } = {},
): Promise<HostStorage> {
  const storage: HostStorage = { host, workDirs: [] };

  if (options.docker !== false) {
    try {
      const result = await transport.exec('docker', DOCKER_DF_ARGS);
      const usage =
        result.code === 0 ? parseDockerDiskUsage(result.stdout) : undefined;
      if (usage === undefined) {
        storage.dockerError =
          firstLine(result.stderr) ||
          firstLine(result.stdout) ||
          `docker system df exited ${result.code}`;
      } else {
        storage.docker = usage;
      }
    } catch (error) {
      storage.dockerError = errorMessage(error);
    }
  }

  if (targets.length > 0) {
    try {
      const measured = await transport.exec('sh', [
        '-c',
        buildUsageScript(targets),
      ]);
      if (measured.code !== 0) {
        storage.workDirError = `the work dirs could not be measured: ${
          firstLine(measured.stderr) || `exit ${measured.code}`
        }`;
      } else {
        const used = parseUsage(measured.stdout);
        for (const target of targets) {
          const bytes = used.get(target.name);
          if (bytes !== undefined) {
            storage.workDirs.push({ name: target.name, bytes });
          }
        }
        storage.workDirBytes = storage.workDirs.reduce(
          (sum, entry) => sum + entry.bytes,
          0,
        );
      }
    } catch (error) {
      storage.workDirError = errorMessage(error);
    }
  } else {
    storage.workDirBytes = 0;
  }

  return storage;
}
