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
