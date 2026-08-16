import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigError,
  formatConfigIssues,
  issuePath,
  issuesFromZod,
} from './errors.js';

describe('issuePath', () => {
  it('joins object keys with dots', () => {
    expect(issuePath(['forges', 'gh-overload', 'auth'])).toBe(
      'forges.gh-overload.auth',
    );
  });

  it('renders array indexes in brackets', () => {
    expect(issuePath(['groups', 0, 'scope', 'level'])).toBe(
      'groups[0].scope.level',
    );
  });

  it('renders an empty path as the root marker', () => {
    expect(issuePath([])).toBe('<root>');
  });
});

describe('issuesFromZod', () => {
  it('turns zod issues into path and message pairs', () => {
    const schema = z.object({
      groups: z.array(z.object({ name: z.string() })),
    });
    const result = schema.safeParse({ groups: [{ name: 4 }] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = issuesFromZod(result.error);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('groups[0].name');
    expect(issues[0].message).toMatch(/string/i);
  });
});

describe('formatConfigIssues', () => {
  it('names the config file and indents every issue', () => {
    const text = formatConfigIssues(
      [{ path: 'hosts.mac.type', message: 'type must be "local" or "ssh"' }],
      '/tmp/grove.yaml',
    );
    expect(text).toBe(
      'Invalid config at /tmp/grove.yaml\n  hosts.mac.type: type must be "local" or "ssh"',
    );
  });

  it('indents every continuation line of a multi-line message', () => {
    const text = formatConfigIssues(
      [
        {
          path: 'forges.gh.auth.token',
          message: 'line one\nline two\nline three',
        },
      ],
      '/tmp/grove.yaml',
    );
    expect(text).toBe(
      'Invalid config at /tmp/grove.yaml\n  forges.gh.auth.token: line one\n  line two\n  line three',
    );
  });
});

describe('ConfigError', () => {
  it('carries its issues and uses the formatted text as its message', () => {
    const issues = [
      { path: 'groups[0].forge', message: 'unknown forge "nope"' },
    ];
    const error = new ConfigError(issues, '/tmp/grove.yaml');
    expect(error.name).toBe('ConfigError');
    expect(error.issues).toEqual(issues);
    expect(error.configPath).toBe('/tmp/grove.yaml');
    expect(error.message).toContain('groups[0].forge: unknown forge "nope"');
  });
});
