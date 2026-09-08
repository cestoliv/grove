import type { GroupConfig, HostConfig, StackKind } from '../config/index.js';
import { parseManagedName } from '../naming.js';
import { buildNativeTarget, NativeStack } from '../stack/index.js';
import { shellQuote, type Transport } from '../transport/index.js';

// What one seat is running right now, as its own runner log tells it. The
// forges answer "busy" and nothing more, so the job a reader can name comes
// from the host or from nowhere.
export interface CurrentJob {
  label: string;
  // Absent when the log line carries no timestamp grove can read.
  startedAt?: number;
}

// A GitHub runner log is quiet between jobs, so its tail holds the job line
// however long the job runs.
export const JOB_LOG_TAIL = 60;

// A gitlab-runner log is not quiet: it appends the job trace to the
// coordinator every few seconds, which buried the start line of a
// two-minute job 26 lines deep. So the host greps for the lines that mark a
// job and grove reads the few that survive, rather than a tail long enough
// to hold the chatter of a job that runs for an hour.
export const JOB_MARKERS = [
  'Running job:',
  'completed with result:',
  'Shutting down runner listener',
  'Checking for jobs\\.\\.\\. received',
  'Job succeeded',
  'Job failed',
  'Removed job from processing list',
].join('|');

// A job grove would have killed long before this is not a job worth naming,
// and the bound keeps the read off the whole life of a container.
export const JOB_LOG_WINDOW = '24h';

// `2026-09-08 11:02:03Z: Running job: build`
const GITHUB_RUNNING = /Running job:\s*(\S.*?)\s*$/;
// A job ends when the runner says it ended, and also when the listener goes
// down under it. A seat that restarted mid-job holds a start line with no end
// after it, and naming that job would name one nobody is running.
const GITHUB_DONE =
  /Job\s+.+\s+completed with result:|Shutting down runner listener|Runner listener exit/;
const GITHUB_STAMP = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z):\s/;

// `Checking for jobs... received  job=123456 repo_url=https://host/foo/bar.git`
const GITLAB_RECEIVED = /Checking for jobs\.\.\.\s*received/;
const GITLAB_JOB_ID = /\bjob=(\d+)/;
const GITLAB_REPO = /\brepo_url=(\S+)/;
const GITLAB_DONE =
  /\bJob (?:succeeded|failed)\b|Removed job from processing list/;

// docker logs --timestamps: `2026-09-08T11:02:03.123456789Z <line>`
const DOCKER_STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.?\d*Z)\s/;

// gitlab-runner colours its output whether or not anything is watching, and
// it puts the escape between the field name and its `=`, so `job=123` reaches
// a reader as `job\x1b[0;m=123`. Every line is stripped before it is read.
// biome-ignore lint/suspicious/noControlCharactersInRegex: an ANSI escape is a control character
const ANSI = /\x1b\[[0-9;]*m/g;

function stampOf(line: string): number | undefined {
  const stamp = DOCKER_STAMP.exec(line)?.[1] ?? GITHUB_STAMP.exec(line)?.[1];
  if (stamp === undefined) {
    return undefined;
  }
  // The GitHub stamp is a space away from ISO 8601, and both are UTC.
  const ms = Date.parse(stamp.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : undefined;
}

function gitlabLabel(line: string): string {
  const id = GITLAB_JOB_ID.exec(line)?.[1];
  const repo = GITLAB_REPO.exec(line)?.[1];
  const project = repo?.replace(/^\w+:\/\/[^/]+\//, '').replace(/\.git$/, '');
  const job = id === undefined ? 'job' : `#${id}`;
  return project === undefined || project === '' ? job : `${project} ${job}`;
}

/**
 * The job a runner log ends on. Whichever marker comes last wins: a start
 * with no end after it is a running job, an end after it is an idle seat.
 * Anything else, including a tail that starts mid-job, answers nothing rather
 * than naming a job that already finished.
 */
export function parseCurrentJob(text: string): CurrentJob | undefined {
  const lines = text.replace(ANSI, '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (GITHUB_DONE.test(line) || GITLAB_DONE.test(line)) {
      return undefined;
    }
    const github = GITHUB_RUNNING.exec(line);
    if (github !== null) {
      const startedAt = stampOf(line);
      return {
        label: github[1],
        ...(startedAt === undefined ? {} : { startedAt }),
      };
    }
    if (GITLAB_RECEIVED.test(line)) {
      const startedAt = stampOf(line);
      return {
        label: gitlabLabel(line),
        ...(startedAt === undefined ? {} : { startedAt }),
      };
    }
  }
  return undefined;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export interface CurrentJobRead {
  transport: Transport;
  host: string;
  runner: string;
  stack: StackKind;
  // Native seats only: what `buildNativeTarget` needs to find the log files.
  group?: GroupConfig;
  hostConfig?: HostConfig;
  home?: string;
  platform?: string;
  uid?: string;
}

/**
 * One log tail for one busy seat. Nothing here throws: this runs inside
 * `status`, and a seat whose log cannot be read must cost the report a cell,
 * never the run.
 */
export async function readCurrentJob(
  read: CurrentJobRead,
): Promise<CurrentJob | undefined> {
  try {
    if (read.stack === 'docker') {
      // `--timestamps` because gitlab-runner stamps no line of its own, and
      // `2>&1` because which stream carries the job line is the runner's
      // business, not grove's.
      const result = await read.transport.exec('sh', [
        '-c',
        `docker logs --timestamps --since ${JOB_LOG_WINDOW} ${shellQuote(read.runner)} 2>&1 | grep -E ${shellQuote(JOB_MARKERS)} | tail -n ${JOB_LOG_TAIL}`,
      ]);
      return parseCurrentJob(result.stdout);
    }
    const parsed = parseManagedName(read.runner);
    if (
      parsed === null ||
      read.group === undefined ||
      read.hostConfig === undefined ||
      read.home === undefined
    ) {
      return undefined;
    }
    const native = new NativeStack({
      transport: read.transport,
      host: read.host,
      platform: read.platform ?? 'Linux',
      ...(read.uid === undefined ? {} : { uid: read.uid }),
    });
    let text = '';
    await native.logs(
      buildNativeTarget({
        group: read.group,
        host: read.hostConfig,
        index: parsed.index,
        home: read.home,
      }),
      {
        tail: JOB_LOG_TAIL,
        onChunk: (chunk) => {
          text += chunk;
        },
      },
    );
    // Only GitHub runs native, and it stamps its own lines, so a journal
    // without stamps of its own still dates the job.
    return parseCurrentJob(text);
  } catch {
    return undefined;
  }
}
