import { describe, expect, it } from 'vitest';
import type { GroveConfig } from '../config/index.js';
import { buildUsageScript, parseUsage, seatWorkDirTargets } from './usage.js';

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
      placement: { mac: 2 },
      stack: 'docker',
    },
    {
      name: 'ios',
      forge: 'gh',
      scope: { level: 'organization', target: 'Acme' },
      placement: { mac: 1 },
      stack: 'native',
      work_root: '~/ci/ios',
    },
    {
      name: 'dind',
      forge: 'gh',
      scope: { level: 'organization', target: 'Acme' },
      placement: { atlas: 1 },
      stack: 'docker',
    },
  ],
} as unknown as GroveConfig;

describe('buildUsageScript and parseUsage', () => {
  it('measures every work dir on a host in one script', () => {
    const script = buildUsageScript([
      { name: 'grove-ios-1', workDir: '/Volumes/ci/grove/ios-1' },
    ]);
    expect(script).toContain("'grove-ios-1' '/Volumes/ci/grove/ios-1'");
    expect(script).toContain('du -sk');
  });

  it('reads kilobytes back as bytes', () => {
    const used = parseUsage('grove-ios-1\t2048\n');
    expect(used.get('grove-ios-1')).toBe(2048 * 1024);
  });
});

describe('seatWorkDirTargets', () => {
  it('names every seat placed on the host, one per index', () => {
    expect(seatWorkDirTargets(CONFIG, 'mac', '/Users/ci')).toEqual([
      { name: 'grove-arm-1', workDir: '/Volumes/ci/grove/arm-1' },
      { name: 'grove-arm-2', workDir: '/Volumes/ci/grove/arm-2' },
      { name: 'grove-ios-1', workDir: '/Users/ci/ci/ios/ios-1' },
    ]);
  });

  it('continues the group index across hosts, the way the planner does', () => {
    const spanning = {
      ...CONFIG,
      groups: [
        {
          name: 'span',
          forge: 'gh',
          scope: { level: 'organization', target: 'Acme' },
          placement: { mac: 2, atlas: 1 },
          stack: 'docker',
        },
      ],
    } as unknown as GroveConfig;

    expect(
      seatWorkDirTargets(spanning, 'mac').map((seat) => seat.name),
    ).toEqual(['grove-span-1', 'grove-span-2']);
    expect(
      seatWorkDirTargets(spanning, 'atlas').map((seat) => seat.name),
    ).toEqual(['grove-span-3']);
  });

  it('names nothing for a host no group is placed on', () => {
    expect(seatWorkDirTargets(CONFIG, 'nowhere')).toEqual([]);
  });
});
