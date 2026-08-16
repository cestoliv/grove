import { describe, expect, it } from 'vitest';
import type { Scope } from '../config/index.js';
import {
  githubEndpoints,
  parseRepository,
  registrationUrl,
  runnersPath,
} from './github-scope.js';

describe('githubEndpoints', () => {
  it('defaults to github.com', () => {
    expect(githubEndpoints()).toEqual({
      api: 'https://api.github.com',
      web: 'https://github.com',
    });
  });

  it('derives the GitHub Enterprise Server API base from the web url', () => {
    expect(githubEndpoints('https://ghe.example.com/')).toEqual({
      api: 'https://ghe.example.com/api/v3',
      web: 'https://ghe.example.com',
    });
  });
});

describe('parseRepository', () => {
  it('splits owner and repo', () => {
    expect(parseRepository('Overload-coach/api')).toEqual({
      owner: 'Overload-coach',
      repo: 'api',
    });
  });

  it('names the expected shape when the target is not owner/repo', () => {
    expect(() => parseRepository('api')).toThrow(/owner\/repo/);
    expect(() => parseRepository('a/b/c')).toThrow(/owner\/repo/);
    expect(() => parseRepository('/api')).toThrow(/owner\/repo/);
  });
});

describe('runnersPath', () => {
  it('maps each GitHub level to its endpoint', () => {
    expect(
      runnersPath({ level: 'repository', target: 'Overload-coach/api' }),
    ).toBe('/repos/Overload-coach/api/actions/runners');
    expect(
      runnersPath({ level: 'organization', target: 'Overload-coach' }),
    ).toBe('/orgs/Overload-coach/actions/runners');
    expect(runnersPath({ level: 'enterprise', target: 'chevro' })).toBe(
      '/enterprises/chevro/actions/runners',
    );
  });

  it('escapes a target with a slash or a space', () => {
    expect(runnersPath({ level: 'organization', target: 'a b' })).toBe(
      '/orgs/a%20b/actions/runners',
    );
  });

  it('refuses a GitLab level', () => {
    expect(() => runnersPath({ level: 'instance' } as Scope)).toThrow(
      /enterprise, organization or repository/,
    );
  });
});

describe('registrationUrl', () => {
  it('points the runner at the right level', () => {
    const web = 'https://github.com';
    expect(
      registrationUrl(web, {
        level: 'repository',
        target: 'Overload-coach/api',
      }),
    ).toBe('https://github.com/Overload-coach/api');
    expect(
      registrationUrl(web, { level: 'organization', target: 'Overload-coach' }),
    ).toBe('https://github.com/Overload-coach');
    expect(
      registrationUrl(web, { level: 'enterprise', target: 'chevro' }),
    ).toBe('https://github.com/enterprises/chevro');
  });
});
