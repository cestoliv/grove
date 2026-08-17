import pc from 'picocolors';
import { renderTable } from '../plan/render.js';
import type { StatusReport } from './report.js';

const FORGE_COLUMN = 6;

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
    // The column only earns its width when a forge in this fleet has
    // managers at all.
    const showManagers = report.rows.some(
      (row) => row.managerStatus !== undefined,
    );
    const rows = report.rows.map((row) => [
      row.group,
      row.host,
      row.runner,
      row.stack,
      row.process,
      row.detail,
      row.forgeStatus,
      ...(showManagers ? [row.managerStatus ?? '-'] : []),
      row.ownership,
    ]);
    for (const line of renderTable(
      [
        'GROUP',
        'HOST',
        'RUNNER',
        'STACK',
        'PROCESS',
        'DETAIL',
        'FORGE',
        ...(showManagers ? ['MANAGER'] : []),
        'OWNER',
      ],
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

  if (report.sharedRunners.length > 0) {
    lines.push('', 'Shared runners');
    for (const line of renderTable(
      ['FORGE', 'GROUP', 'ENTITY', 'TAGS', 'MANAGERS'],
      report.sharedRunners.map((entity) => [
        entity.forge,
        entity.group,
        entity.entityId,
        entity.tags.join(','),
        `${entity.managers}/${entity.expected}`,
      ]),
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
