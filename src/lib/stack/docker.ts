import { firstLine, shellQuote, type Transport } from '../transport/index.js';
import {
  buildBuildArgs,
  buildRunArgs,
  type RunnerDirs,
  type RunnerSpec,
} from './docker-args.js';
import { PS_ARGS, parsePsOutput } from './docker-ps.js';
import {
  buildGitlabRunArgs,
  type GitlabRunnerSpec,
  gitlabSystemIdPath,
} from './gitlab-args.js';
import { type DockerContainer, StackError } from './types.js';

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

function assertConfigDir(dirs: RunnerDirs): void {
  const suffix = `/${dirs.group}-${dirs.index}-config`;
  if (!dirs.configDir.startsWith('/') || !dirs.configDir.endsWith(suffix)) {
    throw new Error(
      `refusing to wipe ${dirs.configDir}: it is not the config directory of ${dirs.name}`,
    );
  }
}

export interface SystemIdTarget {
  name: string;
  configDir: string;
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

  // config.toml lands here after registration and it carries the runner
  // authentication token, so nobody but the owner reads this directory.
  async prepareConfigDir(
    dirs: RunnerDirs,
    options: { wipe: boolean },
  ): Promise<void> {
    if (options.wipe) {
      assertConfigDir(dirs);
    }
    const config = shellQuote(dirs.configDir);
    const steps = [
      ...(options.wipe ? [`rm -rf ${config}`] : []),
      `mkdir -p ${config}`,
      `chmod 0700 ${config}`,
    ];
    const result = await this.transport.exec('sh', ['-c', steps.join(' && ')]);
    if (result.code !== 0) {
      throw new StackError(
        `${this.host}: cannot prepare ${dirs.configDir}: ${firstLine(result.stderr) || `exit ${result.code}`}`,
        this.host,
      );
    }
  }

  async createGitlabRunner(spec: GitlabRunnerSpec): Promise<string> {
    const { stdout } = await this.docker(
      buildGitlabRunArgs(spec),
      `docker run ${spec.name}`,
    );
    return stdout.trim();
  }

  // One exec for the whole host. gitlab-runner writes the file at first
  // start, so a container that has never run answers with nothing and the
  // next pass picks it up.
  async readSystemIds(
    targets: SystemIdTarget[],
  ): Promise<Record<string, string>> {
    if (targets.length === 0) {
      return {};
    }
    const positional = targets
      .flatMap((target) => [
        shellQuote(target.name),
        shellQuote(gitlabSystemIdPath(target.configDir)),
      ])
      .join(' ');
    const script = [
      `set -- ${positional}`,
      'while [ "$#" -gt 0 ]; do',
      `  if [ -r "$2" ]; then printf '%s\\t%s\\n' "$1" "$(cat "$2")"; fi`,
      '  shift 2',
      'done',
    ].join('\n');

    const result = await this.transport.exec('sh', ['-c', script]);
    if (result.code !== 0) {
      // A system id is a monitoring detail, never a decision input, so a
      // host that cannot answer keeps every other observation it gave.
      return {};
    }

    const ids: Record<string, string> = {};
    for (const line of result.stdout.split('\n')) {
      const [name, id] = line.split('\t');
      if (name !== undefined && id !== undefined && id.trim() !== '') {
        ids[name] = id.trim();
      }
    }
    return ids;
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
