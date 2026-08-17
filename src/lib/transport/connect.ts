import type { HostConfig } from '../config/schema.js';
import { LocalTransport } from './local.js';
import { SshTransport, type SshTransportOptions } from './ssh.js';
import type { SpawnFn, Transport } from './types.js';

export interface ConnectOptions {
  spawnFn?: SpawnFn;
  ssh?: SshTransportOptions;
}

// The third parameter is optional, so every caller and every test double that
// takes two arguments still satisfies it.
export type ConnectFn = (
  name: string,
  host: HostConfig,
  options?: ConnectOptions,
) => Transport;

export function connect(
  name: string,
  host: HostConfig,
  options: ConnectOptions = {},
): Transport {
  if (host.type === 'local') {
    return new LocalTransport(name, options.spawnFn);
  }
  return new SshTransport(name, host.host, {
    spawnFn: options.spawnFn,
    ...options.ssh,
  });
}
