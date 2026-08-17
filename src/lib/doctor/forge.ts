import {
  CREDENTIAL_SOURCES_HELP,
  type ForgeConfig,
  type GroveConfig,
  type Level,
  type Scope,
} from '../config/index.js';
import { type FetchFn, gitlabAuthHint } from '../forge/index.js';
import type { Limiter } from '../reconcile/index.js';
import {
  type ForgeProbeInput,
  forgeGet,
  GITHUB_SCOPES_FOR_LEVEL,
  GITLAB_CREATE_SCOPE,
  GITLAB_READ_SCOPES,
  type HttpAnswer,
  readGithubIdentity,
  readGithubScopeAccess,
  readGitlabIdentity,
  readGitlabNamespace,
  readGitlabScopeRunners,
  readGitlabTokenScopes,
} from './forge-api.js';
import { type CheckReport, type CheckResult, fail, ok, skip } from './types.js';

export interface ForgeCheckContext {
  name: string;
  forge: ForgeConfig;
  // Every distinct scope the config declares against this forge.
  scopes: Scope[];
  token?: string;
  // Why grove has no token, when it has none. Doctor resolves credentials one
  // forge at a time rather than through openFleet, so a broken token on one
  // forge is a finding rather than an exception that stops the whole run.
  tokenError?: string;
  fetchFn: FetchFn;
  limit: Limiter;
}

export const FORGE_CHECK_IDS = [
  'forge.credential',
  'forge.token',
  'forge.scopes',
  'forge.admin',
  'forge.scope-access',
];

export function formatScopeLabel(scope: Scope): string {
  return 'target' in scope ? `${scope.level} ${scope.target}` : scope.level;
}

function scopeKey(scope: Scope): string {
  return 'target' in scope ? `${scope.level}:${scope.target}` : scope.level;
}

export function forgeScopes(config: GroveConfig): Map<string, Scope[]> {
  const byForge = new Map<string, Scope[]>();
  for (const group of config.groups) {
    const list = byForge.get(group.forge) ?? [];
    if (!list.some((scope) => scopeKey(scope) === scopeKey(group.scope))) {
      list.push(group.scope);
    }
    byForge.set(group.forge, list);
  }
  return byForge;
}

function describeStatus(status: number, error?: string): string {
  if (status === 0) {
    return error ?? 'the forge did not answer';
  }
  return `the forge answered ${status}`;
}

// A GitLab level indexes nothing in the GitHub table, and a fleet can declare
// one against a forge whose kind says otherwise, so the lookup answers with an
// empty list rather than undefined.
function githubScopesFor(level: Level): string[] {
  return (
    GITHUB_SCOPES_FOR_LEVEL[
      level as 'enterprise' | 'organization' | 'repository'
    ] ?? []
  );
}

const TOKEN_FIX =
  'Check that the token is valid for this forge and has not expired, then give it to grove through one of the three credential sources.';

function accessOk(label: string): CheckResult {
  return ok('the token can list the runners at this scope', {
    subject: label,
  });
}

function gitlabAccessFix(status: number, scope: Scope, label: string): string {
  // gitlabAuthHint answers for 401 and 403 only, and the spec owes a fix for
  // every failure, so the other statuses fall through to these.
  const hint = gitlabAuthHint(status, scope).trim();
  if (hint !== '') {
    return hint;
  }
  if (status === 404) {
    return `grove found no ${label} on this GitLab. Check that it exists under that exact path, and that the token's account can see it. GitLab answers 404 for a namespace the token cannot see, the same way it answers for one that is not there.`;
  }
  return `grove could not list the runners at ${label} on this GitLab. Check that the instance answers on its API and that the token's account can see the namespace.`;
}

function gitlabAccessFail(
  answer: HttpAnswer,
  scope: Scope,
  label: string,
): CheckResult {
  return fail(
    describeStatus(answer.status, answer.error),
    gitlabAccessFix(answer.status, scope, label),
    { subject: label },
  );
}

async function gitlabScopeAccess(
  input: ForgeProbeInput,
  scope: Scope,
  limit: Limiter,
): Promise<CheckResult> {
  const label = formatScopeLabel(scope);

  if (scope.level === 'instance') {
    // Only an administrator reads /runners/all, which is the same permission
    // registering an instance runner needs.
    const answer = await limit(() =>
      forgeGet(input, '/runners/all?per_page=1'),
    );
    return answer.status === 200
      ? accessOk(label)
      : gitlabAccessFail(answer, scope, label);
  }

  // Seeing a group is not the same permission as managing its runners, so the
  // namespace read is only how grove learns the numeric id, and the runners
  // list below is the proof.
  const namespace = await limit(() => readGitlabNamespace(input, scope));
  if (namespace.status !== 200) {
    return gitlabAccessFail(namespace, scope, label);
  }
  const id = (namespace.body as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'number') {
    return fail(
      `the forge answered 200 for ${label} but named no numeric id`,
      `grove lists the runners of a ${scope.level} by its numeric id, which this GitLab did not return. Check that ${label} resolves to a ${scope.level} rather than to a redirect or a proxy page.`,
      { subject: label },
    );
  }

  const answer = await limit(() => readGitlabScopeRunners(input, scope, id));
  return answer.status === 200
    ? accessOk(label)
    : gitlabAccessFail(answer, scope, label);
}

async function githubScopeAccess(
  input: ForgeProbeInput,
  scope: Scope,
  limit: Limiter,
): Promise<CheckResult> {
  const label = formatScopeLabel(scope);
  const answer = await limit(() => readGithubScopeAccess(input, scope));
  if (answer.status === 200) {
    return accessOk(label);
  }
  return fail(
    describeStatus(answer.status, answer.error),
    answer.status === 404
      ? `Check that ${label} exists and that the token's account can see it. GitHub answers 404 rather than 403 for a resource a token may not read.`
      : `The token cannot manage runners at ${label}. Add ${githubScopesFor(scope.level)[0] ?? 'the runner permission'} to it, or grant the account admin on the target.`,
    { subject: label },
  );
}

export async function runForgeChecks(
  context: ForgeCheckContext,
): Promise<CheckReport[]> {
  const target = { kind: 'forge' as const, name: context.name };
  const reports: CheckReport[] = [];
  const push = (id: string, results: CheckResult[]): void => {
    for (const result of results) {
      reports.push({ ...result, id, target });
    }
  };

  if (context.token === undefined) {
    push('forge.credential', [
      fail(
        context.tokenError ?? 'grove resolved no token for this forge',
        `${TOKEN_FIX}\n${CREDENTIAL_SOURCES_HELP}`,
      ),
    ]);
    for (const id of FORGE_CHECK_IDS.slice(1)) {
      push(id, [skip('grove has no token for this forge')]);
    }
    return reports;
  }

  push('forge.credential', [ok('grove resolved a token for this forge')]);

  const input: ForgeProbeInput = {
    name: context.name,
    forge: context.forge,
    token: context.token,
    fetchFn: context.fetchFn,
  };
  const gitlab = context.forge.kind === 'gitlab';

  const identity = gitlab
    ? await context.limit(() => readGitlabIdentity(input))
    : await context.limit(() => readGithubIdentity(input));

  if (identity.answer.status !== 200) {
    push('forge.token', [
      fail(
        describeStatus(identity.answer.status, identity.answer.error),
        identity.answer.status === 401
          ? `The forge rejected the token. It is wrong for this forge, or it has expired. ${TOKEN_FIX}`
          : `grove could not read /user on this forge. ${TOKEN_FIX}`,
      ),
    ]);
    for (const id of ['forge.scopes', 'forge.admin', 'forge.scope-access']) {
      push(id, [skip('the token did not authenticate')]);
    }
    return reports;
  }

  const who =
    'username' in identity && identity.username !== undefined
      ? identity.username
      : 'login' in identity && identity.login !== undefined
        ? identity.login
        : 'an account the forge did not name';
  push('forge.token', [ok(`authenticated as ${who}`)]);

  if (gitlab) {
    const scopes = await context.limit(() => readGitlabTokenScopes(input));
    if (scopes.scopes === undefined) {
      push('forge.scopes', [
        skip(
          `this GitLab did not answer for the token itself (${describeStatus(scopes.answer.status, scopes.answer.error)}), so grove cannot read its scopes`,
        ),
      ]);
    } else {
      const missing: string[] = [];
      if (!scopes.scopes.includes(GITLAB_CREATE_SCOPE)) {
        missing.push(GITLAB_CREATE_SCOPE);
      }
      if (!GITLAB_READ_SCOPES.some((scope) => scopes.scopes?.includes(scope))) {
        missing.push(GITLAB_READ_SCOPES.join(' or '));
      }
      push('forge.scopes', [
        missing.length === 0
          ? ok(`the token carries ${scopes.scopes.join(', ')}`)
          : fail(
              `the token carries ${scopes.scopes.join(', ')} and is missing ${missing.join(' and ')}`,
              `Mint a new personal access token with the ${GITLAB_CREATE_SCOPE} and api scopes. grove registers runners through POST /user/runners, which needs ${GITLAB_CREATE_SCOPE}, and lists them through the api scope. GitLab cannot add a scope to an existing token.`,
            ),
      ]);
    }

    const instance = context.scopes.some((scope) => scope.level === 'instance');
    push('forge.admin', [
      !instance
        ? skip('no group declares an instance level scope')
        : (identity as { isAdmin: boolean }).isAdmin
          ? ok(`${who} is an instance administrator`)
          : fail(
              `${who} is not an instance administrator`,
              'Creating an instance level runner needs a personal access token belonging to an instance administrator. Use an admin account for this forge, or move the group to a group or project level scope.',
            ),
    ]);
  } else {
    const declared = [...new Set(context.scopes.map((scope) => scope.level))];
    // `in` is what narrows the union: only a GithubIdentity declares scopes.
    const carried = 'scopes' in identity ? identity.scopes : undefined;
    if (carried === undefined) {
      push('forge.scopes', [
        skip(
          'a fine-grained token carries no scope header, so the runner read below is what proves the permission',
        ),
      ]);
    } else {
      const missing = declared
        .map((level) => ({
          level,
          wanted: githubScopesFor(level),
        }))
        .filter(
          (entry) =>
            entry.wanted.length > 0 &&
            !entry.wanted.some((scope) => carried.includes(scope)),
        );
      push('forge.scopes', [
        missing.length === 0
          ? ok(`the token carries ${carried.join(', ')}`)
          : fail(
              `the token carries ${carried.join(', ')} and is missing ${missing.map((entry) => entry.wanted[0]).join(', ')}`,
              `Add ${missing.map((entry) => `${entry.wanted[0]} for a ${entry.level} level group`).join(', and ')} to the token at https://github.com/settings/tokens, or use a fine-grained token with the runners permission on the target.`,
            ),
      ]);
    }
    push('forge.admin', [skip('GitHub has no instance administrator')]);
  }

  const access: CheckResult[] = [];
  for (const scope of context.scopes) {
    access.push(
      gitlab
        ? await gitlabScopeAccess(input, scope, context.limit)
        : await githubScopeAccess(input, scope, context.limit),
    );
  }
  push('forge.scope-access', access);

  return reports;
}
