import { describe, expect, it } from 'vitest';
import { renderPlanReport, renderTable } from './render.js';
import type { PlanReport } from './report.js';

const ESCAPE = String.fromCharCode(27);

function buildReport(overrides: Partial<PlanReport> = {}): PlanReport {
  return {
    configPath: '/work/grove.yaml',
    hosts: [
      {
        name: 'mac',
        type: 'local',
        target: 'this machine',
        reachable: true,
        arch: 'arm64',
      },
      {
        name: 'atlas',
        type: 'ssh',
        target: 'atlas',
        reachable: false,
        reason: 'ssh: connect to host atlas port 22: No route to host',
      },
    ],
    groups: [
      {
        name: 'overload-arm',
        forge: 'gh-overload',
        forgeKind: 'github',
        scope: 'organization Overload-coach',
        stack: 'docker',
        arch: 'arm64',
        placement: [{ host: 'mac', count: 2 }],
        total: 2,
      },
    ],
    warnings: [],
    actions: [],
    degraded: [],
    unreachable: ['atlas'],
    ok: false,
    ...overrides,
  };
}

describe('renderTable', () => {
  it('pads every column to its widest cell', () => {
    expect(
      renderTable(
        ['HOST', 'STATE'],
        [
          ['mac', 'ok'],
          ['atlas', 'unreachable'],
        ],
      ),
    ).toEqual(['HOST   STATE', 'mac    ok', 'atlas  unreachable']);
  });

  it('does not pad the last column, so lines have no trailing space', () => {
    const lines = renderTable(['A', 'B'], [['x', 'y']]);
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('renders headers alone when there are no rows', () => {
    expect(renderTable(['GROUP', 'RUNNERS'], [])).toEqual(['GROUP  RUNNERS']);
  });
});

describe('renderPlanReport', () => {
  it('names the config file', () => {
    expect(renderPlanReport(buildReport(), { color: false })).toContain(
      'config  /work/grove.yaml',
    );
  });

  it('prints a host table with the state and the reason', () => {
    const text = renderPlanReport(buildReport(), { color: false });
    expect(text).toContain('HOST   TYPE   TARGET        STATE        DETAIL');
    expect(text).toContain('mac    local  this machine  ok           arm64');
    expect(text).toContain(
      'atlas  ssh    atlas         unreachable  ssh: connect to host atlas port 22: No route to host',
    );
  });

  it('prints the groups it would manage', () => {
    const text = renderPlanReport(buildReport(), { color: false });
    expect(text).toContain('Groups grove would manage');
    expect(text).toContain(
      'overload-arm  gh-overload (github)  organization Overload-coach  docker  arm64  mac x2     2',
    );
  });

  it('renders a dash for a group with no declared architecture', () => {
    const report = buildReport();
    report.groups[0].arch = undefined;
    expect(renderPlanReport(report, { color: false })).toContain(
      'docker  -     mac x2',
    );
  });

  it('joins a placement that spans hosts', () => {
    const report = buildReport();
    report.groups[0].placement = [
      { host: 'mac', count: 2 },
      { host: 'atlas', count: 1 },
    ];
    report.groups[0].total = 3;
    expect(renderPlanReport(report, { color: false })).toContain(
      'mac x2, atlas x1',
    );
  });

  it('closes with the unreachable hosts when any host is down', () => {
    const text = renderPlanReport(buildReport(), { color: false });
    expect(text.trimEnd().endsWith('Unreachable hosts: atlas')).toBe(true);
  });

  it('closes with a success line when every host answers and nothing changes', () => {
    const report = buildReport({ unreachable: [], ok: true });
    report.hosts[1].reachable = true;
    report.hosts[1].reason = undefined;
    report.hosts[1].arch = 'amd64';
    const text = renderPlanReport(report, { color: false });
    expect(
      text.trimEnd().endsWith('Every host answered. Nothing to change.'),
    ).toBe(true);
  });

  it('closes with the change count, counting no report action', () => {
    const report = buildReport({
      unreachable: [],
      ok: true,
      actions: [
        {
          kind: 'create-runner',
          host: 'mac',
          forge: 'gh-overload',
          group: 'overload-arm',
          index: 1,
          name: 'grove-overload-arm-1',
          destructive: false,
        },
        {
          kind: 'report-unsupported',
          group: 'chevro-dind',
          reason: 'grove manages GitHub groups on the Docker stack today',
          destructive: false,
        },
      ],
    });
    report.hosts[1].reachable = true;
    report.hosts[1].reason = undefined;
    report.hosts[1].arch = 'amd64';
    const text = renderPlanReport(report, { color: false });
    expect(
      text
        .trimEnd()
        .endsWith(
          '1 change(s) planned. grove plan changes nothing. Run grove apply to make them.',
        ),
    ).toBe(true);
  });

  it('closes for apply, which is about to make the changes', () => {
    const report = buildReport({
      unreachable: [],
      ok: true,
      actions: [
        {
          kind: 'create-runner',
          host: 'mac',
          forge: 'gh-overload',
          group: 'overload-arm',
          index: 1,
          name: 'grove-overload-arm-1',
          destructive: false,
        },
        {
          kind: 'report-unsupported',
          group: 'chevro-dind',
          reason: 'grove manages GitHub groups on the Docker stack today',
          destructive: false,
        },
      ],
    });
    report.hosts[1].reachable = true;
    report.hosts[1].reason = undefined;
    report.hosts[1].arch = 'amd64';
    const text = renderPlanReport(report, { color: false, closing: 'apply' });
    expect(text.trimEnd().endsWith('1 change(s) to apply.')).toBe(true);
    expect(text).not.toContain('grove plan changes nothing');
  });

  it('closes for apply with nothing to change when no action is left', () => {
    const report = buildReport({ unreachable: [], ok: true });
    report.hosts[1].reachable = true;
    report.hosts[1].reason = undefined;
    report.hosts[1].arch = 'amd64';
    const text = renderPlanReport(report, { color: false, closing: 'apply' });
    expect(text.trimEnd().endsWith('Nothing to change.')).toBe(true);
    expect(text).not.toContain('Every host answered');
  });

  it('keeps the unreachable ending when a host is down and changes are planned', () => {
    const report = buildReport({
      actions: [
        {
          kind: 'create-runner',
          host: 'mac',
          forge: 'gh-overload',
          group: 'overload-arm',
          index: 1,
          name: 'grove-overload-arm-1',
          destructive: false,
        },
      ],
    });
    const text = renderPlanReport(report, { color: false });
    expect(text.trimEnd().endsWith('Unreachable hosts: atlas')).toBe(true);
  });

  it('omits the warnings section when there are none', () => {
    expect(renderPlanReport(buildReport(), { color: false })).not.toContain(
      'Warnings',
    );
  });

  it('prints each warning with its path', () => {
    const report = buildReport({
      warnings: [
        {
          code: 'privileged-docker-socket',
          path: 'groups[1]',
          message: 'group "chevro-dind" runs privileged and mounts the socket.',
        },
      ],
    });
    const text = renderPlanReport(report, { color: false });
    expect(text).toContain('Warnings');
    expect(text).toContain(
      'warning  groups[1]: group "chevro-dind" runs privileged and mounts the socket.',
    );
  });

  it('emits no ANSI escapes when colour is off', () => {
    expect(renderPlanReport(buildReport(), { color: false })).not.toContain(
      ESCAPE,
    );
  });

  it('emits ANSI escapes when colour is on', () => {
    expect(renderPlanReport(buildReport(), { color: true })).toContain(ESCAPE);
  });

  it('says nothing needs changing when there are no actions', () => {
    const text = renderPlanReport(buildReport(), { color: false });
    expect(text).toContain('Changes');
    expect(text).toContain('nothing to change');
  });

  it('prints one line per action', () => {
    const report = buildReport({
      actions: [
        {
          kind: 'create-runner',
          host: 'mac',
          forge: 'gh-overload',
          group: 'overload-arm',
          index: 1,
          name: 'grove-overload-arm-1',
          destructive: false,
        },
      ],
    });
    const text = renderPlanReport(report, { color: false });
    expect(text).toContain(
      'create      grove-overload-arm-1  on mac, registering at gh-overload',
    );
    expect(text).not.toContain('nothing to change');
  });

  it('closes with the degraded targets when no host is down', () => {
    const report = buildReport({
      unreachable: [],
      degraded: ['grove-overload-arm-1'],
      ok: false,
    });
    report.hosts[1].reachable = true;
    report.hosts[1].reason = undefined;
    const text = renderPlanReport(report, { color: false });
    expect(text.trimEnd().endsWith('Degraded: grove-overload-arm-1')).toBe(
      true,
    );
  });
});
