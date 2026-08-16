import pc from 'picocolors';
import type { PlanReport } from './report.js';

const STATE_OK = 'ok';
const STATE_UNREACHABLE = 'unreachable';
const STATE_COLUMN = 3;

export interface RenderOptions {
  color?: boolean;
}

export interface TableOptions {
  paintCell?: (value: string, columnIndex: number) => string;
}

export function renderTable(
  headers: string[],
  rows: string[][],
  options: TableOptions = {},
): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const paintCell = options.paintCell ?? ((value: string) => value);

  const line = (cells: string[], paint: boolean): string =>
    cells
      .map((cell, index) => {
        const padded =
          index === cells.length - 1 ? cell : cell.padEnd(widths[index]);
        return paint ? paintCell(padded, index) : padded;
      })
      .join('  ')
      .trimEnd();

  return [line(headers, false), ...rows.map((row) => line(row, true))];
}

export function renderPlanReport(
  report: PlanReport,
  options: RenderOptions = {},
): string {
  const c = pc.createColors(options.color ?? pc.isColorSupported);

  const lines: string[] = [`config  ${report.configPath}`, '', 'Hosts'];

  const hostRows = report.hosts.map((host) => [
    host.name,
    host.type,
    host.target,
    host.reachable ? STATE_OK : STATE_UNREACHABLE,
    host.reachable ? (host.arch ?? '') : (host.reason ?? ''),
  ]);
  for (const line of renderTable(
    ['HOST', 'TYPE', 'TARGET', 'STATE', 'DETAIL'],
    hostRows,
    {
      paintCell: (value, columnIndex) => {
        if (columnIndex !== STATE_COLUMN) {
          return value;
        }
        return value.trimEnd() === STATE_OK ? c.green(value) : c.red(value);
      },
    },
  )) {
    lines.push(`  ${line}`);
  }

  lines.push('', 'Groups grove would manage');
  const groupRows = report.groups.map((group) => [
    group.name,
    `${group.forge} (${group.forgeKind})`,
    group.scope,
    group.stack,
    group.arch ?? '-',
    group.placement.map((entry) => `${entry.host} x${entry.count}`).join(', '),
    String(group.total),
  ]);
  for (const line of renderTable(
    ['GROUP', 'FORGE', 'SCOPE', 'STACK', 'ARCH', 'PLACEMENT', 'RUNNERS'],
    groupRows,
  )) {
    lines.push(`  ${line}`);
  }

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings');
    for (const warning of report.warnings) {
      lines.push(
        `  ${c.yellow('warning')}  ${warning.path}: ${warning.message}`,
      );
    }
  }

  lines.push('');
  lines.push(
    report.ok
      ? c.green('Every host answered. grove plan changes nothing.')
      : c.red(`Unreachable hosts: ${report.unreachable.join(', ')}`),
  );

  return lines.join('\n');
}
