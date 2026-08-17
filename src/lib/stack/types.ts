export type ContainerState =
  | 'created'
  | 'running'
  | 'restarting'
  | 'exited'
  | 'paused'
  | 'dead'
  | 'removing'
  | 'unknown';

export interface DockerContainer {
  name: string;
  containerId: string;
  state: ContainerState;
  image: string;
  // The human string docker prints, for example "Up 3 hours". grove shows it
  // in `status` rather than recomputing an uptime from an inspect call.
  status: string;
  createdAt: string;
}

export class StackError extends Error {
  readonly host: string;

  constructor(message: string, host: string) {
    super(message);
    this.name = 'StackError';
    this.host = host;
  }
}

// How long a runner may finish the job it holds before grove stops waiting.
// It lives here rather than beside the Docker stack, because the native
// systemd unit carries it as TimeoutStopSec and must not import DockerStack.
export const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;

// A supervisor lists what it loaded, so grove only ever sees a seat it knows
// about as running or stopped. A seat it does not list is missing, and that
// is the absence of a NativeUnit rather than a state of one.
export type NativeUnitState = 'running' | 'stopped';

export interface NativeUnit {
  // The grove runner name, so everything above the stack seam keeps working
  // on the one name convention it already has.
  name: string;
  // The launchd label on macOS, the systemd unit name on Linux.
  unit: string;
  state: NativeUnitState;
  pid?: number;
  // The human string the supervisor gave, shown in `status`.
  detail: string;
}
