import type { Transport } from './types.js';

export const PROBE_TIMEOUT_MS = 10_000;

export interface HostProbe {
  host: string;
  reachable: boolean;
  reason?: string;
  platform?: string;
  arch?: string;
}

export function normalizeArch(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'aarch64' || trimmed === 'arm64') {
    return 'arm64';
  }
  if (trimmed === 'x86_64' || trimmed === 'amd64') {
    return 'amd64';
  }
  return trimmed;
}

export function firstLine(text: string): string {
  return text.trim().split('\n')[0].trim();
}

export async function probeHost(
  name: string,
  transport: Transport,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HostProbe> {
  try {
    const result = await transport.exec('uname', ['-sm'], { timeoutMs });
    if (result.code !== 0) {
      const stderr = firstLine(result.stderr);
      return {
        host: name,
        reachable: false,
        reason: stderr === '' ? `uname -sm exited ${result.code}` : stderr,
      };
    }
    const [platform, machine] = result.stdout.trim().split(/\s+/);
    return {
      host: name,
      reachable: true,
      platform: platform === '' ? undefined : platform,
      arch: machine === undefined ? undefined : normalizeArch(machine),
    };
  } catch (error) {
    return { host: name, reachable: false, reason: (error as Error).message };
  }
}

export async function probeHosts(
  transports: ReadonlyMap<string, Transport>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HostProbe[]> {
  return Promise.all(
    [...transports].map(([name, transport]) =>
      probeHost(name, transport, timeoutMs),
    ),
  );
}
