import { describe, expect, it } from 'vitest';
import type { GroupConfig } from '../config/index.js';
import type { ForgeRunner } from '../forge/index.js';
import { groupForJob } from './match.js';

const group = (over: Partial<GroupConfig> & { name: string }): GroupConfig =>
  ({
    forge: 'gh',
    scope: { level: 'organization', target: 'acme' },
    placement: { mac: 1 },
    stack: 'docker',
    ...over,
  }) as GroupConfig;

const runner = (labels: string[]): ForgeRunner => ({
  id: '1',
  name: 'r',
  status: 'online',
  busy: false,
  labels,
});

describe('groupForJob', () => {
  it('folds case, because a job asks for macos and a runner reports macOS', () => {
    const groups = [group({ name: 'overload-macos' })];
    const runners = new Map([
      ['overload-macos', [runner(['self-hosted', 'macOS', 'ARM64'])]],
    ]);
    const found = groupForJob(
      {
        project: 'acme/mobile',
        name: 'e2e',
        labels: ['self-hosted', 'macos'],
        queuedAt: 0,
        url: '',
      },
      'gh',
      groups,
      runners,
    );
    expect(found).toBe('overload-macos');
  });

  it('drops a job no runner can take', () => {
    const groups = [group({ name: 'overload-macos' })];
    const runners = new Map([
      ['overload-macos', [runner(['self-hosted', 'macOS'])]],
    ]);
    expect(
      groupForJob(
        {
          project: 'acme/api',
          name: 'build',
          labels: ['ubuntu-latest'],
          queuedAt: 0,
          url: '',
        },
        'gh',
        groups,
        runners,
      ),
    ).toBeUndefined();
  });

  it('falls back to the configured labels when no runner of the group is online', () => {
    const groups = [group({ name: 'overload-arm64', labels: ['arm64'] })];
    expect(
      groupForJob(
        {
          project: 'acme/api',
          name: 'build',
          labels: ['arm64'],
          queuedAt: 0,
          url: '',
        },
        'gh',
        groups,
        new Map(),
      ),
    ).toBe('overload-arm64');
  });

  it('never matches a group on another forge', () => {
    const groups = [
      group({ name: 'overload-arm64', forge: 'other', labels: ['arm64'] }),
    ];
    expect(
      groupForJob(
        {
          project: 'acme/api',
          name: 'build',
          labels: ['arm64'],
          queuedAt: 0,
          url: '',
        },
        'gh',
        groups,
        new Map(),
      ),
    ).toBeUndefined();
  });

  it('gives an untagged GitLab job to a group that takes untagged work', () => {
    const groups = [
      group({
        name: 'tagged',
        forge: 'gl',
        scope: { level: 'instance' },
        tags: ['docker'],
      }),
      group({ name: 'plain', forge: 'gl', scope: { level: 'instance' } }),
    ];
    expect(
      groupForJob(
        {
          project: 'infra/ci',
          name: 'deploy',
          labels: [],
          queuedAt: 0,
          url: '',
        },
        'gl',
        groups,
        new Map(),
      ),
    ).toBe('plain');
  });
});
