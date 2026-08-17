export const DF_KILOBYTE = 1024;

// -P fixes the columns to one line per filesystem on both macOS and Linux,
// and -k fixes the block size, so the numbers mean the same thing everywhere.
export function dfArgs(path: string): string[] {
  return ['-Pk', path];
}

export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  capacityPercent: number;
  mountPoint: string;
}

// Read from the right. A filesystem name can contain a space, and the four
// numbers before the mount point cannot, so anchoring on them is the only
// split that survives `//server/my share` and `/dev/disk3s5` alike.
const DF_LINE = /(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\S.*)$/;

export function parseDf(text: string): DiskUsage | undefined {
  for (const line of text.split('\n').slice(1)) {
    const match = DF_LINE.exec(line.trim());
    if (match === null) {
      continue;
    }
    return {
      totalBytes: Number(match[1]) * DF_KILOBYTE,
      usedBytes: Number(match[2]) * DF_KILOBYTE,
      freeBytes: Number(match[3]) * DF_KILOBYTE,
      capacityPercent: Number(match[4]),
      mountPoint: match[5].trim(),
    };
  }
  return undefined;
}
