export type MetricType = 'gauge' | 'counter';

export interface MetricSample {
  labels?: Record<string, string>;
  value: number;
}

export interface MetricFamily {
  name: string;
  type: MetricType;
  help: string;
  samples: MetricSample[];
}

// The three characters the exposition format reserves inside a label value.
export function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

export function renderLabels(labels?: Record<string, string>): string {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) {
    return '';
  }
  return `{${entries
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(',')}}`;
}

export function renderSample(name: string, sample: MetricSample): string {
  return `${name}${renderLabels(sample.labels)} ${sample.value}`;
}

export function renderFamily(family: MetricFamily): string {
  return [
    `# HELP ${family.name} ${family.help}`,
    `# TYPE ${family.name} ${family.type}`,
    ...family.samples.map((sample) => renderSample(family.name, sample)),
  ].join('\n');
}

export function renderExposition(families: MetricFamily[]): string {
  // A family with no sample is a HELP and a TYPE and nothing else, which
  // tells a reader that grove has a metric and no data. Dropping it is the
  // honest answer.
  const rendered = families
    .filter((family) => family.samples.length > 0)
    .map(renderFamily);
  return rendered.length === 0 ? '' : `${rendered.join('\n')}\n`;
}

// A metric name, then an optional label set, then a Prometheus number value
// and an optional trailing timestamp. Anchored and requiring a real number,
// so a line of prose in someone's /metrics output is left alone rather than
// mangled. The label-set group is quote-aware: `}` is not one of the three
// characters the format reserves inside a label value, so it can appear
// there unescaped, and a naive `[^}]*` would stop at that inner `}` and
// leave the rest of the line ("not a sample") alone instead of relabeling it.
const SAMPLE_LINE =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(?:[^"}]|"(?:[^"\\]|\\.)*")*\})?(\s+[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|NaN|[+-]?Inf)(?:\s+-?\d+)?\s*)$/;

// One `name="value"` pair. The value group is quote-aware, so a `,` or an `=`
// inside a label value is consumed with the value it belongs to rather than
// read as the start of the next pair.
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"(?:[^"\\]|\\.)*"/g;

function labelNames(inner: string): Set<string> {
  const names = new Set<string>();
  for (const match of inner.matchAll(LABEL_PAIR)) {
    names.add(match[1]);
  }
  return names;
}

function renderInjected(
  labels: Record<string, string>,
  skip: ReadonlySet<string>,
): string {
  return Object.entries(labels)
    .filter(([name]) => !skip.has(name))
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(',');
}

/**
 * Add labels to every sample line in one exposition, leaving its comments and
 * its values untouched. This is what makes N seats' `gitlab-runner` metrics
 * mergeable: without it every seat exposes the same series and Prometheus
 * rejects the whole scrape.
 *
 * An injected name the line already carries is dropped rather than repeated.
 * A duplicate label name is a parse error that costs the whole scrape, so a
 * collision has to degrade to "not injected".
 */
export function relabelExposition(
  text: string,
  labels: Record<string, string>,
): string {
  const all = renderInjected(labels, new Set());
  if (all === '') {
    return text;
  }
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('#') || line.trim() === '') {
        return line;
      }
      const match = SAMPLE_LINE.exec(line);
      if (match === null) {
        return line;
      }
      const [, name, existing, rest] = match;
      if (existing === undefined) {
        return `${name}{${all}}${rest}`;
      }
      const inner = existing.slice(1, -1).trim();
      if (inner === '') {
        return `${name}{${all}}${rest}`;
      }
      const added = renderInjected(labels, labelNames(inner));
      return `${name}{${added === '' ? inner : `${added},${inner}`}}${rest}`;
    })
    .join('\n');
}

const META_LINE = /^#\s+(HELP|TYPE)\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s/;

/**
 * Concatenate expositions, keeping each metric's HELP and TYPE once. Two
 * seats of one group expose the same families, and a repeated TYPE line for
 * one metric is a parse error rather than a duplicate.
 */
export function mergeExposition(blocks: string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      const meta = META_LINE.exec(line);
      if (meta !== null) {
        const key = `${meta[1]}:${meta[2]}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      lines.push(line);
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
