import type { ZodError } from 'zod';

export interface ConfigIssue {
  path: string;
  message: string;
}

export function issuePath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else if (out === '') {
      out = String(segment);
    } else {
      out += `.${String(segment)}`;
    }
  }
  return out === '' ? '<root>' : out;
}

export function issuesFromZod(error: ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issuePath(issue.path),
    message: issue.message,
  }));
}

export function formatConfigIssues(
  issues: ConfigIssue[],
  configPath?: string,
): string {
  const header =
    configPath === undefined
      ? 'Invalid config'
      : `Invalid config at ${configPath}`;
  return [
    header,
    ...issues.map(
      (issue) => `  ${issue.path}: ${issue.message.split('\n').join('\n  ')}`,
    ),
  ].join('\n');
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  readonly configPath?: string;

  constructor(issues: ConfigIssue[], configPath?: string) {
    super(formatConfigIssues(issues, configPath));
    this.name = 'ConfigError';
    this.issues = issues;
    this.configPath = configPath;
  }
}
