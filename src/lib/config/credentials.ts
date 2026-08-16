import type { Transport } from '../transport/types.js';
import type { ConfigIssue } from './errors.js';
import type { ForgeConfig } from './schema.js';

export const CREDENTIAL_SOURCES_HELP = [
  'grove accepts three credential sources and no fourth:',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text for the user, not interpolation
  '  1. environment interpolation, for example auth: { token: "${GH_TOKEN}" }',
  '  2. a command, for example auth: { command: "op read op://infra/gitlab/pat" }',
  '  3. no auth block at all, which delegates to the gh or glab CLI',
].join('\n');

export const LITERAL_TOKEN_PATTERNS: RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^glpat-[A-Za-z0-9_-]{16,}$/,
  /^glrt-[A-Za-z0-9_-]{16,}$/,
  /^[0-9a-f]{40}$/,
];

export function isLiteralToken(value: string): boolean {
  const trimmed = value.trim();
  return LITERAL_TOKEN_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function detectLiteralTokens(document: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (document === null || typeof document !== 'object') {
    return issues;
  }
  const forges = (document as { forges?: unknown }).forges;
  if (forges === null || typeof forges !== 'object') {
    return issues;
  }
  for (const [name, forge] of Object.entries(forges)) {
    if (forge === null || typeof forge !== 'object') {
      continue;
    }
    const auth = (forge as { auth?: unknown }).auth;
    if (auth === null || typeof auth !== 'object') {
      continue;
    }
    const token = (auth as { token?: unknown }).token;
    if (typeof token === 'string' && isLiteralToken(token)) {
      issues.push({
        path: `forges.${name}.auth.token`,
        message: `looks like a literal credential, which never belongs in grove.yaml.\n${CREDENTIAL_SOURCES_HELP}`,
      });
    }
  }
  return issues;
}

export type ResolvedCredential =
  | { kind: 'token'; token: string }
  | { kind: 'cli'; cli: 'gh' | 'glab' };

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

// `transport` must be the control node's local transport. A `command:`
// source runs the password manager locally, so running it over a remote
// (SSH) transport would either fail or read the wrong machine's vault.
export async function resolveCredential(
  name: string,
  forge: ForgeConfig,
  transport: Transport,
): Promise<ResolvedCredential> {
  const auth = forge.auth;

  if (auth === undefined) {
    return { kind: 'cli', cli: forge.kind === 'github' ? 'gh' : 'glab' };
  }

  if (auth.source === 'token') {
    return { kind: 'token', token: auth.token };
  }

  const result = await transport.exec('sh', ['-c', auth.command]);
  if (result.code !== 0) {
    throw new CredentialError(
      `forge "${name}": credential command exited ${result.code}: ${result.stderr.trim()}`,
    );
  }
  const token = result.stdout.trim();
  if (token === '') {
    throw new CredentialError(
      `forge "${name}": credential command printed nothing`,
    );
  }
  return { kind: 'token', token };
}
