import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from './errors.js';
import { loadConfig } from './load.js';
import { DEFAULT_HISTORY_RETENTION_MS } from './schema.js';

// Built at runtime so secret scanners do not match the fixture.
const FAKE_GHP = ['ghp', '0123456789abcdefghij'].join('_');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-load-'));
});

async function write(text: string): Promise<string> {
  const path = join(dir, 'grove.yaml');
  await writeFile(path, text, 'utf8');
  return path;
}

const VALID = `
tick: { fast: 2m, full: 30m }

hosts:
  mac:
    type: local
    work_root: /Volumes/ci/grove
  atlas:
    type: ssh
    host: atlas
    work_root: /PROD/local/grove

forges:
  gh-overload:
    kind: github
    auth: { token: "\${GH_TOKEN}" }
  gl-chevro:
    kind: gitlab
    url: https://git.chevro.fr
    auth: { command: "op read op://infra/gitlab/pat" }

groups:
  - name: overload-arm
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 2 }
    stack: docker
    arch: arm64
    labels: [arm64]
    build: ./runners/Dockerfile

  - name: chevro-dind
    forge: gl-chevro
    scope: { level: instance }
    placement: { atlas: 3 }
    stack: docker
    arch: amd64
    tags: [docker, dind]
    image: gitlab/gitlab-runner:latest
    privileged: true
    volumes: ["/cache", "/var/run/docker.sock:/var/run/docker.sock"]
    concurrent: 4

  - name: ios
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 1 }
    stack: native
    labels: [macos, xcode]
    work_root: ~/ci/ios
    max_job_duration: 90m
    max_work_size: 120G
`;

const VALID_WITH_RAW = VALID.replace(
  '    max_work_size: 120G\n',
  '    max_work_size: 120G\n' +
    '    raw: { environment: ["CACHE=${CI_PROJECT_DIR}/.cache"] }\n',
);

describe('loadConfig', () => {
  it('loads the config from the spec', async () => {
    const path = await write(VALID);
    const loaded = await loadConfig({ path, env: { GH_TOKEN: 'from-env' } });

    expect(loaded.path).toBe(path);
    expect(loaded.config.tick).toEqual({ fast: 120_000, full: 1_800_000 });
    expect(loaded.config.hosts.atlas).toEqual({
      type: 'ssh',
      host: 'atlas',
      work_root: '/PROD/local/grove',
    });
    expect(loaded.config.forges['gh-overload'].auth).toEqual({
      source: 'token',
      token: 'from-env',
    });
    expect(loaded.config.forges['gl-chevro'].auth).toEqual({
      source: 'command',
      command: 'op read op://infra/gitlab/pat',
    });
    expect(loaded.config.groups[0].placement).toEqual({ mac: 2 });
    expect(loaded.config.groups[1].placement).toEqual({ atlas: 3 });
    expect(loaded.config.groups[2].max_job_duration).toBe(5_400_000);
    expect(loaded.config.groups[2].max_work_size).toBe(120 * 1024 ** 3);
  });

  it('returns the privileged socket warning without failing', async () => {
    const path = await write(VALID);
    const loaded = await loadConfig({ path, env: { GH_TOKEN: 'from-env' } });
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0].code).toBe('privileged-docker-socket');
  });

  it('defaults the tick when the block is absent', async () => {
    const path = await write(
      VALID.replace('tick: { fast: 2m, full: 30m }', ''),
    );
    const loaded = await loadConfig({ path, env: { GH_TOKEN: 'from-env' } });
    expect(loaded.config.tick).toEqual({ fast: 120_000, full: 1_800_000 });
  });

  it('resolves the path from GROVE_CONFIG', async () => {
    const path = await write(VALID);
    const loaded = await loadConfig({
      env: { GROVE_CONFIG: path, GH_TOKEN: 'from-env' },
    });
    expect(loaded.path).toBe(path);
  });

  it('explains a missing file and names the path it looked at', async () => {
    const missing = join(dir, 'nowhere.yaml');
    await expect(loadConfig({ path: missing, env: {} })).rejects.toThrow(
      ConfigError,
    );
    await expect(loadConfig({ path: missing, env: {} })).rejects.toThrow(
      new RegExp(`no config file at ${missing}`),
    );
  });

  it('reports a YAML syntax error', async () => {
    const path = await write('hosts:\n  mac:\n   type: local\n  bad: [1,\n');
    await expect(loadConfig({ path, env: {} })).rejects.toThrow(ConfigError);
  });

  it('rejects a document that is not a mapping', async () => {
    const path = await write('- one\n- two\n');
    await expect(loadConfig({ path, env: {} })).rejects.toThrow(
      /must be a YAML mapping/,
    );
  });

  it('rejects a literal token before it tries to interpolate', async () => {
    const path = await write(VALID.replace('"${GH_TOKEN}"', `"${FAKE_GHP}"`));
    const error = await loadConfig({ path, env: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.issues[0].path).toBe('forges.gh-overload.auth.token');
    expect(error.message).toContain('three credential sources');
  });

  it('reports an unset environment variable', async () => {
    const path = await write(VALID);
    const error = await loadConfig({ path, env: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.issues[0]).toEqual({
      path: 'forges.gh-overload.auth.token',
      message:
        'environment variable GH_TOKEN is not set. Export it, or use a command: source instead.',
    });
  });

  it('reports a schema failure with the path named', async () => {
    const path = await write(VALID.replace('type: ssh', 'type: podman'));
    const error = await loadConfig({
      path,
      env: { GH_TOKEN: 'from-env' },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.issues[0].path).toBe('hosts.atlas.type');
    expect(error.issues[0].message).toBe('type must be "local" or "ssh"');
  });

  it('reports a cross-reference failure with the three valid levels named', async () => {
    const path = await write(
      VALID.replace(
        'scope: { level: instance }',
        'scope: { level: organization, target: Chevro }',
      ),
    );
    const error = await loadConfig({
      path,
      env: { GH_TOKEN: 'from-env' },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.issues[0].message).toContain(
      'Valid values: instance, group, project',
    );
  });

  it('passes raw blocks through verbatim, without interpolating ${...} inside them', async () => {
    const path = await write(VALID_WITH_RAW);
    const loaded = await loadConfig({ path, env: { GH_TOKEN: 'from-env' } });
    expect(loaded.config.groups[2].raw).toEqual({
      environment: ['CACHE=${CI_PROJECT_DIR}/.cache'],
    });
  });

  it('names the config file in the error message', async () => {
    const path = await write('hosts: {}\nforges: {}\ngroups: []\n');
    const error = await loadConfig({ path, env: {} }).catch((e) => e);
    expect(error.message).toContain(`Invalid config at ${path}`);
  });
});

describe('history retention', () => {
  it('reads the retention the config names', async () => {
    const path = await write(`${VALID}\nhistory: { retention: 14d }\n`);
    const loaded = await loadConfig({
      path,
      env: { GH_TOKEN: 'from-env' },
    });
    expect(loaded.config.history?.retentionMs).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('falls back to ninety days when the config names none', async () => {
    const path = await write(VALID);
    const loaded = await loadConfig({
      path,
      env: { GH_TOKEN: 'from-env' },
    });
    expect(loaded.config.history?.retentionMs).toBe(
      DEFAULT_HISTORY_RETENTION_MS,
    );
  });
});
