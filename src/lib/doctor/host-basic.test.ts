import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import {
  clockCheck,
  diskCheck,
  platformCheck,
  reachableCheck,
  shellCheck,
} from './host-basic.js';
import { createHostContext } from './host-context.js';

const CONFIG: GroveConfig = {
  tick: { fast: 120_000, full: 1_800_000 },
  hosts: {
    mac: { type: 'local', work_root: '/Volumes/ci/grove' },
    atlas: { type: 'ssh', host: 'atlas', work_root: '/PROD/local/grove' },
  },
  forges: { gh: { kind: 'github' } },
  groups: [
    {
      name: 'arm',
      forge: 'gh',
      scope: { level: 'organization', target: 'Acme' },
      placement: { mac: 1 },
      stack: 'docker',
    },
  ],
} as unknown as GroveConfig;

function df(free: number, capacity: number): string {
  return [
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    `/dev/disk3s5 100000000 1000 ${free} ${capacity}% /Volumes/ci`,
  ].join('\n');
}

function contextFor(transport: FakeTransport, now?: () => number) {
  return createHostContext({
    host: 'mac',
    config: CONFIG,
    transport,
    ...(now === undefined ? {} : { now }),
  });
}

describe('reachableCheck', () => {
  it('passes a host that answered uname', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('uname -sm', { stdout: 'Darwin arm64\n' }),
    );
    const [result] = await reachableCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('Darwin');
  });

  it('fails a host that did not, and names the ssh alias in the fix', async () => {
    const transport = new FakeTransport('atlas').fail(
      'uname -sm',
      'ssh: Could not resolve hostname atlas',
    );
    const context = createHostContext({
      host: 'atlas',
      config: CONFIG,
      transport,
    });
    const [result] = await reachableCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('Could not resolve hostname');
    expect(result.fix).toContain('ssh atlas');
  });
});

describe('shellCheck', () => {
  it('passes a host whose sh runs a command', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('sh -c printf %s ok', { stdout: 'ok' }),
    );
    const [result] = await shellCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('fails a host whose shell answered something else', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('sh -c printf %s ok', {
        stdout: 'Welcome to the server!\nok',
      }),
    );
    const [result] = await shellCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('login shell');
  });
});

describe('platformCheck', () => {
  it('reports the platform and the architecture', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('uname -sm', { stdout: 'Darwin arm64\n' }),
    );
    const [result] = await platformCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('Darwin arm64');
  });

  it('warns about a platform grove does not manage', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('uname -sm', { stdout: 'FreeBSD amd64\n' }),
    );
    const [result] = await platformCheck.run(context);
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('macOS or Linux');
  });
});

describe('clockCheck', () => {
  it('passes a host whose clock agrees with the control node', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('date +%s', { stdout: '1700000000\n' }),
      () => 1_700_000_000_000,
    );
    const [result] = await clockCheck.run(context);
    expect(result.status).toBe('ok');
  });

  it('warns past thirty seconds', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('date +%s', { stdout: '1700000045\n' }),
      () => 1_700_000_000_000,
    );
    const [result] = await clockCheck.run(context);
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('timedatectl');
  });

  it('fails past five minutes', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('date +%s', { stdout: '1700000600\n' }),
      () => 1_700_000_000_000,
    );
    const [result] = await clockCheck.run(context);
    expect(result.status).toBe('fail');
  });

  it('fails a host whose date printed nothing usable', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('date +%s', { stdout: 'now\n' }),
      () => 1_700_000_000_000,
    );
    const [result] = await clockCheck.run(context);
    expect(result.status).toBe('fail');
  });
});

describe('diskCheck', () => {
  it('passes a work root with room, and names the root as the subject', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('df -Pk', { stdout: df(80_000_000, 20) }),
    );
    const [result] = await diskCheck.run(context);
    expect(result.status).toBe('ok');
    expect(result.subject).toBe('/Volumes/ci/grove');
    expect(result.summary).toContain('free');
  });

  it('warns under ten gibibytes', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('df -Pk', { stdout: df(5_000_000, 60) }),
    );
    const [result] = await diskCheck.run(context);
    expect(result.status).toBe('warn');
  });

  it('warns over ninety percent full even with room left', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('df -Pk', { stdout: df(50_000_000, 95) }),
    );
    const [result] = await diskCheck.run(context);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('95%');
  });

  it('fails under one gibibyte', async () => {
    const context = contextFor(
      new FakeTransport('mac').on('df -Pk', { stdout: df(500_000, 99) }),
    );
    const [result] = await diskCheck.run(context);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('max_work_size');
  });

  it('fails a work root df could not measure', async () => {
    const context = contextFor(
      new FakeTransport('mac').fail(
        'df -Pk',
        'df: /Volumes/ci/grove: No such file or directory',
      ),
    );
    const [result] = await diskCheck.run(context);
    expect(result.status).toBe('fail');
  });
});
