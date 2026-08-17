import { assertRunnerWorkDir } from '../naming.js';
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
  GITLAB_CONFIG_DIR,
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
  // One implementation of the work-dir guard, shared with the daemon's
  // pruner, so a path that is unsafe to wipe here is unsafe to prune there.
  assertRunnerWorkDir(dirs.workDir, dirs.name);
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

/**
 * The last line a failed `docker build` is really about.
 *
 * BuildKit streams its progress to stderr, so the first line of a failed
 * build is `#0 building with "orbstack" instance using docker driver` and the
 * cause is at the far end. BuildKit marks that cause with `ERROR:`, and it
 * prints one such line per failed step, the last of which is the one that
 * ended the build. A legacy builder writes no marker at all, and there the
 * last line it managed to print is the error.
 */
export function buildFailureLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) {
    return '';
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('ERROR:')) {
      return lines[index];
    }
  }
  return lines[lines.length - 1];
}

/**
 * One script for the whole host, in the shape `buildActivityScript` also
 * uses: the paths ride in as positional parameters, so nothing is quoted
 * twice and no path ever reaches the shell as part of the program text.
 *
 * The host file is read first and the container asked only when that comes
 * back empty. On a Linux host gitlab-runner runs as root and writes
 * `.runner_system_id` `root:root 0600` into the bind-mounted config dir, so an
 * unprivileged ssh user cannot read it while the container reads the very same
 * file without trouble. Both copies are that one file, so the exec answers
 * nothing new where the read already worked, and this way a host that can read
 * its own file pays no exec at all rather than one per seat per pass.
 */
export function buildSystemIdScript(targets: SystemIdTarget[]): string {
  const positional = targets
    .flatMap((target) => [
      shellQuote(target.name),
      shellQuote(gitlabSystemIdPath(target.configDir)),
    ])
    .join(' ');
  const inContainer = shellQuote(gitlabSystemIdPath(GITLAB_CONFIG_DIR));
  return [
    `set -- ${positional}`,
    'while [ "$#" -gt 0 ]; do',
    '  sid=""',
    '  if [ -r "$2" ]; then sid=$(cat "$2" 2>/dev/null); fi',
    `  if [ -z "$sid" ]; then sid=$(docker exec "$1" cat ${inContainer} 2>/dev/null); fi`,
    `  if [ -n "$sid" ]; then printf '%s\\t%s\\n' "$1" "$sid"; fi`,
    '  shift 2',
    'done',
  ].join('\n');
}

export class DockerStack {
  readonly host: string;
  private readonly transport: Transport;

  constructor(options: DockerStackOptions) {
    this.transport = options.transport;
    this.host = options.host;
  }

  // Most docker commands say what went wrong on their first line of stderr.
  // `build` is the exception, and it passes the picker that reads its own
  // shape.
  private async docker(
    args: string[],
    what: string,
    pickLine: (stderr: string) => string = firstLine,
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await this.transport.exec('docker', args);
    if (result.code !== 0) {
      throw new StackError(
        `${this.host}: ${what} failed: ${pickLine(result.stderr) || `exit ${result.code}`}`,
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
      buildFailureLine,
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

  // One exec for the whole host, reading the host file first and asking the
  // container only where that file cannot be read. gitlab-runner writes the
  // file at first start, so a container that has never run answers with
  // nothing and the next pass picks it up.
  async readSystemIds(
    targets: SystemIdTarget[],
  ): Promise<Record<string, string>> {
    if (targets.length === 0) {
      return {};
    }

    const result = await this.transport.exec('sh', [
      '-c',
      buildSystemIdScript(targets),
    ]);
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
