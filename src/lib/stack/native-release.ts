import { errorMessage } from '../errors.js';
import type { FetchFn } from '../forge/index.js';

export const RUNNER_RELEASE_URL =
  'https://api.github.com/repos/actions/runner/releases/latest';
export const RUNNER_DOWNLOAD_BASE =
  'https://github.com/actions/runner/releases/download';

export type RunnerOs = 'osx' | 'linux';
export type RunnerArch = 'arm64' | 'x64';

const PIN_HINT =
  'Pin one with raw.runner_version on the group, and grove asks GitHub nothing.';

export function runnerOs(platform: string): RunnerOs {
  return platform.toLowerCase() === 'darwin' ? 'osx' : 'linux';
}

// Architecture is a request, not a constraint, so a group that names one wins
// and a group that names none takes what the host reported. x64 is the answer
// when nothing said, because it is the only one every runner release has.
export function runnerArch(arch?: string): RunnerArch {
  const value = (arch ?? '').trim().toLowerCase();
  return value === 'arm64' || value === 'aarch64' ? 'arm64' : 'x64';
}

export function runnerTarballUrl(
  version: string,
  os: RunnerOs,
  arch: RunnerArch,
): string {
  return `${RUNNER_DOWNLOAD_BASE}/v${version}/actions-runner-${os}-${arch}-${version}.tar.gz`;
}

export type RunnerVersionResolver = () => Promise<string>;

export interface RunnerVersionOptions {
  fetchFn?: FetchFn;
}

async function readLatestVersion(fetchFn: FetchFn): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(RUNNER_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (error) {
    throw new Error(
      `cannot read the latest actions/runner release: ${errorMessage(error)}. ${PIN_HINT}`,
    );
  }
  if (!response.ok) {
    // The call is anonymous, so 60 requests an hour per address is the ceiling
    // an operator hits, and pinning is the fix that costs nothing.
    throw new Error(
      `cannot read the latest actions/runner release: HTTP ${response.status}. ${PIN_HINT}`,
    );
  }
  const body = (await response.json()) as { tag_name?: unknown };
  const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (version === '') {
    throw new Error(
      `the latest actions/runner release carries no version tag. ${PIN_HINT}`,
    );
  }
  return version;
}

/**
 * One lookup per run, shared by every seat a pass creates. A failure clears
 * the cache rather than sticking, so a second group is not punished for the
 * first one's timeout.
 */
export function createRunnerVersionResolver(
  options: RunnerVersionOptions = {},
): RunnerVersionResolver {
  const fetchFn = options.fetchFn ?? fetch;
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= readLatestVersion(fetchFn).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
