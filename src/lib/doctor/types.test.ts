import { describe, expect, it } from 'vitest';
import {
  type CheckResult,
  countStatuses,
  fail,
  ok,
  skip,
  warn,
  worstStatus,
} from './types.js';

describe('result helpers', () => {
  it('builds an ok with no fix, because there is nothing to fix', () => {
    expect(ok('Docker 27.1.1 answered')).toEqual({
      status: 'ok',
      summary: 'Docker 27.1.1 answered',
    });
  });

  it('carries a subject and a detail when the caller gives them', () => {
    expect(
      ok('4.2 TB free', { subject: '/Volumes/ci/grove', detail: '12% used' }),
    ).toEqual({
      status: 'ok',
      summary: '4.2 TB free',
      subject: '/Volumes/ci/grove',
      detail: '12% used',
    });
  });

  it('makes the fix part of a warn and a fail', () => {
    expect(warn('8% free', 'Free space on /Volumes/ci.')).toEqual({
      status: 'warn',
      summary: '8% free',
      fix: 'Free space on /Volumes/ci.',
    });
    expect(fail('the daemon did not answer', 'Start Docker.')).toEqual({
      status: 'fail',
      summary: 'the daemon did not answer',
      fix: 'Start Docker.',
    });
  });

  it('builds a skip that says why it was not asked', () => {
    expect(skip('no Docker group is placed on this host')).toEqual({
      status: 'skip',
      summary: 'no Docker group is placed on this host',
    });
  });
});

describe('worstStatus', () => {
  it('ranks fail over warn over ok over skip', () => {
    expect(worstStatus(['ok', 'warn', 'fail', 'skip'])).toBe('fail');
    expect(worstStatus(['ok', 'warn', 'skip'])).toBe('warn');
    expect(worstStatus(['skip', 'ok'])).toBe('ok');
    expect(worstStatus(['skip'])).toBe('skip');
  });

  it('calls nothing at all a skip', () => {
    expect(worstStatus([])).toBe('skip');
  });
});

describe('countStatuses', () => {
  it('counts every status, including the ones that did not occur', () => {
    const results: CheckResult[] = [
      ok('a'),
      ok('b'),
      warn('c', 'fix c'),
      skip('d'),
    ];
    expect(countStatuses(results)).toEqual({
      ok: 2,
      warn: 1,
      fail: 0,
      skip: 1,
    });
  });
});
