import { describe, expect, it } from 'vitest';
import { buildUsageScript, parseUsage } from '../stack/index.js';
import { FakeTransport } from '../transport/index.js';
import {
  buildEntriesScript,
  buildRemoveArgs,
  parseEntries,
  pruneWorkDirs,
  selectForRemoval,
} from './prune.js';

const GB = 1024 ** 3;

describe('buildUsageScript and parseUsage', () => {
  it('measures every work dir on a host in one script', () => {
    const script = buildUsageScript([
      { name: 'grove-ios-1', workDir: '/Volumes/ci/grove/ios-1' },
    ]);
    expect(script).toContain("'grove-ios-1' '/Volumes/ci/grove/ios-1'");
    expect(script).toContain('du -sk');
  });

  it('measures through a work dir that is a symlink', () => {
    // `du -s` on a symlink operand measures the link, not the tree behind it,
    // and a mac seat on an external volume is usually a symlink. The trailing
    // `/.` names the directory itself, so the total is the real one. The name
    // in the output comes from `$1`, so the `/.` never reaches grove.
    const script = buildUsageScript([
      { name: 'grove-ios-1', workDir: '/Volumes/ci/grove/ios-1' },
    ]);
    expect(script).toContain('du -sk -- "$2/."');
  });

  it('reads kilobytes and answers in bytes', () => {
    const used = parseUsage('grove-ios-1\t2048\ngrove-ios-2\t0\n');
    expect(used.get('grove-ios-1')).toBe(2048 * 1024);
    expect(used.get('grove-ios-2')).toBe(0);
    expect(used.get('grove-ios-3')).toBeUndefined();
  });

  it('ignores a line whose size is not a number', () => {
    expect(parseUsage('grove-ios-1\tdu: cannot read\n').size).toBe(0);
  });
});

describe('buildEntriesScript and parseEntries', () => {
  it('lists the top level oldest first with a size each', () => {
    const script = buildEntriesScript('/Volumes/ci/grove/ios-1');
    expect(script).toContain("cd '/Volumes/ci/grove/ios-1'");
    // -t sorts by mtime and -r reverses it, so the oldest entry is first.
    expect(script).toContain('ls -1tr');
  });

  it('never offers a dotted entry for removal', () => {
    expect(parseEntries('1024\t.cache\n2048\t_work\n')).toEqual([
      { name: '_work', bytes: 2048 * 1024 },
    ]);
  });

  it('keeps the order the host printed', () => {
    expect(parseEntries('1024\t_work\n2048\t_temp\n')).toEqual([
      { name: '_work', bytes: 1024 * 1024 },
      { name: '_temp', bytes: 2048 * 1024 },
    ]);
  });
});

describe('selectForRemoval', () => {
  it('takes the oldest entries until the directory fits', () => {
    const entries = [
      { name: 'a', bytes: 3 * GB },
      { name: 'b', bytes: 3 * GB },
      { name: 'c', bytes: 3 * GB },
    ];
    expect(
      selectForRemoval(entries, 9 * GB, 5 * GB).map((entry) => entry.name),
    ).toEqual(['a', 'b']);
  });

  it('takes nothing when the directory is already under the limit', () => {
    expect(selectForRemoval([{ name: 'a', bytes: GB }], GB, 2 * GB)).toEqual(
      [],
    );
  });

  it('takes everything rather than leave a directory over its own limit', () => {
    const entries = [{ name: 'a', bytes: 4 * GB }];
    expect(selectForRemoval(entries, 4 * GB, GB).map((e) => e.name)).toEqual([
      'a',
    ]);
  });
});

describe('buildRemoveArgs', () => {
  it('removes direct children of the work dir and nothing else', () => {
    expect(
      buildRemoveArgs('/Volumes/ci/grove/ios-1', ['_work', '_temp']),
    ).toEqual([
      '-rf',
      '--',
      '/Volumes/ci/grove/ios-1/_work',
      '/Volumes/ci/grove/ios-1/_temp',
    ]);
  });

  it('refuses an entry that could climb out of the work dir', () => {
    for (const bad of ['..', '.', '', 'a/b', '/etc', '.git', '.hidden']) {
      expect(() => buildRemoveArgs('/Volumes/ci/grove/ios-1', [bad])).toThrow();
    }
  });

  it('refuses a work dir that is not a seat directory', () => {
    expect(() => buildRemoveArgs('/', ['a'])).toThrow();
    expect(() => buildRemoveArgs('relative/ios-1', ['a'])).toThrow();
    expect(() => buildRemoveArgs('/Volumes/ci', ['a'])).toThrow();
    expect(() =>
      buildRemoveArgs('/Volumes/ci/../grove/ios-1', ['a']),
    ).toThrow();
  });
});

describe('pruneWorkDirs', () => {
  const seat = {
    name: 'grove-ios-1',
    workDir: '/Volumes/ci/grove/ios-1',
    limitBytes: 5 * GB,
    busy: false,
  };

  function host(): FakeTransport {
    return new FakeTransport('mac')
      .on('sh -c set --', { stdout: 'grove-ios-1\t8388608\n' })
      .on('sh -c cd', { stdout: '4194304\told\n4194304\tnew\n' });
  }

  it('measures, deletes the oldest, and reports what it freed', async () => {
    const transport = host();
    const { measured, results } = await pruneWorkDirs(transport, [seat]);

    expect(measured).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].usedBytes).toBe(8 * GB);
    expect(results[0].removed).toEqual(['old']);
    expect(results[0].freedBytes).toBe(4 * GB);
    expect(results[0].error).toBeUndefined();
    expect(transport.commandLines()).toContain(
      'rm -rf -- /Volumes/ci/grove/ios-1/old',
    );
  });

  it('leaves a dotted entry out of the removal even if the host lists one', async () => {
    const transport = new FakeTransport('mac')
      .on('sh -c set --', { stdout: 'grove-ios-1\t8388608\n' })
      .on('sh -c cd', {
        stdout: '4194304\t.cache\n4194304\told\n4194304\tnew\n',
      });
    const { results } = await pruneWorkDirs(transport, [seat]);

    expect(results[0].removed).toEqual(['old']);
    expect(
      transport.commandLines().some((line) => line.includes('.cache')),
    ).toBe(false);
  });

  it('leaves a seat that fits alone and never lists its entries', async () => {
    const transport = new FakeTransport('mac').on('sh -c set --', {
      stdout: 'grove-ios-1\t1024\n',
    });
    const { measured, results } = await pruneWorkDirs(transport, [seat]);

    expect(measured).toBe(true);
    expect(results).toEqual([]);
    // The measurement, and nothing after it.
    expect(transport.calls).toHaveLength(1);
  });

  it('reports rather than throws when the host cannot be measured', async () => {
    const transport = new FakeTransport('mac').fail('sh -c set --', 'no du');
    const { measured, results } = await pruneWorkDirs(transport, [seat]);

    expect(measured).toBe(false);
    expect(results).toEqual([]);
  });

  it('reports rather than throws when the measurement itself throws', async () => {
    const transport = new FakeTransport('mac').throwOn(
      'sh -c set --',
      'connection closed',
    );
    const { measured, results } = await pruneWorkDirs(transport, [seat]);

    expect(measured).toBe(false);
    expect(results).toEqual([]);
  });

  it('reports a work dir it cannot list', async () => {
    const transport = new FakeTransport('mac')
      .on('sh -c set --', { stdout: 'grove-ios-1\t8388608\n' })
      .fail('sh -c cd', 'no such directory');
    const { measured, results } = await pruneWorkDirs(transport, [seat]);

    expect(measured).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].error).toBe('the work dir could not be listed');
    expect(results[0].removed).toEqual([]);
    expect(
      transport.commandLines().some((line) => line.includes('rm -rf')),
    ).toBe(false);
  });

  it('reports a removal the host refused', async () => {
    const transport = host().fail('rm -rf', 'permission denied', 1);
    const { results } = await pruneWorkDirs(transport, [seat]);

    expect(results).toHaveLength(1);
    expect(results[0].error).toBe('rm exited 1');
    expect(results[0].removed).toEqual([]);
    expect(results[0].freedBytes).toBe(0);
  });

  it('reports a work dir that does not belong to its seat and measures nothing', async () => {
    const transport = host();
    const { measured, results } = await pruneWorkDirs(transport, [
      { ...seat, workDir: '/Volumes/ci/grove/other-2' },
    ]);

    expect(measured).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].error).toContain('/Volumes/ci/grove/other-2');
    expect(results[0].removed).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  it('never touches a seat the caller marked busy', async () => {
    const transport = host();
    const { results } = await pruneWorkDirs(transport, [
      { ...seat, busy: true },
    ]);

    expect(results).toEqual([]);
    expect(transport.calls).toEqual([]);
  });
});
