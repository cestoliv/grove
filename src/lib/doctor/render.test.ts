import { describe, expect, it } from 'vitest';
import { renderDoctorReport, statusLabel, targetHeading } from './render.js';
import type { DoctorReport } from './run.js';
import { type CheckReport, countStatuses } from './types.js';

const ESC = String.fromCharCode(27);

function reportOf(checks: CheckReport[]): DoctorReport {
  const counts = countStatuses(checks);
  return {
    configPath: '/etc/grove/grove.yaml',
    checks,
    counts,
    ok: counts.fail === 0,
    hostFacts: [],
  };
}

const CHECKS: CheckReport[] = [
  {
    id: 'control.node',
    target: { kind: 'control', name: 'control node' },
    status: 'ok',
    summary: 'Node v22.13.0',
  },
  {
    id: 'host.docker-daemon',
    target: { kind: 'host', name: 'atlas' },
    status: 'fail',
    summary: 'Cannot connect to the Docker daemon',
    fix: 'Start the daemon with `sudo systemctl start docker`.',
  },
  {
    id: 'host.disk',
    target: { kind: 'host', name: 'atlas' },
    status: 'warn',
    subject: '/srv/grove',
    summary: '4.0 GiB free, 96% used',
    fix: 'Free space on /srv.',
  },
  {
    id: 'group.arch',
    target: { kind: 'group', name: 'arm' },
    status: 'skip',
    summary: 'the group names no architecture',
  },
];

describe('statusLabel', () => {
  it('gives each status a word', () => {
    expect(statusLabel('ok')).toBe('ok');
    expect(statusLabel('warn')).toBe('warn');
    expect(statusLabel('fail')).toBe('fail');
    expect(statusLabel('skip')).toBe('skip');
  });
});

describe('targetHeading', () => {
  it('names the family and the target', () => {
    expect(targetHeading({ kind: 'host', name: 'atlas' })).toBe('Host atlas');
    expect(targetHeading({ kind: 'forge', name: 'gh' })).toBe('Forge gh');
    expect(targetHeading({ kind: 'group', name: 'arm' })).toBe('Group arm');
    expect(targetHeading({ kind: 'control', name: 'control node' })).toBe(
      'Control node',
    );
  });
});

describe('renderDoctorReport', () => {
  it('prints the config path, one heading per target and one row per check', () => {
    const text = renderDoctorReport(reportOf(CHECKS), { color: false });
    expect(text).toContain('config  /etc/grove/grove.yaml');
    expect(text).toContain('Control node');
    expect(text).toContain('Host atlas');
    expect(text).toContain('Group arm');
    expect(text).toContain('host.docker-daemon');
    expect(text).toContain('Cannot connect to the Docker daemon');
  });

  it('shows a subject column only for a target that has one', () => {
    const text = renderDoctorReport(reportOf(CHECKS), { color: false });
    const lines = text.split('\n');
    const control = lines.findIndex((line) => line.startsWith('Control node'));
    const host = lines.findIndex((line) => line.startsWith('Host atlas'));
    expect(lines[control + 1]).not.toContain('SUBJECT');
    expect(lines[host + 1]).toContain('SUBJECT');
    expect(text).toContain('/srv/grove');
  });

  it('prints every fix once, under its own heading', () => {
    const text = renderDoctorReport(reportOf(CHECKS), { color: false });
    expect(text).toContain('Fixes');
    expect(text).toContain('sudo systemctl start docker');
    expect(text).toContain('Free space on /srv.');
    expect(text.split('sudo systemctl start docker')).toHaveLength(2);
  });

  it('closes with the counts and the next step', () => {
    const text = renderDoctorReport(reportOf(CHECKS), { color: false });
    expect(text).toContain('1 ok, 1 warning, 1 failure, 1 skipped');
    expect(text).toContain('grove doctor');
    // The gate stamps a host on its first successful apply and never checks
    // it again, so the closing line has to say "before the first apply".
    expect(text).toContain(
      'grove apply runs the host checks before the first apply against a host it has no record of, and refuses a host with a failing check.',
    );
  });

  it('says the fleet is ready when nothing failed and nothing warned', () => {
    const text = renderDoctorReport(reportOf([CHECKS[0]]), { color: false });
    expect(text).toContain('Every check passed.');
    expect(text).not.toContain('Fixes');
  });

  it('says a warning is a failure under --strict', () => {
    const warned = reportOf([CHECKS[0], CHECKS[2]]);
    const text = renderDoctorReport(warned, { color: false, strict: true });
    expect(text).toContain('--strict');
  });

  it('paints nothing when color is off', () => {
    const text = renderDoctorReport(reportOf(CHECKS), { color: false });
    expect(text.includes(ESC)).toBe(false);
  });
});
