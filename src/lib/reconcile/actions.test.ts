import { describe, expect, it } from 'vitest';
import type { Action } from './actions.js';
import { describeAction, hasDestructive, isReport } from './actions.js';

const scope = { level: 'organization', target: 'Overload-coach' } as const;

const create: Action = {
  kind: 'create-runner',
  host: 'mac',
  forge: 'gh-overload',
  group: 'overload-arm',
  index: 1,
  name: 'grove-overload-arm-1',
  destructive: false,
};

const deregister: Action = {
  kind: 'deregister-runner',
  host: 'mac',
  forge: 'gh-overload',
  scope,
  name: 'grove-overload-arm-2',
  forgeRunnerId: '12',
  destructive: true,
};

describe('describeAction', () => {
  it('writes one line per action', () => {
    expect(describeAction(create)).toBe(
      'create      grove-overload-arm-1  on mac, registering at gh-overload',
    );
    expect(describeAction(deregister)).toBe(
      'deregister  grove-overload-arm-2  at gh-overload, runner id 12',
    );
    expect(
      describeAction({
        kind: 'stop-container',
        host: 'mac',
        name: 'grove-overload-arm-2',
        drainTimeoutMs: 120_000,
        destructive: true,
      }),
    ).toBe('drain       grove-overload-arm-2  on mac, up to 120s');
    expect(
      describeAction({
        kind: 'report-degraded',
        target: 'atlas',
        reason: 'ssh: no route to host',
        destructive: false,
      }),
    ).toBe('degraded    atlas  ssh: no route to host');
    expect(
      describeAction({
        kind: 'report-unsupported',
        group: 'ios',
        reason: 'native runners arrive in milestone 4',
        destructive: false,
      }),
    ).toBe('skipped     ios  native runners arrive in milestone 4');
  });
});

describe('hasDestructive', () => {
  it('is true as soon as one action destroys something', () => {
    expect(hasDestructive([create])).toBe(false);
    expect(hasDestructive([create, deregister])).toBe(true);
  });
});

describe('isReport', () => {
  it('separates decisions from observations', () => {
    expect(isReport(create)).toBe(false);
    expect(
      isReport({
        kind: 'report-unmanaged',
        name: 'grove-x-1',
        where: 'container on mac',
        destructive: false,
      }),
    ).toBe(true);
  });
});
