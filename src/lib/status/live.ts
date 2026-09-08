// Braille frames, the same set ora uses. Ten frames at 80ms reads as motion
// without drawing the eye away from the table underneath.
export const SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
];
export const SPINNER_INTERVAL_MS = 80;
export const DEFAULT_COLUMNS = 80;

// The printed width of a coloured line is what the row arithmetic needs, and a
// colour code starts with ESC by definition.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const ANSI_COLOR = /\u001B\[[0-9;]*m/g;

/**
 * How many terminal rows a block of text takes once the terminal wraps it. A
 * line exactly as wide as the terminal still takes one row, because the wrap
 * stays pending until the next character, so the arithmetic subtracts one
 * before it divides.
 */
export function frameRows(text: string, columns: number): number {
  return text.split('\n').reduce((rows, line) => {
    const width = line.replace(ANSI_COLOR, '').length;
    return rows + (width === 0 ? 1 : Math.floor((width - 1) / columns) + 1);
  }, 0);
}

export interface LiveScreenOptions {
  write: (text: string) => void;
  // Called for every frame, with the spinner glyph of the moment.
  render: (spinner: string) => string;
  columns?: number;
  // The height of the window. A frame taller than this cannot be redrawn,
  // because the terminal has scrolled its first rows away and no cursor move
  // brings them back. Left unset, every frame is drawn.
  rows?: number;
  intervalMs?: number;
}

export interface LiveScreen {
  // Draw now, because something arrived.
  refresh: () => void;
  // Draw one last time and stop the clock.
  stop: () => void;
}

/**
 * Redraws one block of text in place. The block is the whole report, so a
 * section that resolves late simply changes what the next frame says, and a
 * table that grows a column repaints at its new width instead of tearing.
 */
export function startLiveScreen(options: LiveScreenOptions): LiveScreen {
  const columns = Math.max(options.columns ?? DEFAULT_COLUMNS, 1);
  let drawn = 0;
  let tick = 0;

  const paint = (last = false): void => {
    const text = options.render(SPINNER_FRAMES[tick % SPINNER_FRAMES.length]);
    const rows = frameRows(text, columns);
    // A frame this tall scrolls its own first rows off the window, so the next
    // rewind would land inside it and tear. Holding the last frame that fitted
    // is the honest answer, and the final frame still prints whole because
    // nothing ever redraws over it.
    if (!last && options.rows !== undefined && rows > options.rows) {
      return;
    }
    // Climb back over the previous frame, then erase from there to the end of
    // the screen, so a frame shorter than the last leaves no tail behind.
    const rewind = drawn === 0 ? '' : `\u001B[${drawn}A\u001B[0J`;
    options.write(`${rewind}${text}\n`);
    drawn = rows;
  };

  const timer = setInterval(() => {
    tick += 1;
    paint();
  }, options.intervalMs ?? SPINNER_INTERVAL_MS);
  // Nothing should be kept alive by a spinner.
  timer.unref?.();
  paint();

  return {
    refresh: () => paint(),
    stop: () => {
      clearInterval(timer);
      paint(true);
    },
  };
}
