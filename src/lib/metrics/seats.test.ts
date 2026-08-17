import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { FakeTransport, type Transport } from '../transport/index.js';
import {
  scrapeSeatMetrics,
  seatMetricsTargets,
  seatScrapeArgs,
} from './seats.js';

const CONFIG: GroveConfig = {
  tick: { fast: 120_000, full: 1_800_000 },
  hosts: {
    mac: { type: 'local' },
    atlas: { type: 'ssh', host: 'atlas' },
  },
  forges: {
    gl: { kind: 'gitlab', url: 'https://git.example.com' },
    gh: { kind: 'github' },
  },
  groups: [
    {
      name: 'dind',
      forge: 'gl',
      scope: { level: 'instance' },
      placement: { mac: 2, atlas: 1 },
      stack: 'docker',
      raw: { metrics_port: 9252 },
    },
    {
      name: 'plain',
      forge: 'gl',
      scope: { level: 'instance' },
      placement: { mac: 1 },
      stack: 'docker',
    },
    {
      name: 'actions',
      forge: 'gh',
      scope: { level: 'organization', target: 'Acme' },
      placement: { mac: 1 },
      stack: 'docker',
      raw: { metrics_port: 9300 },
    },
  ],
} as unknown as GroveConfig;

describe('seatMetricsTargets', () => {
  it('names one target per GitLab seat that publishes a port', () => {
    expect(seatMetricsTargets(CONFIG)).toEqual([
      { host: 'mac', runner: 'grove-dind-1', port: 9252 },
      { host: 'mac', runner: 'grove-dind-2', port: 9253 },
      { host: 'atlas', runner: 'grove-dind-3', port: 9254 },
    ]);
  });

  it('names nothing for a GitHub group, whose runner exposes no metrics', () => {
    expect(
      seatMetricsTargets(CONFIG).some((target) =>
        target.runner.startsWith('grove-actions'),
      ),
    ).toBe(false);
  });
});

describe('seatScrapeArgs', () => {
  it('asks the host loopback with a timeout', () => {
    expect(seatScrapeArgs(9252)).toEqual([
      '-sS',
      '--max-time',
      '5',
      'http://127.0.0.1:9252/metrics',
    ]);
  });
});

describe('scrapeSeatMetrics', () => {
  const BODY = ['# HELP jobs Jobs.', '# TYPE jobs counter', 'jobs 3', ''].join(
    '\n',
  );

  it('labels each seat body with its runner and its host', async () => {
    const mac = new FakeTransport('mac').on('curl', { stdout: BODY });
    const blocks = await scrapeSeatMetrics(
      new Map<string, Transport>([['mac', mac]]),
      [{ host: 'mac', runner: 'grove-dind-1', port: 9252 }],
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(
      'jobs{grove_runner="grove-dind-1",host="mac"} 3',
    );
    expect(blocks[0]).toContain('# TYPE jobs counter');
  });

  it('skips a seat whose curl failed, and keeps the others', async () => {
    const mac = new FakeTransport('mac').on('curl', { stdout: BODY });
    const atlas = new FakeTransport('atlas').fail(
      'curl',
      'curl: (7) Failed to connect to 127.0.0.1 port 9252',
      7,
    );
    const blocks = await scrapeSeatMetrics(
      new Map<string, Transport>([
        ['mac', mac],
        ['atlas', atlas],
      ]),
      [
        { host: 'mac', runner: 'grove-dind-1', port: 9252 },
        { host: 'atlas', runner: 'grove-dind-2', port: 9252 },
      ],
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('runner="grove-dind-1"');
  });

  it('skips a seat whose host has no transport', async () => {
    expect(
      await scrapeSeatMetrics(new Map<string, Transport>(), [
        { host: 'gone', runner: 'grove-dind-1', port: 9252 },
      ]),
    ).toEqual([]);
  });

  it('never throws when the transport does', async () => {
    const atlas = new FakeTransport('atlas').throwOn('curl', 'ssh dropped');
    expect(
      await scrapeSeatMetrics(new Map<string, Transport>([['atlas', atlas]]), [
        { host: 'atlas', runner: 'grove-dind-1', port: 9252 },
      ]),
    ).toEqual([]);
  });
});
