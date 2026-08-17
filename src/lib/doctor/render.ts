import pc from 'picocolors';
import { renderTable } from '../plan/render.js';
import type { DoctorReport } from './run.js';
import type { CheckReport, CheckStatus, CheckTarget } from './types.js';

export interface DoctorRenderOptions {
  color?: boolean;
  strict?: boolean;
}

export function statusLabel(status: CheckStatus): string {
  return status;
}

export function targetHeading(target: CheckTarget): string {
  switch (target.kind) {
    case 'control':
      return 'Control node';
    case 'host':
      return `Host ${target.name}`;
    case 'forge':
      return `Forge ${target.name}`;
    default:
      return `Group ${target.name}`;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function renderDoctorReport(
  report: DoctorReport,
  options: DoctorRenderOptions = {},
): string {
  const c = pc.createColors(options.color ?? pc.isColorSupported);
  const paint = (status: CheckStatus, value: string): string => {
    switch (status) {
      case 'fail':
        return c.red(value);
      case 'warn':
        return c.yellow(value);
      case 'ok':
        return c.green(value);
      default:
        return c.dim(value);
    }
  };

  const lines: string[] = [`config  ${report.configPath}`];

  // The report is already sorted by family and by config order, so grouping
  // consecutive targets keeps that order rather than inventing another one.
  const groups: Array<{ target: CheckTarget; checks: CheckReport[] }> = [];
  for (const check of report.checks) {
    const last = groups[groups.length - 1];
    if (
      last !== undefined &&
      last.target.kind === check.target.kind &&
      last.target.name === check.target.name
    ) {
      last.checks.push(check);
      continue;
    }
    groups.push({ target: check.target, checks: [check] });
  }

  for (const group of groups) {
    lines.push('', targetHeading(group.target));
    // A column of dashes helps nobody, so the subject only earns its width
    // when a check on this target answered about more than one thing.
    const showSubject = group.checks.some(
      (check) => check.subject !== undefined,
    );
    const rows = group.checks.map((check) => [
      check.id,
      ...(showSubject ? [check.subject ?? ''] : []),
      statusLabel(check.status),
      check.summary,
    ]);
    const statusColumn = showSubject ? 2 : 1;
    for (const line of renderTable(
      ['CHECK', ...(showSubject ? ['SUBJECT'] : []), 'STATUS', 'SUMMARY'],
      rows,
      {
        paintCell: (value, columnIndex) =>
          columnIndex === statusColumn
            ? paint(value.trimEnd() as CheckStatus, value)
            : value,
      },
    )) {
      lines.push(`  ${line}`);
    }
  }

  const actionable = report.checks.filter(
    (check) =>
      (check.status === 'fail' || check.status === 'warn') &&
      check.fix !== undefined,
  );
  if (actionable.length > 0) {
    lines.push('', 'Fixes');
    for (const check of actionable) {
      const where = `${targetHeading(check.target)}${check.subject === undefined ? '' : `, ${check.subject}`}`;
      lines.push(
        `  ${paint(check.status, statusLabel(check.status))}  ${check.id}  ${where}`,
      );
      lines.push(`      ${check.summary}`);
      lines.push(`      ${check.fix}`);
      lines.push('');
    }
    // The loop leaves one blank line, which is the separator the closing
    // block adds for itself.
    lines.pop();
  }

  const { ok, warn, fail, skip } = report.counts;
  const counts = [
    `${ok} ok`,
    plural(warn, 'warning', 'warnings'),
    plural(fail, 'failure', 'failures'),
    `${skip} skipped`,
  ].join(', ');

  lines.push('', counts);
  if (fail > 0) {
    lines.push(
      c.red(
        'Run the fixes above, then grove doctor again. grove apply runs the host checks before the first apply against a host it has no record of, and refuses a host with a failing check.',
      ),
    );
  } else if (warn > 0) {
    lines.push(
      options.strict === true
        ? c.yellow(
            '--strict makes every warning a failure, so this run exits 1. Run grove doctor without it to see the same table without the exit code.',
          )
        : c.yellow(
            'Nothing is blocked. Every warning above is worth reading once.',
          ),
    );
  } else {
    lines.push(c.green('Every check passed.'));
  }

  return lines.join('\n');
}
