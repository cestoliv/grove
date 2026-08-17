import { describe, expect, it } from 'vitest';
import type { Action } from './actions.js';
import {
  ACTION_VERBS,
  actionStack,
  describeAction,
  hasDestructive,
  isReport,
} from './actions.js';

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

describe('delete-shared-runner', () => {
  const action: Action = {
    kind: 'delete-shared-runner',
    host: 'atlas',
    forge: 'gl-chevro',
    scope: { level: 'instance' },
    group: 'chevro-dind',
    name: 'grove-chevro-dind',
    forgeRunnerId: '48',
    registrationId: 7,
    destructive: true,
  };

  it('describes the entity, the forge and why it goes', () => {
    expect(describeAction(action)).toBe(
      'delete      grove-chevro-dind  ' +
        'runner entity 48 at gl-chevro, its last manager is gone',
    );
  });

  it('counts as destructive, so apply asks first', () => {
    expect(hasDestructive([action])).toBe(true);
  });

  it('is not a report, so the executor runs it', () => {
    expect(isReport(action)).toBe(false);
  });

  it('never carries a token, so no log line can leak one', () => {
    expect(Object.keys(action)).not.toContain('token');
    expect(describeAction(action)).not.toContain('glrt');
  });
});

describe('create-runner with a renewed registration', () => {
  const renewing: Action = {
    kind: 'create-runner',
    host: 'atlas',
    forge: 'gl-chevro',
    group: 'chevro-dind',
    index: 1,
    name: 'grove-chevro-dind-1',
    renewRegistration: '48',
    destructive: true,
  };

  it('says the stored registration is about to go', () => {
    expect(describeAction(renewing)).toBe(
      'create      grove-chevro-dind-1  on atlas, registering at gl-chevro, ' +
        'renewing the group registration',
    );
  });

  it('counts as destructive, so apply asks first', () => {
    expect(hasDestructive([renewing])).toBe(true);
  });

  it('carries the id the planner judged gone, never a token', () => {
    expect(renewing).toMatchObject({ renewRegistration: '48' });
    expect(describeAction(renewing)).not.toContain('glrt');
  });

  it('leaves a plain create alone', () => {
    expect(describeAction(create)).not.toContain('renewing');
    expect(hasDestructive([create])).toBe(false);
  });
});

describe('actionStack', () => {
  it('reads Docker out of an action that names no stack', () => {
    expect(
      actionStack({
        kind: 'start-container',
        host: 'mac',
        name: 'grove-overload-arm-1',
        destructive: false,
      }),
    ).toBe('docker');
  });

  it('reads the stack an action names', () => {
    expect(
      actionStack({
        kind: 'start-container',
        host: 'mac',
        name: 'grove-ios-1',
        stack: 'native',
        destructive: false,
      }),
    ).toBe('native');
  });

  it('answers docker for an action that has no stack at all', () => {
    expect(
      actionStack({
        kind: 'retire-record',
        name: 'grove-ios-1',
        recordId: 1,
        destructive: true,
      }),
    ).toBe('docker');
  });
});

describe('describeAction, native seats', () => {
  it('says which stack, but only when it is not the default one', () => {
    expect(
      describeAction({
        kind: 'start-container',
        host: 'mac',
        name: 'grove-ios-1',
        stack: 'native',
        destructive: false,
      }),
    ).toBe('start       grove-ios-1  on mac, native');
    expect(
      describeAction({
        kind: 'start-container',
        host: 'mac',
        name: 'grove-overload-arm-1',
        destructive: false,
      }),
    ).toBe('start       grove-overload-arm-1  on mac');
  });

  it('names the stack on a drain, a removal and a create', () => {
    expect(
      describeAction({
        kind: 'stop-container',
        host: 'mac',
        name: 'grove-ios-1',
        stack: 'native',
        drainTimeoutMs: 120_000,
        destructive: true,
      }),
    ).toBe('drain       grove-ios-1  on mac, up to 120s, native');
    expect(
      describeAction({
        kind: 'remove-container',
        host: 'mac',
        name: 'grove-ios-1',
        stack: 'native',
        destructive: true,
      }),
    ).toBe('remove      grove-ios-1  on mac, native');
    expect(
      describeAction({
        kind: 'create-runner',
        host: 'mac',
        forge: 'gh-overload',
        group: 'ios',
        index: 1,
        name: 'grove-ios-1',
        stack: 'native',
        destructive: false,
      }),
    ).toBe(
      'create      grove-ios-1  on mac, registering at gh-overload, native',
    );
  });
});

describe('the daemon actions', () => {
  const restart = {
    kind: 'restart-runner' as const,
    host: 'mac',
    name: 'grove-ios-1',
    recordId: 4,
    reason: 'busy for 118m and nothing under the work dir changed',
    destructive: true as const,
  };

  it('describes a restart, naming the reason and the two things it skips', () => {
    expect(describeAction(restart)).toContain('restart');
    expect(describeAction(restart)).toContain('grove-ios-1');
    expect(describeAction(restart)).toContain('on mac');
    expect(describeAction(restart)).toContain(
      'busy for 118m and nothing under the work dir changed',
    );
    expect(describeAction(restart)).toContain('skipping the drain');
    expect(describeAction(restart)).toContain('wiping the work dir');
  });

  it('names the stack of a native restart and stays silent for Docker', () => {
    expect(describeAction({ ...restart, stack: 'native' })).toContain(
      ', native',
    );
    expect(describeAction(restart)).not.toContain(', docker');
  });

  it('counts a restart as destructive, because it kills a live job', () => {
    expect(hasDestructive([restart])).toBe(true);
    expect(isReport(restart)).toBe(false);
  });

  it('treats a suspect as a report, so nothing ever executes one', () => {
    const suspect = {
      kind: 'report-suspect' as const,
      host: 'mac',
      name: 'grove-ios-1',
      reason: 'the forge says busy and grove has no host signal',
      destructive: false as const,
    };
    expect(isReport(suspect)).toBe(true);
    expect(hasDestructive([suspect])).toBe(false);
    expect(describeAction(suspect)).toContain('suspect');
    expect(describeAction(suspect)).toContain(
      'the forge says busy and grove has no host signal',
    );
  });

  it('gives every kind a verb', () => {
    expect(ACTION_VERBS['restart-runner']).toBe('restart');
    expect(ACTION_VERBS['report-suspect']).toBe('suspect');
  });
});
