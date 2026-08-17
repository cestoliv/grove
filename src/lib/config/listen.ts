export const LISTEN_HINT =
  'expected an address like 127.0.0.1:9130 or [::1]:9130, with an explicit host';

// A bare :9130 means every interface in Go's convention, and this endpoint
// should never bind every interface by accident. Naming the host is nine
// characters and removes the whole class of surprise.
const BRACKETED = /^\[([^\]]+)\]:(\d+)$/;
const PLAIN = /^([^:]+):(\d+)$/;
const LOOPBACK_V4 = /^127\./;

export interface ListenAddress {
  host: string;
  port: number;
}

export function parseListen(value: string): ListenAddress {
  const trimmed = value.trim();
  const match = BRACKETED.exec(trimmed) ?? PLAIN.exec(trimmed);
  if (match === null) {
    throw new RangeError(`${LISTEN_HINT}, got ${JSON.stringify(value)}`);
  }
  const host = match[1];
  const port = Number(match[2]);
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`${LISTEN_HINT}, got ${JSON.stringify(value)}`);
  }
  return { host, port };
}

export function isListen(value: string): boolean {
  try {
    parseListen(value);
    return true;
  } catch {
    return false;
  }
}

export function isLoopback(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === 'localhost' || value === '::1' || LOOPBACK_V4.test(value);
}
