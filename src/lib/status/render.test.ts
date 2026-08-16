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
    container: 'running',
    containerStatus: 'Up 3 hours',
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
