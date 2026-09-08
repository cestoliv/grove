import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../transport/index.js';
import {
  formatElapsed,
  parseCurrentJob,
  readCurrentJob,
} from './current-job.js';

const GITHUB_RUNNING = [
  '2026-09-08 10:59:00Z: Listening for Jobs',
  '2026-09-08 11:02:03Z: Running job: build (macos)',
  '',
].join('\n');

const GITHUB_DONE = [
  GITHUB_RUNNING,
  '2026-09-08 11:09:41Z: Job build (macos) completed with result: Succeeded',
  '2026-09-08 11:09:42Z: Listening for Jobs',
  '',
].join('\n');

// Copied off grove-chevro-dind-1 on atlas: gitlab-runner 19.0.1 colours its
// fields, so the escape sits between the field name and its `=`.
const ESC = String.fromCharCode(27);
const GITLAB_COLOURED = [
  `2026-09-08T11:02:03.500000000Z Checking for jobs... received                     ${ESC}[0;m  job${ESC}[0;m=123456 repo_url${ESC}[0;m=https://git.chevro.fr/foo/bar.git runner${ESC}[0;m=TuHkfU9eQ`,
  '',
].join('\n');

// Copied off overload-macos-2-runner on hyppolite: the listener was killed
// mid-job, so the log holds a start with no completion after it.
const GITHUB_RESTARTED = [
  '2026-09-08 06:03:17Z: Running job: Build APK (dev)',
  'Shutting down runner listener',
  'Sending SIGINT to runner listener to stop',
  'Runner listener exited with error code null',
  '',
].join('\n');

const GITLAB_RUNNING = [
  '2026-09-08T11:00:00.100000000Z Checking for jobs... nothing              runner=t1_abc',
  '2026-09-08T11:02:03.500000000Z Checking for jobs... received             job=123456 repo_url=https://gitlab.com/foo/bar.git runner=t1_abc',
  '',
].join('\n');

describe('parseCurrentJob', () => {
  it('names the job a GitHub runner is on, and dates it from its own stamp', () => {
    expect(parseCurrentJob(GITHUB_RUNNING)).toEqual({
      label: 'build (macos)',
      startedAt: Date.parse('2026-09-08T11:02:03Z'),
    });
  });

  it('names the job and project a gitlab-runner picked up', () => {
    expect(parseCurrentJob(GITLAB_RUNNING)).toEqual({
      label: 'foo/bar #123456',
      startedAt: Date.parse('2026-09-08T11:02:03.5Z'),
    });
  });

  it('reads through the colours gitlab-runner writes', () => {
    expect(parseCurrentJob(GITLAB_COLOURED)).toEqual({
      label: 'foo/bar #123456',
      startedAt: Date.parse('2026-09-08T11:02:03.5Z'),
    });
  });

  it('answers nothing for a job the listener died under', () => {
    expect(parseCurrentJob(GITHUB_RESTARTED)).toBeUndefined();
  });

  it('answers nothing once the job finished', () => {
    expect(parseCurrentJob(GITHUB_DONE)).toBeUndefined();
    expect(
      parseCurrentJob(
        `${GITLAB_RUNNING}2026-09-08T11:08:00.000000000Z Job succeeded                 duration_s=357\n`,
      ),
    ).toBeUndefined();
  });

  it('answers nothing for a log with no job marker in the tail', () => {
    expect(parseCurrentJob('')).toBeUndefined();
    expect(
      parseCurrentJob('2026-09-08 11:00:00Z: Listening for Jobs\n'),
    ).toBeUndefined();
  });

  it('keeps the job when the line carries no timestamp', () => {
    expect(parseCurrentJob('Running job: build\n')).toEqual({
      label: 'build',
    });
  });
});

// The three lines the host filter leaves behind after job 4725 ran on
// grove-chevro-dind-1, copied off atlas. gitlab-runner appends the job trace
// every few seconds, so the start line sat 26 lines deep in a job that ran
// for two minutes, and a plain tail would have lost it.
describe('a real gitlab-runner job', () => {
  const RECEIVED = `2026-09-08T07:09:10.969676093Z Checking for jobs... received                     ${ESC}[0;m  correlation_id${ESC}[0;m=01M1ZXJV0HGEGNH7TM86CQJAH4 job${ESC}[0;m=4725 repo_url${ESC}[0;m=https://git.chevro.fr/cestoliv/signature-interieur.git runner${ESC}[0;m=TuHkfU9eQ runner_name${ESC}[0;m=grove-chevro-dind-1`;
  const SUCCEEDED = `2026-09-08T07:11:15.721285703Z Job succeeded                                     ${ESC}[0;m  duration_s${ESC}[0;m=124.513574558 job${ESC}[0;m=4725 job-status${ESC}[0;m=success project_full_path${ESC}[0;m=cestoliv/signature-interieur runner_name${ESC}[0;m=grove-chevro-dind-1`;
  const REMOVED = `2026-09-08T07:11:15.975898686Z Removed job from processing list                  ${ESC}[0;m  builds${ESC}[0;m=0 job${ESC}[0;m=4725 queue_depth${ESC}[0;m=1 runner_name${ESC}[0;m=grove-chevro-dind-1`;

  it('names it while it runs', () => {
    expect(parseCurrentJob(`${RECEIVED}\n`)).toEqual({
      label: 'cestoliv/signature-interieur #4725',
      startedAt: Date.parse('2026-09-08T07:09:10.969Z'),
    });
  });

  it('lets it go once the runner drops it', () => {
    expect(
      parseCurrentJob([RECEIVED, SUCCEEDED, REMOVED, ''].join('\n')),
    ).toBeUndefined();
  });
});

describe('formatElapsed', () => {
  it('scales the unit to the wait', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(12 * 60_000)).toBe('12m');
    expect(formatElapsed(75 * 60_000)).toBe('1h15m');
  });
});

describe('readCurrentJob', () => {
  it('lets the host filter the log down to the lines that mark a job', async () => {
    const transport = new FakeTransport().on('sh -c', {
      stdout: GITLAB_RUNNING,
    });
    const job = await readCurrentJob({
      transport,
      host: 'mac-1',
      runner: 'grove-ios-1',
      stack: 'docker',
    });
    expect(job?.label).toBe('foo/bar #123456');
    const script = transport.calls[0].args[1];
    expect(script).toContain(
      "docker logs --timestamps --since 24h 'grove-ios-1' 2>&1",
    );
    expect(script).toContain('grep -E');
    expect(script).toContain('tail -n 60');
  });

  it('answers nothing when the log cannot be read', async () => {
    const transport = new FakeTransport().throwOn('sh -c', 'no such host');
    await expect(
      readCurrentJob({
        transport,
        host: 'mac-1',
        runner: 'grove-ios-1',
        stack: 'docker',
      }),
    ).resolves.toBeUndefined();
  });
});
