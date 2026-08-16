import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import { glabHost, resolveForgeToken } from './token.js';

const TOKEN = ['ghp', '0123456789abcdefghij'].join('_');

function github(auth?: ForgeConfig['auth']): ForgeConfig {
  return { kind: 'github', auth } as ForgeConfig;
}

describe('resolveForgeToken', () => {
  it('returns the token from an auth block', async () => {
    const token = await resolveForgeToken(
      'gh-overload',
      github({ source: 'token', token: TOKEN }),
      new FakeTransport('local'),
    );
    expect(token).toBe(TOKEN);
  });

  it('runs the credential command', async () => {
    const transport = new FakeTransport('local').on('sh -c op read', {
      stdout: `${TOKEN}\n`,
    });
    const token = await resolveForgeToken(
      'gh-overload',
      github({ source: 'command', command: 'op read op://infra/gh' }),
      transport,
    );
    expect(token).toBe(TOKEN);
  });

  it('delegates to gh auth token when there is no auth block', async () => {
    const transport = new FakeTransport('local').on('gh auth token', {
      stdout: `${TOKEN}\n`,
    });
    const token = await resolveForgeToken('gh-overload', github(), transport);
    expect(token).toBe(TOKEN);
    expect(transport.commandLines()).toEqual(['gh auth token']);
  });

  it('explains the three sources when gh fails', async () => {
    const transport = new FakeTransport('local').fail(
      'gh auth token',
      'gh: not logged in\n',
      1,
    );
    await expect(
      resolveForgeToken('gh-overload', github(), transport),
    ).rejects.toThrow(/gh auth token.*exited 1.*not logged in/s);
    await expect(
      resolveForgeToken('gh-overload', github(), transport),
    ).rejects.toThrow(/three credential sources/);
  });

  it('rejects an empty gh token', async () => {
    const transport = new FakeTransport('local').on('gh auth token', {
      stdout: '\n',
    });
    await expect(
      resolveForgeToken('gh-overload', github(), transport),
    ).rejects.toThrow(/printed nothing/);
  });
});

describe('resolveForgeToken, glab delegation', () => {
  const GLAB_TOKEN = ['glpat', 'A1b2C3d4E5f6G7h8I9j0'].join('-');

  function gitlab(auth?: ForgeConfig['auth']): ForgeConfig {
    return {
      kind: 'gitlab',
      url: 'https://git.chevro.fr',
      auth,
    } as ForgeConfig;
  }

  it('reads the token glab stored for that host', async () => {
    const transport = new FakeTransport('local').on('glab config get token', {
      stdout: `${GLAB_TOKEN}\n`,
    });
    const token = await resolveForgeToken('gl-chevro', gitlab(), transport);
    expect(token).toBe(GLAB_TOKEN);
    expect(transport.commandLines()).toEqual([
      'glab config get token --host git.chevro.fr',
    ]);
  });

  it('tells the operator to log in when glab has no token for the host', async () => {
    const transport = new FakeTransport('local').on('glab config get token', {
      stdout: '\n',
    });
    await expect(
      resolveForgeToken('gl-chevro', gitlab(), transport),
    ).rejects.toThrow(/glab auth login --hostname git\.chevro\.fr/);
  });

  it('explains the three sources when glab itself fails', async () => {
    const transport = new FakeTransport('local').fail(
      'glab config get token',
      'glab: no config file\n',
      1,
    );
    await expect(
      resolveForgeToken('gl-chevro', gitlab(), transport),
    ).rejects.toThrow(/exited 1.*no config file/s);
    await expect(
      resolveForgeToken('gl-chevro', gitlab(), transport),
    ).rejects.toThrow(/three credential sources/);
  });

  it('still prefers an auth block over the CLI', async () => {
    const transport = new FakeTransport('local');
    const token = await resolveForgeToken(
      'gl-chevro',
      gitlab({ source: 'token', token: GLAB_TOKEN }),
      transport,
    );
    expect(token).toBe(GLAB_TOKEN);
    expect(transport.commandLines()).toEqual([]);
  });
});

describe('glabHost', () => {
  it('takes the host out of the forge url', () => {
    expect(glabHost('https://git.chevro.fr')).toBe('git.chevro.fr');
    expect(glabHost('https://git.chevro.fr:8443/')).toBe('git.chevro.fr:8443');
  });

  it('falls back to the url when it cannot be parsed', () => {
    expect(glabHost('not a url')).toBe('not a url');
  });
});
