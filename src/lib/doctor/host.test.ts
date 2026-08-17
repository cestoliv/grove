import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import { HOST_CHECKS, runHostChecks } from './host.js';
import { createHostContext } from './host-context.js';

const CONFIG: GroveConfig = {
  tick: { fast: 120_000, full: 1_800_000 },
  hosts: { atlas: { type: 'ssh', host: 'atlas', work_root: '/srv/grove' } },
  forges: { gh: { kind: 'github' } },
  groups: [
    {
      name: 'seat',
      forge: 'gh',
      scope: { level: 'organization', target: 'Acme' },
      placement: { atlas: 1 },
      stack: 'docker',
    },
  ],
} as unknown as GroveConfig;

describe('runHostChecks', () => {
  it('skips every other check when the host did not answer', async () => {
    const transport = new FakeTransport('atlas').fail(
      'uname -sm',
      'ssh: connect to host atlas port 22: Connection refused',
    );
    const context = createHostContext({
      host: 'atlas',
      config: CONFIG,
      transport,
    });

    const reports = await runHostChecks(context);

    expect(reports).toHaveLength(HOST_CHECKS.length);
    expect(reports[0]).toMatchObject({
      id: 'host.reachable',
      status: 'fail',
      target: { kind: 'host', name: 'atlas' },
    });
    for (const report of reports.slice(1)) {
      expect(report.status).toBe('skip');
      expect(report.summary).toContain('did not answer');
    }
    // Nothing after the probe was asked, so one command left this machine.
    expect(transport.commandLines()).toEqual(['uname -sm']);
  });

  it('runs every check on a host that answered, and tags each with the target', async () => {
    const transport = new FakeTransport('atlas')
      .on('uname -sm', { stdout: 'Linux x86_64\n' })
      .on('sh -c printf %s ok', { stdout: 'ok' })
      .on('sh -c printf %s "$HOME"', { stdout: '/home/ci' })
      .on('id -u', { stdout: '1000\n' })
      .on('date +%s', { stdout: String(Math.floor(Date.now() / 1000)) })
      .on('docker version', { stdout: '27.1.1\n' })
      .on('docker system df', { stdout: 'Images\t2GB\t0B (0%)\n' })
      .on('df -Pk', {
        stdout: [
          'Filesystem 1024-blocks Used Available Capacity Mounted on',
          '/dev/sda1 100000000 1000 90000000 10% /',
        ].join('\n'),
      })
      .on('test -d', { code: 0 })
      .on('test -w', { code: 0 })
      .on('systemctl --user is-system-running', { stdout: 'running\n' })
      .on('sh -c loginctl', { stdout: 'Linger=yes\n' })
      .on('sh -c set --', { stdout: 'grove-seat-1\t1024\n' })
      .setFallback({ code: 0, stdout: '', stderr: '' });

    const context = createHostContext({
      host: 'atlas',
      config: CONFIG,
      transport,
    });

    const reports = await runHostChecks(context);

    expect(reports.map((report) => report.id)).toEqual(
      HOST_CHECKS.map((check) => check.id),
    );
    expect(reports.every((report) => report.target.name === 'atlas')).toBe(
      true,
    );
    expect(reports.some((report) => report.status === 'fail')).toBe(false);
  });

  it('turns a check that throws into a fail rather than losing the pass', async () => {
    const transport = new FakeTransport('atlas')
      .on('uname -sm', { stdout: 'Linux x86_64\n' })
      .throwOn('sh -c printf %s ok', 'the connection dropped')
      .setFallback({ code: 0, stdout: '', stderr: '' });

    const context = createHostContext({
      host: 'atlas',
      config: CONFIG,
      transport,
    });

    const reports = await runHostChecks(context);
    const shell = reports.find((report) => report.id === 'host.shell');

    expect(shell?.status).toBe('fail');
    expect(shell?.summary).toContain('the connection dropped');
    expect(reports).toHaveLength(HOST_CHECKS.length);
  });

  it('lists the twenty checks the spec names, in printing order', () => {
    expect(HOST_CHECKS.map((check) => check.id)).toEqual([
      'host.reachable',
      'host.shell',
      'host.platform',
      'host.clock',
      'host.disk',
      'host.docker-cli',
      'host.docker-daemon',
      'host.docker-group',
      'host.image-store',
      'host.work-root-exists',
      'host.work-root-writable',
      'host.work-root-volume',
      'host.work-dirs',
      'host.systemd-user',
      'host.lingering',
      'host.launchd',
      'host.xcode-select',
      'host.xcodebuild',
      'host.simulators',
      'host.curl',
    ]);
  });
});
