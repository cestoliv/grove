import { firstLine, shellQuote, type Transport } from '../transport/index.js';
import {
  buildBuildArgs,
  buildRunArgs,
  type RunnerDirs,
  type RunnerSpec,
} from './docker-args.js';
import { PS_ARGS, parsePsOutput } from './docker-ps.js';
import { type DockerContainer, StackError } from './types.js';

export const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;

export interface DockerStackOptions {
  transport: Transport;
  host: string;
}

export interface LogsOptions {
  tail?: number;
  follow?: boolean;
  onChunk: (chunk: string) => void;
}

function assertRunnerDir(dirs: RunnerDirs): void {
  const suffix = `/${dirs.group}-${dirs.index}`;
  if (!dirs.workDir.startsWith('/') || !dirs.workDir.endsWith(suffix)) {
    throw new Error(
      `refusing to wipe ${dirs.workDir}: it is not the work directory of ${dirs.name}`,
    );
  }
}

export class DockerStack {
  readonly host: string;
  private readonly transport: Transport;

  constructor(options: DockerStackOptions) {
    this.transport = options.transport;
    this.host = options.host;
  }

  private async docker(
    args: string[],
    what: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await this.transport.exec('docker', args);
    if (result.code !== 0) {
      throw new StackError(
        `${this.host}: ${what} failed: ${firstLine(result.stderr) || `exit ${result.code}`}`,
        this.host,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  async listContainers(): Promise<DockerContainer[]> {
    const { stdout } = await this.docker(PS_ARGS, 'docker ps');
    return parsePsOutput(stdout);
  }

  async build(tag: string, dockerfile: string, arch?: string): Promise<void> {
    await this.docker(
      buildBuildArgs(tag, dockerfile, arch),
      `docker build ${tag}`,
    );
  }

  async prepareDirs(
    dirs: RunnerDirs,
    options: { wipe: boolean },
  ): Promise<void> {
    assertRunnerDir(dirs);
    const work = shellQuote(dirs.workDir);
    const cache = shellQuote(dirs.cacheDir);
    const steps = [
      ...(options.wipe ? [`rm -rf ${work}`] : []),
      `mkdir -p ${work} ${cache}`,
      // The runner runs as an unprivileged user inside the container and the
      // bind mount carries host ownership. chown would need root on the host.
      `chmod 0777 ${work} ${cache}`,
    ];
    const result = await this.transport.exec('sh', ['-c', steps.join(' && ')]);
    if (result.code !== 0) {
      throw new StackError(
        `${this.host}: cannot prepare ${dirs.workDir}: ${firstLine(result.stderr) || `exit ${result.code}`}`,
        this.host,
      );
    }
  }

  async create(spec: RunnerSpec): Promise<string> {
    const { stdout } = await this.docker(
      buildRunArgs(spec),
      `docker run ${spec.name}`,
    );
    return stdout.trim();
  }

  async start(name: string): Promise<void> {
    await this.docker(['start', name], `docker start ${name}`);
  }

  async stop(name: string, drainTimeoutMs: number): Promise<void> {
    // `-t 0` is a force kill, and the executor asks for it by passing 0 when
    // the operator used `--force`. Any drain the config actually asked for
    // rounds up to a second, so 400ms never turns into a kill by accident.
    const seconds =
      drainTimeoutMs <= 0 ? 0 : Math.max(1, Math.round(drainTimeoutMs / 1000));
    await this.docker(
      ['stop', '-t', String(seconds), name],
      `docker stop ${name}`,
    );
  }

  async remove(name: string): Promise<void> {
    const result = await this.transport.exec('docker', ['rm', '-f', name]);
    if (result.code === 0 || /no such container/i.test(result.stderr)) {
      return;
    }
    throw new StackError(
      `${this.host}: docker rm ${name} failed: ${firstLine(result.stderr) || `exit ${result.code}`}`,
      this.host,
    );
  }

  async logs(name: string, options: LogsOptions): Promise<number> {
    const args = ['logs'];
    if (options.follow === true) {
      args.push('--follow');
    }
    if (options.tail !== undefined) {
      args.push('--tail', String(options.tail));
    }
    args.push(name);
    const result = await this.transport.exec('docker', args, {
      onStdout: options.onChunk,
      onStderr: options.onChunk,
    });
    return result.code;
  }
}
