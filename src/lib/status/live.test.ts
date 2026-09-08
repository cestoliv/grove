import { describe, expect, it } from 'vitest';
import { frameRows, SPINNER_FRAMES, startLiveScreen } from './live.js';

describe('frameRows', () => {
  it('counts one row per line that fits', () => {
    expect(frameRows('one\ntwo\nthree', 80)).toBe(3);
  });

  it('counts an empty line as a row', () => {
    expect(frameRows('one\n\ntwo', 80)).toBe(3);
  });

  it('counts a line exactly as wide as the terminal as one row', () => {
    expect(frameRows('x'.repeat(20), 20)).toBe(1);
    expect(frameRows('x'.repeat(21), 20)).toBe(2);
    expect(frameRows('x'.repeat(41), 20)).toBe(3);
  });

  it('ignores colour codes, which take no width on screen', () => {
    expect(frameRows(`\u001B[32m${'x'.repeat(20)}\u001B[39m`, 20)).toBe(1);
  });
});

describe('startLiveScreen', () => {
  function screen(render: (spinner: string) => string) {
    const written: string[] = [];
    const live = startLiveScreen({
      write: (text) => written.push(text),
      render,
      columns: 20,
      // Long enough that no frame is drawn unless this test asks for one.
      intervalMs: 1_000_000,
    });
    return { live, written };
  }

  it('draws the first frame with no cursor movement', () => {
    const { live, written } = screen(() => 'one\ntwo');
    live.stop();
    expect(written[0]).toBe('one\ntwo\n');
  });

  it('rewinds over exactly the rows the last frame took', () => {
    let text = 'one\ntwo\nthree';
    const { live, written } = screen(() => text);
    text = 'only one line';
    live.refresh();

    expect(written[1]).toBe('\u001B[3A\u001B[0Jonly one line\n');
  });

  it('counts wrapped rows when it rewinds', () => {
    let text = 'x'.repeat(45);
    const { live, written } = screen(() => text);
    text = 'short';
    live.refresh();

    // 45 characters over 20 columns is three rows, not one.
    expect(written[1]).toBe('\u001B[3A\u001B[0Jshort\n');
  });

  it('holds the last frame that fitted when one grows past the window', () => {
    let text = 'one\ntwo';
    const written: string[] = [];
    const live = startLiveScreen({
      write: (chunk) => written.push(chunk),
      render: () => text,
      columns: 20,
      rows: 4,
      intervalMs: 1_000_000,
    });

    text = 'one\ntwo\nthree\nfour\nfive';
    live.refresh();
    expect(written).toHaveLength(1);

    // The final frame prints whole, because nothing redraws over it.
    live.stop();
    expect(written[1]).toBe('\u001B[2A\u001B[0Jone\ntwo\nthree\nfour\nfive\n');
  });

  it('advances the spinner on its own clock, not on a refresh', () => {
    const seen: string[] = [];
    const { live } = screen((spinner) => {
      seen.push(spinner);
      return 'frame';
    });
    live.refresh();
    live.stop();
    expect(seen).toEqual([
      SPINNER_FRAMES[0],
      SPINNER_FRAMES[0],
      SPINNER_FRAMES[0],
    ]);
  });
});
