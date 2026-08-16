import { describe, expect, it } from 'vitest';
import { isDuration, isSize, parseDuration, parseSize } from './units.js';

describe('parseDuration', () => {
  it('parses the durations the spec uses', () => {
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('90m')).toBe(5_400_000);
  });

  it('parses every supported unit', () => {
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('4h')).toBe(14_400_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('tolerates surrounding whitespace and fractions', () => {
    expect(parseDuration(' 1.5h ')).toBe(5_400_000);
  });

  it('rejects a value with no unit', () => {
    expect(() => parseDuration('90')).toThrow(/expected a duration/);
  });

  it('rejects an unknown unit', () => {
    expect(() => parseDuration('90w')).toThrow(/expected a duration/);
  });
});

describe('isDuration', () => {
  it('answers true only for parseable durations', () => {
    expect(isDuration('2m')).toBe(true);
    expect(isDuration('90')).toBe(false);
    expect(isDuration('')).toBe(false);
  });
});

describe('parseSize', () => {
  it('parses the size the spec uses', () => {
    expect(parseSize('120G')).toBe(120 * 1024 ** 3);
  });

  it('parses every supported unit and tolerates a trailing B', () => {
    expect(parseSize('512K')).toBe(512 * 1024);
    expect(parseSize('2M')).toBe(2 * 1024 ** 2);
    expect(parseSize('1T')).toBe(1024 ** 4);
    expect(parseSize('20MB')).toBe(20 * 1024 ** 2);
    expect(parseSize('4096B')).toBe(4096);
  });

  it('is case insensitive', () => {
    expect(parseSize('120g')).toBe(120 * 1024 ** 3);
  });

  it('rejects a value with no unit', () => {
    expect(() => parseSize('120')).toThrow(/expected a size/);
  });
});

describe('isSize', () => {
  it('answers true only for parseable sizes', () => {
    expect(isSize('120G')).toBe(true);
    expect(isSize('120')).toBe(false);
  });
});
