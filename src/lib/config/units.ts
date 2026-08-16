const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*([bkmgt])b?$/i;

export const DURATION_HINT = 'expected a duration like 30s, 2m, 90m, 4h or 1d';
export const SIZE_HINT = 'expected a size like 512M, 120G or 2T';

export function parseDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (match === null) {
    throw new RangeError(`${DURATION_HINT}, got ${JSON.stringify(value)}`);
  }
  return Math.round(Number(match[1]) * DURATION_UNITS[match[2]]);
}

export function isDuration(value: string): boolean {
  return DURATION_PATTERN.test(value.trim());
}

export function parseSize(value: string): number {
  const match = SIZE_PATTERN.exec(value.trim());
  if (match === null) {
    throw new RangeError(`${SIZE_HINT}, got ${JSON.stringify(value)}`);
  }
  return Math.round(Number(match[1]) * SIZE_UNITS[match[2].toUpperCase()]);
}

export function isSize(value: string): boolean {
  return SIZE_PATTERN.test(value.trim());
}
