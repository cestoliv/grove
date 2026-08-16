import { describe, expect, it } from 'vitest';
import { PS_ARGS, parsePsOutput } from './docker-ps.js';

const RUNNING = JSON.stringify({
  ID: 'abc123def456',
  Image: 'ghcr.io/actions/actions-runner:latest',
  Names: 'grove-overload-arm-1',
  State: 'running',
  Status: 'Up 3 hours',
  CreatedAt: '2026-08-16 09:12:00 +0200 CEST',
});

const EXITED = JSON.stringify({
  ID: 'fed321',
  Image: 'ghcr.io/actions/actions-runner:latest',
  Names: 'grove-overload-arm-2',
  State: 'exited',
  Status: 'Exited (137) 4 minutes ago',
  CreatedAt: '2026-08-16 09:12:01 +0200 CEST',
});

describe('PS_ARGS', () => {
  it('lists every container whose name grove could own', () => {
    expect(PS_ARGS).toEqual([
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      'name=^grove-',
      '--format',
      '{{json .}}',
    ]);
  });
});

describe('parsePsOutput', () => {
  it('parses one container per line', () => {
    expect(parsePsOutput(`${RUNNING}\n${EXITED}\n`)).toEqual([
      {
        name: 'grove-overload-arm-1',
        containerId: 'abc123def456',
        state: 'running',
        image: 'ghcr.io/actions/actions-runner:latest',
        status: 'Up 3 hours',
        createdAt: '2026-08-16 09:12:00 +0200 CEST',
      },
      {
        name: 'grove-overload-arm-2',
        containerId: 'fed321',
        state: 'exited',
        image: 'ghcr.io/actions/actions-runner:latest',
        status: 'Exited (137) 4 minutes ago',
        createdAt: '2026-08-16 09:12:01 +0200 CEST',
      },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parsePsOutput('')).toEqual([]);
    expect(parsePsOutput('\n\n')).toEqual([]);
  });

  it('keeps the first name when docker reports an alias list', () => {
    const line = JSON.stringify({
      ID: 'a',
      Names: 'grove-ios-1,grove-ios-1-alias',
      State: 'running',
    });
    expect(parsePsOutput(line)[0].name).toBe('grove-ios-1');
  });

  it('skips a line that is not JSON instead of failing the host', () => {
    expect(parsePsOutput(`not json\n${RUNNING}`)).toHaveLength(1);
  });

  it('skips a line with no name', () => {
    expect(
      parsePsOutput(JSON.stringify({ ID: 'a', State: 'running' })),
    ).toEqual([]);
  });

  it('maps an unknown state to unknown', () => {
    const line = JSON.stringify({
      ID: 'a',
      Names: 'grove-ios-1',
      State: 'weird',
    });
    expect(parsePsOutput(line)[0].state).toBe('unknown');
  });
});
