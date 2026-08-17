import { describe, expect, it } from 'vitest';
import {
  createRunnerVersionResolver,
  runnerArch,
  runnerOs,
  runnerTarballUrl,
} from './native-release.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runnerOs and runnerArch', () => {
  it('maps the platform uname reports onto the release naming', () => {
    expect(runnerOs('Darwin')).toBe('osx');
    expect(runnerOs('darwin')).toBe('osx');
    expect(runnerOs('Linux')).toBe('linux');
  });

  it('maps every spelling of an architecture onto the release naming', () => {
    expect(runnerArch('arm64')).toBe('arm64');
    expect(runnerArch('aarch64')).toBe('arm64');
    expect(runnerArch('amd64')).toBe('x64');
    expect(runnerArch('x86_64')).toBe('x64');
  });

  it('falls back to x64 when nothing said which architecture', () => {
    expect(runnerArch(undefined)).toBe('x64');
    expect(runnerArch('')).toBe('x64');
  });
});

describe('runnerTarballUrl', () => {
  it('builds the release asset url GitHub publishes', () => {
    expect(runnerTarballUrl('2.328.0', 'osx', 'arm64')).toBe(
      'https://github.com/actions/runner/releases/download/v2.328.0/actions-runner-osx-arm64-2.328.0.tar.gz',
    );
  });
});

describe('createRunnerVersionResolver', () => {
  it('reads the tag of the latest release and drops the leading v', async () => {
    const urls: string[] = [];
    const resolve = createRunnerVersionResolver({
      fetchFn: async (input) => {
        urls.push(String(input));
        return jsonResponse({ tag_name: 'v2.328.0' });
      },
    });

    expect(await resolve()).toBe('2.328.0');
    expect(urls).toEqual([
      'https://api.github.com/repos/actions/runner/releases/latest',
    ]);
  });

  it('asks once per run, however many seats a pass creates', async () => {
    let calls = 0;
    const resolve = createRunnerVersionResolver({
      fetchFn: async () => {
        calls += 1;
        return jsonResponse({ tag_name: 'v2.328.0' });
      },
    });

    const [first, second] = await Promise.all([resolve(), resolve()]);
    expect([first, second]).toEqual(['2.328.0', '2.328.0']);
    expect(calls).toBe(1);
  });

  it('names raw.runner_version when GitHub refuses the lookup', async () => {
    const resolve = createRunnerVersionResolver({
      fetchFn: async () => jsonResponse({ message: 'rate limit' }, 403),
    });

    await expect(resolve()).rejects.toThrow(/403/);
    await expect(resolve()).rejects.toThrow(/raw\.runner_version/);
  });

  it('lets a later seat retry after a failure rather than caching it', async () => {
    let calls = 0;
    const resolve = createRunnerVersionResolver({
      fetchFn: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ message: 'rate limit' }, 403)
          : jsonResponse({ tag_name: 'v2.328.0' });
      },
    });

    await expect(resolve()).rejects.toThrow(/403/);
    expect(await resolve()).toBe('2.328.0');
  });

  it('refuses a release with no usable tag', async () => {
    const resolve = createRunnerVersionResolver({
      fetchFn: async () => jsonResponse({ tag_name: 'v' }),
    });

    await expect(resolve()).rejects.toThrow(/no version/);
  });
});
