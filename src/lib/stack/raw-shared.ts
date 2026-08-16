// Shape checks both stack readers run over a `raw:` block. They live here so
// the two readers cannot drift apart, and so their messages keep the
// `raw.<key>` prefix that `rawStackWarnings` parses the offending key out of.

export function stringList(key: string, value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`raw.${key} must be a list of strings`);
  }
  return value as string[];
}

export function envMap(key: string, value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`raw.${key} must be a mapping of names to values`);
  }
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw new Error(`raw.${key}.${name} must be a string, number or boolean`);
    }
    env[name] = String(entry);
  }
  return env;
}
