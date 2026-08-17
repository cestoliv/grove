import { describe, expect, it } from 'vitest';
import { renderStatusReport } from './render.js';
import type { StatusReport, StatusRow } from './report.js';

// Built here rather than typed, so no control character sits in the source.
const ESC = String.fromCharCode(27);

function row(overrides: Partial<StatusRow> = {}): StatusRow {
  return {
    group: 'overload-arm',
    host: 'mac',
    runner: 'grove-overload-arm-1',
    stack: 'docker',
    process: 'running',
    detail: 'Up 3 hours',
    forge: 'gh-overload',
    forgeStatus: 'online',
    ownership: 'managed',
    recordId: 1,
    ...overrides,
  };
}

function report(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    configPath: '/work/grove.yaml',
    rows: [row()],
    sharedRunners: [],
    suspects: [],
    storage: [],
    unreachableHosts: [],
    unreachableForges: [],
    ok: true,
    ...overrides,
  };
}

describe('renderStatusReport', () => {
  it('says so rather than printing an empty table', () => {
    const text = renderStatusReport(report({ rows: [] }), { color: false });
    expect(text).toContain('config  /work/grove.yaml');
    expect(text).toContain('no runner, managed or otherwise, was found');
    expect(text).not.toContain('GROUP');
  });

  it('prints a header and one line per row', () => {
    const text = renderStatusReport(
      report({
        rows: [row(), row({ runner: 'grove-overload-arm-2', host: 'atlas' })],
      }),
      { color: false },
    );
    const lines = text.split('\n');
    expect(lines.some((line) => line.includes('GROUP'))).toBe(true);
    expect(
      lines.filter((line) => line.includes('grove-overload-arm')),
    ).toHaveLength(2);
    expect(text).toContain('atlas');
  });

  it('leaves the forge column unpainted when colour is off', () => {
    const text = renderStatusReport(report(), { color: false });
    expect(text.includes(ESC)).toBe(false);
  });

  it('paints the forge column by state when colour is on', () => {
    const text = renderStatusReport(
      report({
        rows: [
          row({ forgeStatus: 'online' }),
          row({ runner: 'grove-overload-arm-2', forgeStatus: 'busy' }),
          row({ runner: 'grove-overload-arm-3', forgeStatus: 'offline' }),
        ],
      }),
      { color: true },
    );
    // Green for online, cyan for busy, red for anything else.
    expect(text).toContain(`${ESC}[32monline`);
    expect(text).toContain(`${ESC}[36mbusy`);
    expect(text).toContain(`${ESC}[31moffline`);
  });

  it('closes with a green line when every host and forge answered', () => {
    const text = renderStatusReport(report(), { color: false });
    expect(text.trimEnd().endsWith('Every host and forge answered.')).toBe(
      true,
    );
  });

  it('names every host and forge that did not answer when not ok', () => {
    const text = renderStatusReport(
      report({
        ok: false,
        unreachableHosts: ['atlas'],
        unreachableForges: ['gh-overload'],
      }),
      { color: false },
    );
    expect(text).toContain('Did not answer: host atlas, forge gh-overload');
    expect(text).not.toContain('Every host and forge answered.');
  });
});

describe('renderStatusReport, managers', () => {
  const base = {
    configPath: '/tmp/grove.yaml',
    suspects: [],
    storage: [],
    unreachableHosts: [],
    unreachableForges: [],
    ok: true,
  };

  it('adds a manager column when a row has one', () => {
    const text = renderStatusReport(
      {
        ...base,
        rows: [
          {
            group: 'chevro-dind',
            host: 'atlas',
            runner: 'grove-chevro-dind-1',
            stack: 'docker',
            process: 'running',
            detail: 'Up 2 hours',
            forge: 'gl-chevro',
            forgeStatus: 'online',
            managerStatus: 'online',
            systemId: 's_aaaaaaaaaaaa',
            ownership: 'managed',
          },
        ],
        sharedRunners: [],
      },
      { color: false },
    );
    expect(text).toContain('MANAGER');
    expect(text).toMatch(/online\s+online\s+managed/);
  });

  it('leaves the manager column out of a GitHub only fleet', () => {
    const text = renderStatusReport(
      {
        ...base,
        rows: [
          {
            group: 'overload-arm',
            host: 'mac',
            runner: 'grove-overload-arm-1',
            stack: 'docker',
            process: 'running',
            detail: 'Up 1 hour',
            forge: 'gh-overload',
            forgeStatus: 'online',
            ownership: 'managed',
          },
        ],
        sharedRunners: [],
      },
      { color: false },
    );
    expect(text).not.toContain('MANAGER');
  });

  it('lists every shared entity with its tags and its manager count', () => {
    const text = renderStatusReport(
      {
        ...base,
        rows: [],
        sharedRunners: [
          {
            forge: 'gl-chevro',
            group: 'chevro-dind',
            entityId: '48',
            description: 'grove-chevro-dind',
            tags: ['docker', 'dind'],
            managers: 2,
            expected: 3,
          },
        ],
      },
      { color: false },
    );
    expect(text).toContain('Shared runners');
    expect(text).toContain('docker,dind');
    expect(text).toContain('2/3');
  });
});

describe('renderStatusReport, the stack column', () => {
  it('prints a stack for every row', () => {
    const text = renderStatusReport(
      {
        configPath: '/work/grove.yaml',
        rows: [
          {
            group: 'ios',
            host: 'mac',
            runner: 'grove-ios-1',
            stack: 'native',
            process: 'running',
            detail: 'pid 4242',
            forge: 'gh-overload',
            forgeStatus: 'online',
            ownership: 'managed',
          },
        ],
        sharedRunners: [],
        suspects: [],
        storage: [],
        unreachableHosts: [],
        unreachableForges: [],
        ok: true,
      },
      { color: false },
    );

    expect(text).toContain('GROUP  HOST  RUNNER       STACK   PROCESS  DETAIL');
    expect(text).toContain(
      'ios    mac   grove-ios-1  native  running  pid 4242',
    );
  });
});

describe('the daemon and the suspect sections', () => {
  it('says whether the control loop is running and when it last ran', () => {
    const text = renderStatusReport(
      report({
        daemon: {
          lockPath: '/state/grove.pid',
          pid: 4242,
          command: 'daemon',
          alive: true,
          lastFastTick: 1_700_000_000_000,
          lastFullTick: 1_699_999_000_000,
        },
      }),
      { color: false },
    );
    expect(text).toContain('Daemon');
    expect(text).toContain('pid 4242');
    expect(text).toContain('2023-11-14');
  });

  it('says the loop is not running when nothing holds the lock', () => {
    const text = renderStatusReport(
      report({ daemon: { lockPath: '/state/grove.pid', alive: false } }),
      { color: false },
    );
    expect(text).toContain('not running');
  });

  it('does not report a concurrent apply as the daemon', () => {
    // apply, teardown and the daemon share one lock file, so the holder is not
    // the daemon just because there is one. A heading that said otherwise
    // would answer the wrong question.
    const text = renderStatusReport(
      report({
        daemon: {
          lockPath: '/state/grove.pid',
          pid: 4242,
          command: 'apply',
          alive: true,
        },
      }),
      { color: false },
    );
    expect(text).toContain('not running');
    expect(text).not.toContain('pid 4242');
  });

  it('prints nothing about the daemon when the caller read nothing', () => {
    expect(renderStatusReport(report(), { color: false })).not.toContain(
      'Daemon',
    );
  });

  it('lists a suspect with its reason', () => {
    const text = renderStatusReport(
      report({
        suspects: [
          {
            runner: 'grove-ios-1',
            host: 'mac',
            since: 1_700_000_000_000,
            reason: 'busy for 118m, but the work dir is still changing',
          },
        ],
      }),
      { color: false },
    );
    expect(text).toContain('Suspect runners');
    expect(text).toContain('grove-ios-1');
    expect(text).toContain('busy for 118m');
  });
});

describe('renderStatusReport, storage', () => {
  const measured = {
    host: 'mac',
    docker: {
      imagesBytes: 12.3 * 1024 ** 3,
      imagesReclaimableBytes: 4.1 * 1024 ** 3,
      containersBytes: 0,
      volumesBytes: 0,
      buildCacheBytes: 0,
    },
    workDirBytes: 2 * 1024 ** 3,
    workDirs: [{ name: 'grove-overload-arm-1', bytes: 2 * 1024 ** 3 }],
  };

  it('prints a row per host with images, reclaimable and work dirs', () => {
    const text = renderStatusReport(
      { ...report(), storage: [measured] },
      { color: false },
    );
    expect(text).toContain('Storage');
    expect(text).toContain('12.3 GiB');
    expect(text).toContain('4.1 GiB');
    expect(text).toContain('2.0 GiB');
    expect(text).toContain('grove-overload-arm-1');
  });

  it('names what could not be measured instead of printing a zero', () => {
    const text = renderStatusReport(
      {
        ...report(),
        storage: [
          {
            host: 'atlas',
            dockerError: 'Cannot connect to the Docker daemon.',
            workDirs: [],
          },
        ],
      },
      { color: false },
    );
    expect(text).toContain('Cannot connect to the Docker daemon.');
    expect(text).not.toContain('0 B');
  });

  it('prints no section at all when nothing was measured', () => {
    const text = renderStatusReport(
      { ...report(), storage: [] },
      {
        color: false,
      },
    );
    expect(text).not.toContain('Storage');
  });
});
