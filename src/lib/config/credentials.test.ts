import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../transport/fake.js';
import {
  CredentialError,
  detectLiteralTokens,
  isLiteralToken,
  resolveCredential,
} from './credentials.js';

// Built at runtime so secret scanners do not match the fixture.
const FAKE_GHP = ['ghp', '0123456789abcdefghij'].join('_');
const FAKE_GHO = ['gho', '0123456789abcdefghij'].join('_');
const FAKE_GLPAT = ['glpat', '0123456789abcdefghij'].join('-');
const FAKE_GLRT = ['glrt', '0123456789abcdefghij'].join('-');
const FAKE_GLPAT_VAULT = ['glpat', 'from-the-vault'].join('-');

describe('isLiteralToken', () => {
  it('recognises GitHub token shapes', () => {
    expect(isLiteralToken(FAKE_GHP)).toBe(true);
    expect(isLiteralToken(FAKE_GHO)).toBe(true);
    expect(isLiteralToken(`github_pat_${'a'.repeat(30)}`)).toBe(true);
  });

  it('recognises GitLab token shapes', () => {
    expect(isLiteralToken(FAKE_GLPAT)).toBe(true);
    expect(isLiteralToken(FAKE_GLRT)).toBe(true);
  });

  it('recognises a bare 40 character hex token', () => {
    expect(isLiteralToken('0'.repeat(40))).toBe(true);
  });

  it('leaves the three legal sources alone', () => {
    expect(isLiteralToken('${GH_TOKEN}')).toBe(false);
    expect(isLiteralToken('op read op://infra/gitlab/pat')).toBe(false);
  });
});

describe('detectLiteralTokens', () => {
  it('reports the forge path and explains the three sources', () => {
    const issues = detectLiteralTokens({
      forges: {
        'gh-overload': {
          kind: 'github',
          auth: { token: FAKE_GHP },
        },
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('forges.gh-overload.auth.token');
    expect(issues[0].message).toContain('looks like a literal credential');
    expect(issues[0].message).toContain('${GH_TOKEN}');
    expect(issues[0].message).toContain('command:');
    expect(issues[0].message).toContain('gh or glab');
  });

  it('accepts a document that uses interpolation', () => {
    expect(
      detectLiteralTokens({
        forges: { gh: { kind: 'github', auth: { token: '${GH_TOKEN}' } } },
      }),
    ).toEqual([]);
  });

  it('reports every offending forge', () => {
    const issues = detectLiteralTokens({
      forges: {
        a: { auth: { token: FAKE_GHP } },
        b: { auth: { token: FAKE_GLPAT } },
      },
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'forges.a.auth.token',
      'forges.b.auth.token',
    ]);
  });

  it('ignores a document with no forges block', () => {
    expect(detectLiteralTokens({ hosts: {} })).toEqual([]);
    expect(detectLiteralTokens(null)).toEqual([]);
    expect(detectLiteralTokens('not a mapping')).toEqual([]);
  });
});

describe('resolveCredential', () => {
  it('returns a token straight from the token source', async () => {
    const transport = new FakeTransport();
    const credential = await resolveCredential(
      'gh-overload',
      { kind: 'github', auth: { source: 'token', token: 'from-env' } },
      transport,
    );
    expect(credential).toEqual({ kind: 'token', token: 'from-env' });
    expect(transport.calls).toEqual([]);
  });

  it('shells out for the command source and trims the output', async () => {
    const transport = new FakeTransport().on('sh -c op read', {
      stdout: `${FAKE_GLPAT_VAULT}\n`,
    });
    const credential = await resolveCredential(
      'gl-chevro',
      {
        kind: 'gitlab',
        url: 'https://git.chevro.fr',
        auth: { source: 'command', command: 'op read op://infra/gitlab/pat' },
      },
      transport,
    );
    expect(credential).toEqual({
      kind: 'token',
      token: FAKE_GLPAT_VAULT,
    });
    expect(transport.commandLines()).toEqual([
      'sh -c op read op://infra/gitlab/pat',
    ]);
  });

  it('fails with the command stderr when the command exits non-zero', async () => {
    const transport = new FakeTransport().fail(
      'sh -c',
      'op: not signed in\n',
      1,
    );
    const promise = resolveCredential(
      'gl-chevro',
      {
        kind: 'gitlab',
        url: 'https://git.chevro.fr',
        auth: { source: 'command', command: 'op read op://infra/gitlab/pat' },
      },
      transport,
    );
    await expect(promise).rejects.toBeInstanceOf(CredentialError);
    await expect(promise).rejects.toThrow(
      'forge "gl-chevro": credential command exited 1: op: not signed in',
    );
  });

  it('fails when the command succeeds but prints nothing', async () => {
    const transport = new FakeTransport().on('sh -c', { stdout: '  \n' });
    await expect(
      resolveCredential(
        'gl-chevro',
        {
          kind: 'gitlab',
          url: 'https://git.chevro.fr',
          auth: { source: 'command', command: 'true' },
        },
        transport,
      ),
    ).rejects.toThrow('forge "gl-chevro": credential command printed nothing');
  });

  it('delegates to gh when a github forge has no auth block', async () => {
    expect(
      await resolveCredential(
        'gh-overload',
        { kind: 'github' },
        new FakeTransport(),
      ),
    ).toEqual({ kind: 'cli', cli: 'gh' });
  });

  it('delegates to glab when a gitlab forge has no auth block', async () => {
    expect(
      await resolveCredential(
        'gl-chevro',
        { kind: 'gitlab', url: 'https://git.chevro.fr' },
        new FakeTransport(),
      ),
    ).toEqual({ kind: 'cli', cli: 'glab' });
  });
});
