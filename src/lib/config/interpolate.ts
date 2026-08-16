import { type ConfigIssue, issuePath } from './errors.js';

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface InterpolationResult<T> {
  value: T;
  issues: ConfigIssue[];
}

export interface InterpolateEnvOptions {
  // Paths for which walk() should skip expansion and return the node
  // unchanged, so an escape hatch like `groups[].raw` can carry `${...}`
  // verbatim instead of grove eating it.
  skip?: (path: PropertyKey[]) => boolean;
}

export function interpolateEnv<T>(
  input: T,
  env: NodeJS.ProcessEnv,
  options: InterpolateEnvOptions = {},
): InterpolationResult<T> {
  const issues: ConfigIssue[] = [];
  const shouldSkip = options.skip ?? (() => false);

  const expand = (value: string, path: PropertyKey[]): string =>
    value.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
      const resolved = env[name];
      if (resolved === undefined || resolved === '') {
        issues.push({
          path: issuePath(path),
          message: `environment variable ${name} is not set. Export it, or use a command: source instead.`,
        });
        return match;
      }
      return resolved;
    });

  const walk = (node: unknown, path: PropertyKey[]): unknown => {
    if (shouldSkip(path)) {
      return node;
    }
    if (typeof node === 'string') {
      return expand(node, path);
    }
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, [...path, index]));
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        out[key] = walk(value, [...path, key]);
      }
      return out;
    }
    return node;
  };

  return { value: walk(input, []) as T, issues };
}
