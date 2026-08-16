import {
  CREDENTIAL_SOURCES_HELP,
  CredentialError,
  type ForgeConfig,
  resolveCredential,
} from '../config/index.js';
import { firstLine, type Transport } from '../transport/index.js';

// glab stores one token per host, so the lookup needs the host and not the
// whole url. A url the schema already validated always parses, and the
// fallback exists so a bad value shows up in the error rather than throwing.
export function glabHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function cliFailure(
  name: string,
  command: string,
  detail: string,
  fix: string,
): CredentialError {
  return new CredentialError(
    `forge "${name}": no auth block, and \`${command}\` ${detail}. ${fix}\n${CREDENTIAL_SOURCES_HELP}`,
  );
}

// `transport` must be the control node's local transport, for the same
// reason resolveCredential says so: the credential lives on this machine.
export async function resolveForgeToken(
  name: string,
  forge: ForgeConfig,
  transport: Transport,
): Promise<string> {
  const credential = await resolveCredential(name, forge, transport);
  if (credential.kind === 'token') {
    return credential.token;
  }

  if (credential.cli === 'glab') {
    // The schema makes url required on a GitLab forge, so this is never the
    // empty string in a config that loaded.
    const host = glabHost(forge.url ?? '');
    const command = `glab config get token --host ${host}`;
    const result = await transport.exec('glab', [
      'config',
      'get',
      'token',
      '--host',
      host,
    ]);
    const fix = `Run \`glab auth login --hostname ${host}\`, or give the forge an auth block.`;
    if (result.code !== 0) {
      const detail = firstLine(result.stderr);
      throw cliFailure(
        name,
        command,
        `exited ${result.code}${detail === '' ? '' : `: ${detail}`}`,
        fix,
      );
    }
    // glab exits 0 with no output when the key is unset, so the output is
    // what says whether a token exists.
    const token = result.stdout.trim();
    if (token === '') {
      throw cliFailure(name, command, 'printed nothing', fix);
    }
    return token;
  }

  const result = await transport.exec('gh', ['auth', 'token']);
  const fix = 'Run `gh auth login`, or give the forge an auth block.';
  if (result.code !== 0) {
    const detail = firstLine(result.stderr);
    throw cliFailure(
      name,
      'gh auth token',
      `exited ${result.code}${detail === '' ? '' : `: ${detail}`}`,
      fix,
    );
  }
  const token = result.stdout.trim();
  if (token === '') {
    throw cliFailure(name, 'gh auth token', 'printed nothing', fix);
  }
  return token;
}
