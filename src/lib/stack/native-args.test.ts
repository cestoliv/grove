import { describe, expect, it } from 'vitest';
import type { GroupConfig, HostConfig } from '../config/index.js';
import {
  buildConfigArgs,
  buildDownloadArgs,
  buildExtractArgs,
  buildNativeRunnerSpec,
  buildNativeTarget,
  NATIVE_PATH,
  nativeTargetFromDirs,
  RAW_NATIVE_KEYS,
  rawNativeOptions,
} from './native-args.js';

const host = { type: 'local', work_root: '/Volumes/ci/grove' } as HostConfig;

function group(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    name: 'ios',
    forge: 'gh-overload',
    scope: { level: 'organization', target: 'Overload-coach' },
    placement: { mac: 1 },
    stack: 'native',
    labels: ['macos', 'xcode'],
    ...overrides,
  } as GroupConfig;
}

const registration = {
  token: 'AABBCC',
  url: 'https://github.com/Overload-coach',
};

function spec(overrides: Partial<GroupConfig> = {}) {
  return buildNativeRunnerSpec({
    group: group(overrides),
    host,
    index: 1,
    home: '/Users/olivier',
    registration,
    platform: 'Darwin',
    hostArch: 'arm64',
    version: '2.328.0',
  });
}

describe('buildNativeTarget', () => {
  it('derives every path a seat needs without a registration', () => {
    expect(
      buildNativeTarget({
        group: group(),
        host,
        index: 2,
        home: '/Users/olivier',
      }),
    ).toEqual({
      name: 'grove-ios-2',
      group: 'ios',
      index: 2,
      workDir: '/Volumes/ci/grove/ios-2',
      cacheDir: '/Volumes/ci/grove-cache/ios-2',
      installDir: '/Volumes/ci/grove/ios-2-runner',
      serviceScript: '/Volumes/ci/grove/ios-2-runner/bin/runsvc.sh',
      label: 'com.cestoliv.grove.ios-2',
      unit: 'grove-ios-2.service',
      plistPath:
        '/Users/olivier/Library/LaunchAgents/com.cestoliv.grove.ios-2.plist',
      unitPath: '/Users/olivier/.config/systemd/user/grove-ios-2.service',
      stdoutPath: '/Volumes/ci/grove/ios-2-runner/stdout.log',
      stderrPath: '/Volumes/ci/grove/ios-2-runner/stderr.log',
      diagDir: '/Volumes/ci/grove/ios-2-runner/_diag',
      tarballPath: '/Volumes/ci/grove/ios-2-runner/actions-runner.tar.gz',
    });
  });

  it('expands a tilde in the group work root against the runner home', () => {
    const target = buildNativeTarget({
      group: group({ work_root: '~/ci/ios' }),
      host,
      index: 1,
      home: '/Users/olivier',
    });
    expect(target.workDir).toBe('/Users/olivier/ci/ios/ios-1');
    expect(target.installDir).toBe('/Users/olivier/ci/ios/ios-1-runner');
  });

  it('puts the install dir under install_root and leaves the work dir alone', () => {
    const target = buildNativeTarget({
      group: group({ work_root: '/Volumes/ci/ios', install_root: '/opt/ci' }),
      host,
      index: 1,
      home: '/Users/olivier',
    });
    expect(target.workDir).toBe('/Volumes/ci/ios/ios-1');
    expect(target.installDir).toBe('/opt/ci/ios-1-runner');
    expect(target.serviceScript).toBe('/opt/ci/ios-1-runner/bin/runsvc.sh');
    expect(target.stdoutPath).toBe('/opt/ci/ios-1-runner/stdout.log');
    expect(target.diagDir).toBe('/opt/ci/ios-1-runner/_diag');
    // The cache root still follows the work root, because install_root moves
    // the runner and nothing else.
    expect(target.cacheDir).toBe('/Volumes/ci/ios-cache/ios-1');
  });

  it('expands a tilde in install_root against the runner home', () => {
    const target = buildNativeTarget({
      group: group({ install_root: '~/runners' }),
      host,
      index: 1,
      home: '/Users/olivier',
    });
    expect(target.installDir).toBe('/Users/olivier/runners/ios-1-runner');
  });
});

describe('nativeTargetFromDirs', () => {
  it('rebuilds the same target from the two directories a create wrote down', () => {
    const built = buildNativeTarget({
      group: group(),
      host,
      index: 2,
      home: '/Users/olivier',
    });
    expect(
      nativeTargetFromDirs({
        name: built.name,
        group: built.group,
        index: built.index,
        home: '/Users/olivier',
        installDir: built.installDir,
        workDir: built.workDir,
      }),
    ).toEqual(built);
  });

  it('follows the directories it is given, not the layout of a group', () => {
    const target = nativeTargetFromDirs({
      name: 'grove-ios-1',
      group: 'ios',
      index: 1,
      home: '/Users/olivier',
      installDir: '/opt/old/ios-1-runner',
      workDir: '/opt/old/ios-1',
    });
    expect(target.installDir).toBe('/opt/old/ios-1-runner');
    expect(target.workDir).toBe('/opt/old/ios-1');
    expect(target.stdoutPath).toBe('/opt/old/ios-1-runner/stdout.log');
    expect(target.serviceScript).toBe('/opt/old/ios-1-runner/bin/runsvc.sh');
    expect(target.tarballPath).toBe(
      '/opt/old/ios-1-runner/actions-runner.tar.gz',
    );
    expect(target.plistPath).toBe(
      '/Users/olivier/Library/LaunchAgents/com.cestoliv.grove.ios-1.plist',
    );
  });

  it('takes a cache dir when the caller has one, and derives it when not', () => {
    const derived = nativeTargetFromDirs({
      name: 'grove-ios-1',
      group: 'ios',
      index: 1,
      home: '/Users/olivier',
      installDir: '/opt/old/ios-1-runner',
      workDir: '/opt/old/ios-1',
    });
    expect(derived.cacheDir).toBe('/opt/old-cache/ios-1');
    const given = nativeTargetFromDirs({
      name: 'grove-ios-1',
      group: 'ios',
      index: 1,
      home: '/Users/olivier',
      installDir: '/opt/old/ios-1-runner',
      workDir: '/opt/old/ios-1',
      cacheDir: '/mnt/cache/ios-1',
    });
    expect(given.cacheDir).toBe('/mnt/cache/ios-1');
  });
});

describe('buildNativeRunnerSpec', () => {
  it('picks the release asset from the platform and the architecture', () => {
    expect(spec().os).toBe('osx');
    expect(spec().arch).toBe('arm64');
    expect(spec().downloadUrl).toBe(
      'https://github.com/actions/runner/releases/download/v2.328.0/actions-runner-osx-arm64-2.328.0.tar.gz',
    );
  });

  it('lets the group ask for an architecture the host does not report', () => {
    expect(spec({ arch: 'amd64' }).arch).toBe('x64');
  });

  it('gives the agent a PATH that finds Xcode, git and Homebrew', () => {
    expect(spec().env).toEqual({ PATH: NATIVE_PATH });
  });

  it('lets raw.env add to that PATH and override it', () => {
    const built = spec({
      raw: {
        env: { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' },
      },
    });
    expect(built.env).toEqual({
      PATH: NATIVE_PATH,
      DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
    });
    expect(spec({ raw: { env: { PATH: '/opt/bin' } } }).env.PATH).toBe(
      '/opt/bin',
    );
  });

  it('carries the drain timeout, the job ceiling and the work ceiling', () => {
    const built = spec({
      drain_timeout: 300_000,
      max_job_duration: 5_400_000,
      max_work_size: 128_849_018_880,
    } as Partial<GroupConfig>);
    expect(built.drainTimeoutMs).toBe(300_000);
    expect(built.maxJobDurationMs).toBe(5_400_000);
    expect(built.maxWorkSizeBytes).toBe(128_849_018_880);
  });

  it('falls back to the shared drain default when the group sets none', () => {
    expect(spec().drainTimeoutMs).toBe(120_000);
    expect(spec().maxJobDurationMs).toBeUndefined();
    expect(spec().maxWorkSizeBytes).toBeUndefined();
  });
});

describe('the install argument lists', () => {
  it('downloads the tarball into the install dir and unpacks it there', () => {
    const built = spec();
    expect(buildDownloadArgs(built)).toEqual([
      '-fsSL',
      '-o',
      '/Volumes/ci/grove/ios-1-runner/actions-runner.tar.gz',
      built.downloadUrl,
    ]);
    expect(buildExtractArgs(built)).toEqual([
      'xzf',
      '/Volumes/ci/grove/ios-1-runner/actions-runner.tar.gz',
      '-C',
      '/Volumes/ci/grove/ios-1-runner',
    ]);
  });

  it('configures unattended, replacing its own record, with updates off', () => {
    expect(buildConfigArgs(spec())).toEqual([
      '--url',
      'https://github.com/Overload-coach',
      '--token',
      'AABBCC',
      '--name',
      'grove-ios-1',
      '--work',
      '/Volumes/ci/grove/ios-1',
      '--unattended',
      '--replace',
      '--disableupdate',
      '--labels',
      'macos,xcode',
    ]);
  });

  it('leaves the labels flag out when the group declares none', () => {
    expect(buildConfigArgs(spec({ labels: undefined }))).not.toContain(
      '--labels',
    );
  });
});

describe('rawNativeOptions', () => {
  it('reads env and runner_version and reports nothing else', () => {
    expect(
      rawNativeOptions({
        env: { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' },
        runner_version: '2.327.1',
        docker_run_args: ['--dns', '1.1.1.1'],
      }),
    ).toEqual({
      env: { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' },
      runnerVersion: '2.327.1',
      unknownKeys: ['docker_run_args'],
    });
  });

  it('answers empty for a group with no raw block', () => {
    expect(rawNativeOptions()).toEqual({ env: {}, unknownKeys: [] });
  });

  it('refuses a runner_version that is not a string', () => {
    expect(() => rawNativeOptions({ runner_version: 2 })).toThrow(
      'raw.runner_version must be a string',
    );
  });

  it('warns about every key it does not read, and about no key it does', () => {
    // The warning text is built from RAW_NATIVE_KEYS, so a key added to the
    // reader without being added to that list would be read and still warned
    // about. Reading the reader's own source is what catches that.
    const read = [
      ...rawNativeOptions.toString().matchAll(/key === (['"])([^'"]+)\1/g),
    ].map((match) => match[2]);
    expect(read.slice().sort()).toEqual(RAW_NATIVE_KEYS.slice().sort());
  });

  it('refuses an env block that is not a mapping', () => {
    expect(() => rawNativeOptions({ env: ['A=1'] })).toThrow(
      'raw.env must be a mapping',
    );
  });

  it('pins the version the group asked for', () => {
    expect(
      buildNativeRunnerSpec({
        group: group({ raw: { runner_version: '2.327.1' } }),
        host,
        index: 1,
        home: '/Users/olivier',
        registration,
        platform: 'Linux',
        hostArch: 'amd64',
        version: '2.328.0',
      }).downloadUrl,
    ).toContain('actions-runner-linux-x64-2.327.1.tar.gz');
  });
});
