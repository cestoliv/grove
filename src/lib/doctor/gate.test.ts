import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openFleet } from '../../commands/context.js';
import { StateStore } from '../state/index.js';
import { FakeTransport } from '../transport/index.js';
import { checkNewHosts, doctorMetaKey } from './gate.js';

const CONFIG = `
hosts:
  mac: { type: local, work_root: /srv/grove }
  atlas: { type: ssh, host: atlas, work_root: /srv/grove }

forges:
  gh: { kind: github }

groups:
  - name: a
    forge: gh
    scope: { level: organization, target: Acme }
    placement: { mac: 1, atlas: 1 }
`;

// The gate forwards its clock to `runChecks`, and `host.clock` compares the
// host's `date +%s` against it. One constant keeps the fixture and the
// injected clock in agreement, so no test depends on the wall clock.
const NOW = 1_700_000_000_000;

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-gate-'));
  store = StateStore.open(':memory:');
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

// FakeTransport answers with the first stub whose prefix matches, so a broken
// variant seeds the transport with its failing stub and lets the healthy
// defaults land behind it.
function healthy(name: string, seed = new FakeTransport(name)): FakeTransport {
  return seed
    .on('uname -sm', { stdout: 'Linux x86_64\n' })
    .on('sh -c printf %s ok', { stdout: 'ok' })
    .on('sh -c printf %s "$HOME"', { stdout: '/home/ci' })
    .on('id -u', { stdout: '1000\n' })
    .on('date +%s', { stdout: String(Math.floor(NOW / 1000)) })
    .on('docker version', { stdout: '27.1.1\n' })
    .on('docker system df', { stdout: 'Images\t2GB\t0B (0%)\n' })
    .on('df -Pk', {
      stdout: [
        'Filesystem 1024-blocks Used Available Capacity Mounted on',
        '/dev/sda1 100000000 1000 90000000 10% /',
      ].join('\n'),
    })
    .on('systemctl --user is-system-running', { stdout: 'running\n' })
    .on('sh -c loginctl', { stdout: 'Linger=yes\n' })
    .setFallback({ code: 0, stdout: '', stderr: '' });
}

function dockerDown(name: string): FakeTransport {
  return healthy(
    name,
    new FakeTransport(name).fail(
      'docker version',
      'Cannot connect to the Docker daemon.',
      1,
    ),
  );
}

async function fleetFor(transports: Record<string, FakeTransport>) {
  const path = join(dir, 'grove.yaml');
  await writeFile(path, CONFIG, 'utf8');
  return openFleet({
    config: path,
    connect: (name) => transports[name],
    store,
    forges: false,
  });
}

describe('doctorMetaKey', () => {
  it('names one key per host', () => {
    expect(doctorMetaKey('atlas')).toBe('doctor:atlas');
  });
});

describe('checkNewHosts', () => {
  it('checks every host grove has no record of and remembers the ones that passed', async () => {
    const fleet = await fleetFor({
      mac: healthy('mac'),
      atlas: healthy('atlas'),
    });
    try {
      const result = await checkNewHosts({ fleet, now: () => NOW });
      expect(result.checked.sort()).toEqual(['atlas', 'mac']);
      expect(result.blocked).toEqual([]);
      expect(store.getMeta(doctorMetaKey('mac'))).toBe('1700000000000');
      expect(store.getMeta(doctorMetaKey('atlas'))).toBe('1700000000000');
    } finally {
      await fleet.close();
    }
  });

  it('checks nothing on the second run, and touches no host', async () => {
    const transports = { mac: healthy('mac'), atlas: healthy('atlas') };
    const fleet = await fleetFor(transports);
    try {
      await checkNewHosts({ fleet, now: () => NOW });
      const before = transports.mac.calls.length;
      const again = await checkNewHosts({ fleet, now: () => NOW });
      expect(again.checked).toEqual([]);
      expect(again.report).toBeUndefined();
      expect(transports.mac.calls.length).toBe(before);
    } finally {
      await fleet.close();
    }
  });

  it('blocks the host that failed and remembers nothing about it', async () => {
    const fleet = await fleetFor({
      mac: healthy('mac'),
      atlas: dockerDown('atlas'),
    });
    try {
      const result = await checkNewHosts({ fleet, now: () => NOW });
      expect(result.blocked).toEqual(['atlas']);
      expect(store.getMeta(doctorMetaKey('atlas'))).toBeUndefined();
      // The healthy host is still recorded, so a later apply checks only the
      // one that is still broken.
      expect(store.getMeta(doctorMetaKey('mac'))).toBeDefined();
      expect(
        result.report?.checks.some((check) => check.status === 'fail'),
      ).toBe(true);
    } finally {
      await fleet.close();
    }
  });

  it('remembers nothing on a dry run', async () => {
    const fleet = await fleetFor({
      mac: healthy('mac'),
      atlas: healthy('atlas'),
    });
    try {
      const result = await checkNewHosts({
        fleet,
        now: () => NOW,
        dryRun: true,
      });
      expect(result.checked.sort()).toEqual(['atlas', 'mac']);
      expect(store.getMeta(doctorMetaKey('mac'))).toBeUndefined();
      expect(store.getMeta(doctorMetaKey('atlas'))).toBeUndefined();
    } finally {
      await fleet.close();
    }
  });

  it('checks only the host that is new when another was checked before', async () => {
    const transports = { mac: healthy('mac'), atlas: healthy('atlas') };
    const fleet = await fleetFor(transports);
    try {
      store.setMeta(doctorMetaKey('mac'), '1');
      const result = await checkNewHosts({ fleet, now: () => NOW });
      expect(result.checked).toEqual(['atlas']);
      expect(transports.mac.calls).toHaveLength(0);
    } finally {
      await fleet.close();
    }
  });
});
