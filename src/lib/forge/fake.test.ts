import { describe, expect, it } from 'vitest';
import type { Scope } from '../config/index.js';
import { FakeForgeClient } from './fake.js';

const scope: Scope = { level: 'organization', target: 'Overload-coach' };

describe('FakeForgeClient', () => {
  it('records every registration it mints', async () => {
    const client = new FakeForgeClient('gh-overload');
    const registration = await client.createRegistration({
      scope,
      group: 'overload-arm',
      name: 'grove-overload-arm-1',
      labels: ['arm64'],
    });

    expect(registration.token).toBe('fake-registration-token-1');
    expect(registration.url).toBe('https://forge.test/Overload-coach');
    expect(client.registrations).toHaveLength(1);
    expect(client.registrations[0].name).toBe('grove-overload-arm-1');
  });

  it('lists the runners it was given', async () => {
    const client = new FakeForgeClient('gh-overload').addRunner({
      name: 'grove-overload-arm-1',
      id: '11',
      busy: true,
    });
    const runners = await client.listRunners(scope);
    expect(runners).toEqual([
      {
        id: '11',
        name: 'grove-overload-arm-1',
        status: 'online',
        busy: true,
        labels: [],
      },
    ]);
  });

  it('drops a deleted runner and remembers the id', async () => {
    const client = new FakeForgeClient('gh-overload').addRunner({
      name: 'grove-overload-arm-1',
      id: '11',
    });
    await client.deleteRunner(scope, '11');
    expect(await client.listRunners(scope)).toEqual([]);
    expect(client.deleted).toEqual([{ scope, id: '11' }]);
  });

  it('fails the method it was told to fail', async () => {
    const client = new FakeForgeClient('gh-overload').failOn(
      'listRunners',
      'rate limited',
    );
    await expect(client.listRunners(scope)).rejects.toThrow('rate limited');
  });

  it('defaults to a per-runner registration, as GitHub does', () => {
    expect(new FakeForgeClient('gh').sharedRegistration).toBe(false);
    expect(
      new FakeForgeClient('gl', { kind: 'gitlab', sharedRegistration: true })
        .sharedRegistration,
    ).toBe(true);
  });
});

describe('FakeForgeClient, shared registration', () => {
  const gitlabScope: Scope = { level: 'instance' };

  function shared(): FakeForgeClient {
    return new FakeForgeClient('gl-chevro', {
      kind: 'gitlab',
      sharedRegistration: true,
    });
  }

  it('mints a new entity on every call, exactly as GitLab does', async () => {
    const client = shared();
    const first = await client.createRegistration({
      scope: gitlabScope,
      group: 'chevro-dind',
      name: 'grove-chevro-dind',
      labels: [],
      tags: ['docker', 'dind'],
    });
    const second = await client.createRegistration({
      scope: gitlabScope,
      group: 'chevro-dind',
      name: 'grove-chevro-dind',
      labels: [],
      tags: ['docker', 'dind'],
    });

    // Avoiding the second call is grove's job, not the forge's. The store
    // holds the token, and the executor is what reuses it.
    expect(first.runnerId).toBe('101');
    expect(second.runnerId).toBe('102');
    expect(second.token).not.toBe(first.token);
    expect(await client.listRunners(gitlabScope)).toHaveLength(2);
  });

  it('lists the minted entity with its tags and no manager yet', async () => {
    const client = shared();
    const registration = await client.createRegistration({
      scope: gitlabScope,
      group: 'chevro-dind',
      name: 'grove-chevro-dind',
      labels: [],
      tags: ['docker', 'dind'],
    });

    expect(await client.listRunners(gitlabScope)).toEqual([
      {
        id: registration.runnerId,
        name: 'grove-chevro-dind',
        status: 'online',
        busy: false,
        labels: ['docker', 'dind'],
        managers: [],
      },
    ]);
  });

  it('adds a manager to an entity, with a system id and a status', async () => {
    const client = shared();
    const registration = await client.createRegistration({
      scope: gitlabScope,
      group: 'chevro-dind',
      name: 'grove-chevro-dind',
      labels: [],
      tags: [],
    });
    client.addManager(registration.runnerId as string, {
      systemId: 's_aaaaaaaaaaaa',
      contactedAt: '2026-08-16T10:00:00Z',
    });
    client.addManager(registration.runnerId as string, {
      systemId: 'r_bbbbbbbbbbbb',
      status: 'stale',
      busy: false,
    });

    const [entity] = await client.listRunners(gitlabScope);
    expect(entity.managers).toEqual([
      {
        systemId: 's_aaaaaaaaaaaa',
        status: 'online',
        busy: false,
        contactedAt: '2026-08-16T10:00:00Z',
      },
      { systemId: 'r_bbbbbbbbbbbb', status: 'stale', busy: false },
    ]);
  });

  it('refuses a manager on an entity it never minted', () => {
    expect(() => shared().addManager('999', { systemId: 's_x' })).toThrow(
      'no runner 999',
    );
  });

  it('keeps a per-runner client free of managers, as GitHub is', async () => {
    const client = new FakeForgeClient('gh-overload').addRunner({
      name: 'grove-overload-arm-1',
    });
    const [runner] = await client.listRunners(scope);
    expect(runner.managers).toBeUndefined();
  });
});
