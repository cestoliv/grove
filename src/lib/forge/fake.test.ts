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
