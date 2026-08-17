const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/**
 * Binary units with one decimal, because every number grove prints about a
 * disk comes from `df -Pk` or `du -sk`, which count in kibibytes. Docker
 * counts in decimal units and prints its own strings, which grove parses and
 * never reprints.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${Math.round(value)} B`
    : `${value.toFixed(1)} ${UNITS[unit]}`;
}
