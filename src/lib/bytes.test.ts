import { describe, expect, it } from 'vitest';
import { formatBytes } from './bytes.js';

describe('formatBytes', () => {
  it('prints bytes below a kibibyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('prints one decimal in binary units', () => {
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(12.3 * 1024 ** 3)).toBe('12.3 GiB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TiB');
  });

  it('prints a negative number as zero, because there is no negative disk', () => {
    expect(formatBytes(-1)).toBe('0 B');
  });
});
