import pc from 'picocolors';
import { renderTable } from '../plan/render.js';
import type { StatusReport } from './report.js';

const FORGE_COLUMN = 5;

export interface StatusRenderOptions {
  color?: boolean;
}

export function renderStatusReport(
  report: StatusReport,
  options: StatusRenderOptions = {},
): string {
  const c = pc.createColors(options.color ?? pc.isColorSupported);
  const lines: string[] = [`config  ${report.configPath}`, '', 'Runners'];

  if (report.rows.length === 0) {
    lines.push('  no runner, managed or otherwise, was found');
  } else {
    const rows = report.rows.map((row) => [
      row.group,
      row.host,
      row.runner,
      row.container,
      row.containerStatus,
      row.forgeStatus,
      row.ownership,
    ]);
    for (const line of renderTable(
      ['GROUP', 'HOST', 'RUNNER', 'CONTAINER', 'DETAIL', 'FORGE', 'OWNER'],
      rows,
      {
        paintCell: (value, columnIndex) => {
          if (columnIndex !== FORGE_COLUMN) {
            return value;
          }
          const state = value.trimEnd();
          if (state === 'busy') {
            return c.cyan(value);
          }
          return state === 'online' ? c.green(value) : c.red(value);
        },
      },
    )) {
      lines.push(`  ${line}`);
    }
  }

  lines.push('');
  if (report.ok) {
    lines.push(c.green('Every host and forge answered.'));
  } else {
    const parts = [
      ...report.unreachableHosts.map((host) => `host ${host}`),
      ...report.unreachableForges.map((forge) => `forge ${forge}`),
    ];
    lines.push(c.red(`Did not answer: ${parts.join(', ')}`));
  }

  return lines.join('\n');
}
