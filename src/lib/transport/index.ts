export {
  type ConnectFn,
  type ConnectOptions,
  connect,
} from './connect.js';
export { FakeTransport } from './fake.js';
export { LocalTransport } from './local.js';
export {
  firstLine,
  type HostProbe,
  normalizeArch,
  PROBE_TIMEOUT_MS,
  probeHost,
} from './probe.js';
export { runProcess, TIMEOUT_EXIT_CODE } from './process.js';
export {
  buildRemoteCommand,
  buildSshArgs,
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_CONTROL_PERSIST,
  SSH_CONTROL_DIR,
  type SshArgvOptions,
  SshTransport,
  type SshTransportOptions,
  shellQuote,
} from './ssh.js';
export type {
  ExecOptions,
  ExecResult,
  RecordedCall,
  SpawnFn,
  Transport,
} from './types.js';
