import { formatBytes } from '../bytes.js';
import { isDarwinPlatform } from '../stack/index.js';
import { firstLine } from '../transport/index.js';
import type { HostCheckContext } from './host-context.js';
import { type Check, fail, ok, skip, warn } from './types.js';

export const DOCKER_GROUP_ARGS = ['-nG'];

// The spec reports the image store and warns about it, and says plainly that
// relocating it is outside grove. Twenty gibibytes is roughly five runner
// images with their layers, which is where a boot disk starts to notice.
export const IMAGE_STORE_WARN_BYTES = 20 * 1024 ** 3;
export const IMAGE_RECLAIMABLE_WARN_RATIO = 0.5;

const NO_BINARY = /command not found|No such file or directory|not found/i;

const INSTALL_FIX =
  'Install a Docker daemon on the host. On macOS, OrbStack or Docker Desktop. On Linux, `curl -fsSL https://get.docker.com | sh`. grove never provisions a host, so this one is yours to run.';

function dockerPlaced(context: HostCheckContext): boolean {
  return context.groups.some((group) => group.stack === 'docker');
}

const NOT_NEEDED = 'no Docker group is placed on this host';

export const dockerCliCheck: Check<HostCheckContext> = {
  id: 'host.docker-cli',
  async run(context) {
    if (!dockerPlaced(context)) {
      return [skip(NOT_NEEDED)];
    }
    const result = await context.dockerServer();
    const stderr = firstLine(result.stderr);
    if (result.code === 127 || NO_BINARY.test(stderr)) {
      return [fail(`docker is not on the PATH: ${stderr}`, INSTALL_FIX)];
    }
    return [ok('the docker binary is on the PATH')];
  },
};

export const dockerDaemonCheck: Check<HostCheckContext> = {
  id: 'host.docker-daemon',
  async run(context) {
    if (!dockerPlaced(context)) {
      return [skip(NOT_NEEDED)];
    }
    const result = await context.dockerServer();
    const version = result.stdout.trim();
    if (result.code === 0 && version !== '') {
      return [ok(`the daemon answered, server ${version}`)];
    }
    const probe = await context.probe();
    const fix = isDarwinPlatform(probe.platform)
      ? 'Start OrbStack or Docker Desktop on the host, and set it to start at login so a reboot does not take the fleet with it.'
      : 'Start the daemon with `sudo systemctl start docker`, and `sudo systemctl enable docker` so a reboot does not take the fleet with it.';
    return [
      fail(
        firstLine(result.stderr) || `docker version exited ${result.code}`,
        fix,
      ),
    ];
  },
};

export const dockerGroupCheck: Check<HostCheckContext> = {
  id: 'host.docker-group',
  async run(context) {
    if (!dockerPlaced(context)) {
      return [skip(NOT_NEEDED)];
    }
    const probe = await context.probe();
    if (isDarwinPlatform(probe.platform)) {
      return [
        skip(
          'macOS has no docker group, and both OrbStack and Docker Desktop expose the socket to the logged-in user',
        ),
      ];
    }
    const server = await context.dockerServer();
    if (server.code === 0) {
      // Membership is proven by the daemon having answered as this user,
      // which is also true under rootless Docker where the group is absent.
      return [ok('the daemon answers as this user, with no sudo')];
    }
    const groups = await context.transport.exec('id', DOCKER_GROUP_ARGS);
    const names = groups.stdout.trim().split(/\s+/);
    if (groups.code === 0 && names.includes('docker')) {
      return [ok('the user is in the docker group')];
    }
    return [
      fail(
        `the user is in ${names.filter((name) => name !== '').join(', ') || 'no group grove could read'}, and not in docker`,
        'Run `sudo usermod -aG docker $USER` on the host, then open a new session. grove calls docker without sudo, on purpose: a fleet that needs a password prompt cannot converge unattended.',
      ),
    ];
  },
};

export const imageStoreCheck: Check<HostCheckContext> = {
  id: 'host.image-store',
  async run(context) {
    if (!dockerPlaced(context)) {
      return [skip(NOT_NEEDED)];
    }
    const storage = await context.storage();
    if (storage.docker === undefined) {
      return [
        warn(
          `the image store could not be measured: ${storage.dockerError ?? 'docker system df said nothing'}`,
          'Check that `docker system df` answers on the host. grove reports the image store rather than managing it, so this blocks nothing.',
        ),
      ];
    }
    const { imagesBytes, imagesReclaimableBytes } = storage.docker;
    const summary = `${formatBytes(imagesBytes)} of images, ${formatBytes(imagesReclaimableBytes)} reclaimable`;
    const detail = `containers ${formatBytes(storage.docker.containersBytes)}, volumes ${formatBytes(storage.docker.volumesBytes)}, build cache ${formatBytes(storage.docker.buildCacheBytes)}`;
    const fix =
      'Run `docker image prune -a` on the host, or `docker system prune` for the build cache too. Moving the image store itself belongs to OrbStack or Docker Desktop and is outside grove: work_root moves the work dirs, and nothing grove does moves the images.';
    if (imagesBytes >= IMAGE_STORE_WARN_BYTES) {
      return [warn(summary, fix, { detail })];
    }
    if (
      imagesBytes > 0 &&
      imagesReclaimableBytes / imagesBytes > IMAGE_RECLAIMABLE_WARN_RATIO
    ) {
      return [warn(summary, fix, { detail })];
    }
    return [ok(summary, { detail })];
  },
};

export const DOCKER_HOST_CHECKS: Check<HostCheckContext>[] = [
  dockerCliCheck,
  dockerDaemonCheck,
  dockerGroupCheck,
  imageStoreCheck,
];
