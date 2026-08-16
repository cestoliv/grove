import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { errorMessage } from '../errors.js';
import { detectLiteralTokens } from './credentials.js';
import { ConfigError, type ConfigIssue, issuesFromZod } from './errors.js';
import { interpolateEnv } from './interpolate.js';
import { resolveConfigPath } from './paths.js';
import { validateReferences } from './references.js';
import { configSchema, DEFAULT_TICK, type GroveConfig } from './schema.js';
import { type ConfigWarning, privilegedSocketWarnings } from './warnings.js';

export interface LoadedConfig {
  path: string;
  config: GroveConfig;
  warnings: ConfigWarning[];
}

export interface LoadConfigOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function fail(issues: ConfigIssue[], configPath: string): never {
  throw new ConfigError(issues, configPath);
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const configPath = resolveConfigPath({
    explicit: options.path,
    env,
    cwd: options.cwd,
  });

  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? `no config file at ${configPath}. Create grove.yaml, or point --config or GROVE_CONFIG at one.`
        : `cannot read ${configPath}: ${errorMessage(error)}`;
    return fail([{ path: '<file>', message }], configPath);
  }

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    return fail([{ path: '<yaml>', message: errorMessage(error) }], configPath);
  }

  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  ) {
    return fail(
      [
        {
          path: '<root>',
          message:
            'the config must be a YAML mapping with hosts, forges and groups',
        },
      ],
      configPath,
    );
  }

  const literals = detectLiteralTokens(document);
  if (literals.length > 0) {
    return fail(literals, configPath);
  }

  // groups[].raw is the escape hatch the spec says grove merges but never
  // interprets, so ${...} inside it must survive verbatim (for example a
  // GitLab CI runtime variable meant for the runner, not for grove).
  const isGroupRawBlock = (path: PropertyKey[]): boolean =>
    path.length === 3 &&
    path[0] === 'groups' &&
    typeof path[1] === 'number' &&
    path[2] === 'raw';

  const interpolated = interpolateEnv(document, env, { skip: isGroupRawBlock });
  if (interpolated.issues.length > 0) {
    return fail(interpolated.issues, configPath);
  }

  const parsed = configSchema.safeParse(interpolated.value);
  if (!parsed.success) {
    return fail(issuesFromZod(parsed.error), configPath);
  }

  const config: GroveConfig = {
    ...parsed.data,
    tick: {
      fast: parsed.data.tick?.fast ?? DEFAULT_TICK.fast,
      full: parsed.data.tick?.full ?? DEFAULT_TICK.full,
    },
  };

  const references = validateReferences(config);
  if (references.length > 0) {
    return fail(references, configPath);
  }

  return {
    path: configPath,
    config,
    warnings: privilegedSocketWarnings(config),
  };
}
