import { describe, expect, it } from 'vitest';
import { FakeTransport, TIMEOUT_EXIT_CODE } from '../transport/index.js';
import {
  ACTIVITY_TIMEOUT_MS,
  buildActivityScript,
  parseActivityOutput,
  readActivity,
} from './activity.js';

const targets = [
  {
    name: 'grove-ios-1',
    workDir: '/Volumes/ci/grove/ios-1',
    stampPath: '/Volumes/ci/grove/ios-1.stamp',
  },
  {
    name: 'grove-ios-2',
    workDir: '/Volumes/ci/grove/ios-2',
    stampPath: '/Volumes/ci/grove/ios-2.stamp',
  },
];

describe('buildActivityScript', () => {
  it('quotes every path and asks about every seat in one script', () => {
    const script = buildActivityScript(targets);
    expect(script).toContain("'grove-ios-1' '/Volumes/ci/grove/ios-1'");
    expect(script).toContain("'/Volumes/ci/grove/ios-2.stamp'");
    expect(script).toContain('-newer');
    expect(script).toContain('-print');
    // head -n 1 stops the walk at the first newer file, so a work dir with a
    // hundred thousand files costs one entry rather than a full walk. It
    // replaces `-quit`, which a find outside BSD and GNU may not have.
    expect(script).toContain('head -n 1');
    expect(script).not.toContain('-quit');
    expect(script).toContain('touch');
  });

  // A work dir that is a symlink is ordinary on a mac fleet, where the seat
  // lives on an external volume. Without -H find stats the link and walks
  // nothing.
  it('follows a work dir that is a symlink', () => {
    expect(buildActivityScript(targets)).toContain('find -H "$2" -newer "$3"');
  });

  it('carries the failure marker quoted, and compares against it', () => {
    const script = buildActivityScript(targets);
    expect(script).toContain(`printf '%s\\n' '__grove_find_failed__'`);
    expect(script).toContain(`[ "$out" = '__grove_find_failed__' ]`);
  });

  // The stamp moves only once the verdict is printed, so the window an answer
  // covers is exactly the gap between two ticks. The loop body runs for every
  // target, so asserting the order once asserts it for all of them.
  it('touches the stamp after the find, not before', () => {
    const script = buildActivityScript(targets);
    const findAt = script.indexOf('find -H');
    const verdictAt = script.indexOf('"$1" quiet', findAt);
    const touchAt = script.indexOf('touch "$3"', findAt);
    expect(findAt).toBeGreaterThan(-1);
    expect(verdictAt).toBeGreaterThan(findAt);
    expect(touchAt).toBeGreaterThan(verdictAt);
  });

  it('never lets an unwritable stamp decide the host verdict', () => {
    // The trailing touch is the last statement the loop body runs, so its
    // status can become the script's. An unwritable stamp would then mark
    // every seat on the host unknown, with nothing in the log saying why.
    const script = buildActivityScript(targets);
    expect(script).toContain('touch "$3" 2>/dev/null || true');
  });

  it('quotes a path that carries a quote', () => {
    const script = buildActivityScript([
      {
        name: "od'd",
        workDir: "/ci/it's here",
        stampPath: '/ci/stamp',
      },
    ]);
    expect(script).toContain("'od'\\''d' '/ci/it'\\''s here' '/ci/stamp'");
  });
});

describe('parseActivityOutput', () => {
  it('reads one tab-separated verdict per seat', () => {
    const parsed = parseActivityOutput(
      'grove-ios-1\tquiet\ngrove-ios-2\tactive\n',
    );
    expect(parsed.get('grove-ios-1')).toBe('quiet');
    expect(parsed.get('grove-ios-2')).toBe('active');
  });

  it('ignores a line it does not understand', () => {
    const parsed = parseActivityOutput('noise\ngrove-ios-1\tsideways\n');
    expect(parsed.size).toBe(0);
  });

  // A name holding a tab would split into three, and grove has no way to tell
  // which piece is the seat, so the line goes in the bin.
  it('ignores a line carrying more than two fields', () => {
    const parsed = parseActivityOutput('grove\tios-1\tquiet\n');
    expect(parsed.size).toBe(0);
  });
});

describe('readActivity', () => {
  it('asks nothing when there is nothing to ask about', async () => {
    const transport = new FakeTransport('mac');
    expect(await readActivity(transport, [])).toEqual(new Map());
    expect(transport.calls).toEqual([]);
  });

  it('reads the verdicts the host printed', async () => {
    const transport = new FakeTransport('mac').on('sh -c', {
      stdout: 'grove-ios-1\tquiet\ngrove-ios-2\tno-stamp\n',
    });
    const seen = await readActivity(transport, targets);
    expect(seen.get('grove-ios-1')).toBe('quiet');
    expect(seen.get('grove-ios-2')).toBe('no-stamp');
  });

  // A failed probe must never read as a quiet work dir, because quiet is half
  // of the reason grove kills a running job.
  it('calls every seat unknown when the exec fails', async () => {
    const transport = new FakeTransport('mac').fail('sh -c', 'no shell');
    const seen = await readActivity(transport, targets);
    expect([...seen.values()]).toEqual(['error', 'error']);
  });

  it('calls every seat unknown when the transport throws', async () => {
    const transport = new FakeTransport('mac').throwOn('sh -c', 'ssh died');
    const seen = await readActivity(transport, targets);
    expect([...seen.values()]).toEqual(['error', 'error']);
  });

  // A work dir on a mount that stopped answering would otherwise hold the
  // whole tick open, and every later host would wait behind it.
  it('gives the probe a deadline', async () => {
    const transport = new FakeTransport('mac').on('sh -c', { stdout: '' });
    await readActivity(transport, targets);
    expect(transport.calls[0]?.options?.timeoutMs).toBe(ACTIVITY_TIMEOUT_MS);
  });

  it('calls every seat unknown when the probe times out', async () => {
    const transport = new FakeTransport('mac').on('sh -c', {
      code: TIMEOUT_EXIT_CODE,
      stdout: 'grove-ios-1\tquiet\n',
      stderr: 'timed out',
    });
    const seen = await readActivity(transport, targets);
    // The partial stdout a killed probe left behind is not an answer, so even
    // the seat it named stays unknown.
    expect([...seen.values()]).toEqual(['error', 'error']);
  });

  it('calls a seat the host never mentioned unknown', async () => {
    const transport = new FakeTransport('mac').on('sh -c', {
      stdout: 'grove-ios-1\tactive\n',
    });
    const seen = await readActivity(transport, targets);
    expect(seen.get('grove-ios-2')).toBe('error');
  });
});
