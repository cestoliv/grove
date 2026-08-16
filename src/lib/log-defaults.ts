/**
 * How many lines `grove logs` prints before it catches up. It lives here, not
 * in the command, so `program.ts` can put it in the help text without pulling
 * the whole logs command into the startup path.
 */
export const DEFAULT_TAIL = 200;
