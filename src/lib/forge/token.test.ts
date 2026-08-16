import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../config/index.js';
import { FakeTransport } from '../transport/index.js';
import { resolveForgeToken } from './token.js';

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

  it('names milestone 3 for glab delegation', async () => {
    const forge = {
      kind: 'gitlab',
      url: 'https://git.chevro.fr',
    } as ForgeConfig;
    await expect(
      resolveForgeToken('gl-chevro', forge, new FakeTransport('local')),
    ).rejects.toThrow(/milestone 3/);
  });
});
