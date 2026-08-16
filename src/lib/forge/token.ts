import {
  CREDENTIAL_SOURCES_HELP,
  CredentialError,
  type ForgeConfig,
  resolveCredential,
} from '../config/index.js';
import { firstLine, type Transport } from '../transport/index.js';

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
    throw new CredentialError(
      `forge "${name}": glab delegation arrives with the GitLab client in milestone 3. Give this forge an auth block for now.\n${CREDENTIAL_SOURCES_HELP}`,
    );
  }

  const result = await transport.exec('gh', ['auth', 'token']);
  if (result.code !== 0) {
    const detail = firstLine(result.stderr);
    throw new CredentialError(
      `forge "${name}": no auth block, and \`gh auth token\` exited ${result.code}${detail === '' ? '' : `: ${detail}`}. Run \`gh auth login\`, or give the forge an auth block.\n${CREDENTIAL_SOURCES_HELP}`,
    );
  }
  const token = result.stdout.trim();
  if (token === '') {
    throw new CredentialError(
      `forge "${name}": \`gh auth token\` printed nothing. Run \`gh auth login\`, or give the forge an auth block.\n${CREDENTIAL_SOURCES_HELP}`,
    );
  }
  return token;
}
