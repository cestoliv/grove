import { describe, expect, it } from 'vitest';
import { dfArgs, parseDf } from './disk.js';

const MAC_DF = [
  'Filesystem 1024-blocks      Used Available Capacity  Mounted on',
  '/dev/disk3s5  971350180 123456789 800000000      14%  /Volumes/ci',
  '',
].join('\n');

const LINUX_DF = [
  'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  '/dev/mapper/vg-root 103080888  91234567   6543210      94% /',
  '',
].join('\n');

describe('dfArgs', () => {
  it('asks for the portable output in kilobytes', () => {
    expect(dfArgs('/Volumes/ci/grove')).toEqual(['-Pk', '/Volumes/ci/grove']);
  });
});

describe('parseDf', () => {
  it('reads the macOS output', () => {
    expect(parseDf(MAC_DF)).toEqual({
      totalBytes: 971_350_180 * 1024,
      usedBytes: 123_456_789 * 1024,
      freeBytes: 800_000_000 * 1024,
      capacityPercent: 14,
      mountPoint: '/Volumes/ci',
    });
  });

  it('reads the Linux output', () => {
    expect(parseDf(LINUX_DF)?.capacityPercent).toBe(94);
    expect(parseDf(LINUX_DF)?.mountPoint).toBe('/');
  });

  it('reads a filesystem name that contains a space', () => {
    const text = [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      'my disk  100 40 60  40% /mnt/data',
    ].join('\n');
    expect(parseDf(text)?.freeBytes).toBe(60 * 1024);
    expect(parseDf(text)?.mountPoint).toBe('/mnt/data');
  });

  it('answers nothing when df said nothing usable', () => {
    expect(parseDf('')).toBeUndefined();
    expect(parseDf('df: /nowhere: No such file or directory')).toBeUndefined();
  });
});
