import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { confirm } from './prompt.js';

function input(text: string): Readable {
  return Readable.from([text]);
}

describe('confirm', () => {
  it('accepts y and yes in any case', async () => {
    for (const answer of ['y\n', 'Y\n', 'yes\n', 'YES\n']) {
      await expect(
        confirm({
          question: 'Apply?',
          input: input(answer),
          isTty: true,
          write: () => undefined,
        }),
      ).resolves.toBe(true);
    }
  });

  it('refuses anything else', async () => {
    for (const answer of ['n\n', '\n', 'nope\n']) {
      await expect(
        confirm({
          question: 'Apply?',
          input: input(answer),
          isTty: true,
          write: () => undefined,
        }),
      ).resolves.toBe(false);
    }
  });

  it('asks the question before reading', async () => {
    const written: string[] = [];
    await confirm({
      question: 'Apply 3 destructive changes? [y/N]',
      input: input('y\n'),
      isTty: true,
      write: (text) => written.push(text),
    });
    expect(written).toEqual(['Apply 3 destructive changes? [y/N]']);
  });

  it('returns true without reading when assumeYes is set', async () => {
    const written: string[] = [];
    await expect(
      confirm({
        question: 'Apply?',
        assumeYes: true,
        isTty: false,
        write: (text) => written.push(text),
      }),
    ).resolves.toBe(true);
    expect(written).toEqual([]);
  });

  it('refuses and explains on stderr when stdin is not a terminal', async () => {
    const written: string[] = [];
    const warned: string[] = [];
    await expect(
      confirm({
        question: 'Apply?',
        input: input('y\n'),
        isTty: false,
        write: (text) => written.push(text),
        warn: (text) => warned.push(text),
      }),
    ).resolves.toBe(false);
    expect(warned.join(' ')).toContain('--yes');
    expect(written).toEqual([]);
  });
});
