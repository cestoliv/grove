import { describe, expect, it } from 'vitest';
import type { ForgeClient } from '../forge/index.js';
import { FakeForgeClient } from '../forge/index.js';
import { createLimiter } from '../reconcile/limiter.js';
import { readQueue, runnersByGroup } from './read.js';

// Not cast to `never` here: it gets spread into `bare` and `off` below, and
// spreading a `never`-typed value is itself a type error. The cast moves to
// each call site instead.
const config = {
  hosts: {},
  forges: {
    gh: {
      kind: 'github',
      queue: { activeWithinMs: 604_800_000, enabled: true },
    },
  },
  groups: [
    {
      name: 'arm64',
      forge: 'gh',
      scope: { level: 'organization', target: 'acme' },
      placement: { mac: 1 },
      stack: 'docker',
      labels: ['arm64'],
    },
  ],
};

describe('readQueue', () => {
  it('attributes every job it can and notes what it swept', async () => {
    const client = new FakeForgeClient('gh').setQueuedJobs([
      {
        project: 'acme/api',
        name: 'build',
        labels: ['arm64'],
        queuedAt: 10,
        url: 'u',
      },
      {
        project: 'acme/api',
        name: 'hosted',
        labels: ['ubuntu-latest'],
        queuedAt: 20,
        url: 'u',
      },
    ]);
    const report = await readQueue({
      config: config as never,
      forgeClients: new Map([['gh', client]]),
      runnersByGroup: new Map(),
      now: 1000,
    });
    expect(report.swept).toBe(true);
    expect(report.rows).toEqual([
      {
        project: 'acme/api',
        name: 'build',
        labels: ['arm64'],
        queuedAt: 10,
        url: 'u',
        forge: 'gh',
        group: 'arm64',
      },
    ]);
    expect(report.notes).toEqual([]);
  });

  it('turns a failed sweep into a note and never throws', async () => {
    const client = new FakeForgeClient('gh').failOn('listQueuedJobs', 'boom');
    const report = await readQueue({
      config: config as never,
      forgeClients: new Map([['gh', client]]),
      runnersByGroup: new Map(),
      now: 1000,
    });
    expect(report.rows).toEqual([]);
    expect(report.notes[0]).toContain('boom');
    // A failed sweep must never look like an empty queue: the forge lands
    // in `unknownForges`, so the group's row renders `-`, not `0`.
    expect(report.unknownForges).toEqual(['gh']);
  });

  it('marks a client that cannot report a queue as unknown, not empty', async () => {
    // No `listQueuedJobs` at all, the shape a forge with no sweep support
    // has, distinct from `FakeForgeClient` which always implements it.
    const client: ForgeClient = {
      kind: 'github',
      name: 'gh',
      sharedRegistration: false,
      createRegistration: () => {
        throw new Error('unused');
      },
      listRunners: async () => [],
      deleteRunner: async () => {},
    };
    const report = await readQueue({
      config: config as never,
      forgeClients: new Map([['gh', client]]),
      runnersByGroup: new Map(),
      now: 1000,
    });
    expect(report.unknownForges).toEqual(['gh']);
  });

  it('dedupes a job an overlapping scope swept twice', async () => {
    const orgScope = { level: 'organization', target: 'acme' };
    const repoScope = { level: 'repository', target: 'acme/special' };
    const overlap = {
      hosts: {},
      forges: {
        gh: {
          kind: 'github',
          queue: { activeWithinMs: 604_800_000, enabled: true },
        },
      },
      groups: [
        {
          name: 'org-group',
          forge: 'gh',
          scope: orgScope,
          placement: { mac: 1 },
          stack: 'docker',
          labels: ['arm64'],
        },
        {
          name: 'repo-group',
          forge: 'gh',
          scope: repoScope,
          placement: { mac: 1 },
          stack: 'docker',
          labels: ['arm64'],
        },
      ],
    };
    // The org scope and the repository scope inside it both see this job,
    // by the same url, because both scopes were swept.
    const job = {
      project: 'acme/special',
      name: 'build',
      labels: ['arm64'],
      queuedAt: 10,
      url: 'https://forge.test/acme/special/jobs/1',
    };
    const client = new FakeForgeClient('gh')
      .setQueuedJobsForScope(orgScope as never, [job])
      .setQueuedJobsForScope(repoScope as never, [job]);
    const report = await readQueue({
      config: overlap as never,
      forgeClients: new Map([['gh', client]]),
      runnersByGroup: new Map(),
      now: 1000,
    });
    expect(report.rows).toHaveLength(1);
  });

  it('never nests the same limiter, so a sweep at the concurrency cap does not deadlock', async () => {
    const limit = createLimiter(1);
    // Stands in for a real client whose sweep makes more than one HTTP call
    // (discover, then read). If `readQueue` still held a slot for the whole
    // `listQueuedJobs` call, the second `options.limit` call below would
    // wait forever for the slot `readQueue` never released.
    const client: ForgeClient = {
      kind: 'github',
      name: 'gh',
      sharedRegistration: false,
      createRegistration: () => {
        throw new Error('unused');
      },
      listRunners: async () => [],
      deleteRunner: async () => {},
      listQueuedJobs: async (_scope, options) => {
        if (options.limit === undefined) {
          throw new Error('the limiter never reached the client');
        }
        await options.limit(async () => 'discover');
        await options.limit(async () => 'read');
        return [];
      },
    };
    const report = await readQueue({
      config: config as never,
      forgeClients: new Map([['gh', client]]),
      runnersByGroup: new Map(),
      limit,
      now: 1000,
    });
    expect(report.swept).toBe(true);
  });

  it('sweeps a forge that declares no queue block at all', async () => {
    const client = new FakeForgeClient('gh').setQueuedJobs([
      {
        project: 'acme/api',
        name: 'build',
        labels: ['arm64'],
        queuedAt: 10,
        url: 'u',
      },
    ]);
    const bare = { ...config, forges: { gh: { kind: 'github' } } } as never;
    const report = await readQueue({
      config: bare,
      forgeClients: new Map([['gh', client]]),
      runnersByGroup: new Map(),
      now: 1000,
    });
    expect(report.swept).toBe(true);
    expect(report.rows).toHaveLength(1);
  });

  it('skips a forge whose queue is disabled', async () => {
    const client = new FakeForgeClient('gh').setQueuedJobs([
      {
        project: 'acme/api',
        name: 'build',
        labels: ['arm64'],
        queuedAt: 10,
        url: 'u',
      },
    ]);
    const off = {
      ...config,
      forges: {
        gh: { kind: 'github', queue: { activeWithinMs: 1, enabled: false } },
      },
    } as never;
    const report = await readQueue({
      config: off,
      forgeClients: new Map([['gh', client]]),
      runnersByGroup: new Map(),
      now: 1000,
    });
    expect(report.swept).toBe(false);
    expect(report.rows).toEqual([]);
  });

  it('sweeps every distinct scope a forge serves, not just the first group it finds', async () => {
    const orgScope = { level: 'organization', target: 'acme' };
    const repoScope = { level: 'repository', target: 'acme/special' };
    const twoScopes = {
      hosts: {},
      forges: {
        gh: {
          kind: 'github',
          queue: { activeWithinMs: 604_800_000, enabled: true },
        },
      },
      groups: [
        {
          name: 'org-group',
          forge: 'gh',
          scope: orgScope,
          placement: { mac: 1 },
          stack: 'docker',
          labels: ['arm64'],
        },
        {
          name: 'repo-group',
          forge: 'gh',
          scope: repoScope,
          placement: { mac: 1 },
          stack: 'docker',
          labels: ['macos'],
        },
      ],
    };
    const client = new FakeForgeClient('gh')
      .setQueuedJobsForScope(orgScope as never, [
        {
          project: 'acme/api',
          name: 'build',
          labels: ['arm64'],
          queuedAt: 10,
          url: 'u1',
        },
      ])
      .setQueuedJobsForScope(repoScope as never, [
        {
          project: 'acme/special',
          name: 'test',
          labels: ['macos'],
          queuedAt: 20,
          url: 'u2',
        },
      ]);
    const report = await readQueue({
      config: twoScopes as never,
      forgeClients: new Map([['gh', client]]),
      runnersByGroup: new Map(),
      now: 1000,
    });
    expect(report.rows.map((row) => row.group)).toEqual([
      'org-group',
      'repo-group',
    ]);
  });

  it('sorts rows by queuedAt regardless of the order jobs came back in', async () => {
    const client = new FakeForgeClient('gh').setQueuedJobs([
      {
        project: 'acme/api',
        name: 'later',
        labels: ['arm64'],
        queuedAt: 200,
        url: 'u1',
      },
      {
        project: 'acme/api',
        name: 'earlier',
        labels: ['arm64'],
        queuedAt: 100,
        url: 'u2',
      },
    ]);
    const report = await readQueue({
      config: config as never,
      forgeClients: new Map([['gh', client]]),
      runnersByGroup: new Map(),
      now: 1000,
    });
    expect(report.rows.map((row) => row.name)).toEqual(['earlier', 'later']);
  });

  it('joins forge runners to groups through the records', () => {
    const observed = {
      hosts: [],
      forges: [
        {
          forge: 'gh',
          reachable: true,
          runners: [
            {
              runner: {
                id: '1',
                name: 'grove-arm64-1',
                status: 'online',
                busy: false,
                labels: ['arm64'],
              },
              scope: { level: 'organization', target: 'acme' },
            },
          ],
        },
      ],
    } as never;
    const records = [{ name: 'grove-arm64-1', group: 'arm64' }] as never;
    expect(runnersByGroup(observed, records).get('arm64')).toHaveLength(1);
  });
});
