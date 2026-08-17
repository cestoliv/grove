import { describe, expect, it } from 'vitest';
import {
  escapeLabelValue,
  type MetricFamily,
  mergeExposition,
  relabelExposition,
  renderExposition,
  renderFamily,
  renderLabels,
  renderSample,
} from './format.js';

describe('escapeLabelValue', () => {
  it('escapes the three characters the format reserves', () => {
    expect(escapeLabelValue('a"b')).toBe('a\\"b');
    expect(escapeLabelValue('a\\b')).toBe('a\\\\b');
    expect(escapeLabelValue('a\nb')).toBe('a\\nb');
  });

  it('leaves an ordinary value alone', () => {
    expect(escapeLabelValue('grove-arm-1')).toBe('grove-arm-1');
  });
});

describe('renderLabels', () => {
  it('renders nothing for no labels', () => {
    expect(renderLabels()).toBe('');
    expect(renderLabels({})).toBe('');
  });

  it('renders labels in the order they were given', () => {
    expect(renderLabels({ group: 'arm', host: 'mac' })).toBe(
      '{group="arm",host="mac"}',
    );
  });
});

describe('renderSample and renderFamily', () => {
  it('renders one sample line', () => {
    expect(renderSample('grove_up', { value: 1 })).toBe('grove_up 1');
    expect(
      renderSample('grove_runners', { labels: { group: 'arm' }, value: 2 }),
    ).toBe('grove_runners{group="arm"} 2');
  });

  it('renders a family with its help and type', () => {
    const family: MetricFamily = {
      name: 'grove_up',
      type: 'gauge',
      help: 'Whether grove is running.',
      samples: [{ value: 1 }],
    };
    expect(renderFamily(family)).toBe(
      [
        '# HELP grove_up Whether grove is running.',
        '# TYPE grove_up gauge',
        'grove_up 1',
      ].join('\n'),
    );
  });

  it('drops a family with no sample, because an empty family says nothing', () => {
    expect(
      renderExposition([
        { name: 'grove_x', type: 'gauge', help: 'x', samples: [] },
      ]),
    ).toBe('');
  });

  it('ends the whole exposition with a newline', () => {
    const text = renderExposition([
      { name: 'grove_up', type: 'gauge', help: 'up', samples: [{ value: 1 }] },
    ]);
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('relabelExposition', () => {
  it('adds labels to a sample that has none', () => {
    expect(
      relabelExposition('gitlab_runner_version_info 1\n', {
        runner: 'grove-dind-1',
      }),
    ).toBe('gitlab_runner_version_info{runner="grove-dind-1"} 1\n');
  });

  it('adds labels to a sample that already has some, keeping the originals', () => {
    expect(
      relabelExposition('go_gc_duration_seconds{quantile="0.5"} 0.0001\n', {
        runner: 'grove-dind-1',
      }),
    ).toBe(
      'go_gc_duration_seconds{runner="grove-dind-1",quantile="0.5"} 0.0001\n',
    );
  });

  it('handles an empty label set without leaving a stray comma', () => {
    expect(relabelExposition('metric{} 3\n', { runner: 'a' })).toBe(
      'metric{runner="a"} 3\n',
    );
  });

  it('leaves comments and blank lines alone', () => {
    const text = ['# HELP x help', '# TYPE x counter', '', 'x 1'].join('\n');
    expect(relabelExposition(text, { runner: 'a' })).toBe(
      ['# HELP x help', '# TYPE x counter', '', 'x{runner="a"} 1'].join('\n'),
    );
  });

  it('keeps a trailing timestamp on the sample', () => {
    expect(relabelExposition('x 1 1700000000000\n', { runner: 'a' })).toBe(
      'x{runner="a"} 1 1700000000000\n',
    );
  });

  it('leaves a line it does not recognise alone', () => {
    expect(
      relabelExposition('not a metric line at all\n', { runner: 'a' }),
    ).toBe('not a metric line at all\n');
  });

  it('escapes the label value it adds', () => {
    expect(relabelExposition('x 1\n', { host: 'a"b' })).toBe(
      'x{host="a\\"b"} 1\n',
    );
  });

  it('handles a } inside a quoted label value without truncating the label set', () => {
    expect(relabelExposition('x{label="a}b"} 1\n', { runner: 'a' })).toBe(
      'x{runner="a",label="a}b"} 1\n',
    );
  });

  it('handles an escaped quote inside a label value without truncating the label set', () => {
    expect(relabelExposition('x{l="a\\"b"} 1\n', { runner: 'a' })).toBe(
      'x{runner="a",l="a\\"b"} 1\n',
    );
  });

  it('keeps a label the line already carries and adds the namespaced one beside it', () => {
    expect(
      relabelExposition(
        'gitlab_runner_jobs{runner="fa6cab46",state="running"} 1\n',
        { grove_runner: 'grove-dind-1', host: 'mac' },
      ),
    ).toBe(
      'gitlab_runner_jobs{grove_runner="grove-dind-1",host="mac",runner="fa6cab46",state="running"} 1\n',
    );
  });

  it('never injects a label name the line already has', () => {
    expect(
      relabelExposition('x{host="x"} 1\n', {
        grove_runner: 'grove-dind-1',
        host: 'mac',
      }),
    ).toBe('x{grove_runner="grove-dind-1",host="x"} 1\n');
  });
});

describe('mergeExposition', () => {
  it('keeps each help and type once and every sample', () => {
    const first = [
      '# HELP jobs Jobs.',
      '# TYPE jobs counter',
      'jobs{runner="a"} 1',
      '',
    ].join('\n');
    const second = [
      '# HELP jobs Jobs.',
      '# TYPE jobs counter',
      'jobs{runner="b"} 2',
      '',
    ].join('\n');

    expect(mergeExposition([first, second])).toBe(
      [
        '# HELP jobs Jobs.',
        '# TYPE jobs counter',
        'jobs{runner="a"} 1',
        'jobs{runner="b"} 2',
        '',
      ].join('\n'),
    );
  });

  it('keeps the families of different metrics side by side', () => {
    const merged = mergeExposition([
      '# TYPE a gauge\na 1\n',
      '# TYPE b gauge\nb 2\n',
    ]);
    expect(merged).toContain('# TYPE a gauge');
    expect(merged).toContain('# TYPE b gauge');
  });

  it('merges nothing into nothing', () => {
    expect(mergeExposition([])).toBe('');
    expect(mergeExposition(['', '  '])).toBe('');
  });
});
