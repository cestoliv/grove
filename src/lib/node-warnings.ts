export interface WarningEmitter {
  listeners(event: 'warning'): Array<(warning: Error) => void>;
  removeAllListeners(event: 'warning'): unknown;
  on(event: 'warning', listener: (warning: Error) => void): unknown;
}

// node:sqlite is unflagged from Node 22.13 but still announces itself once
// per process. Nothing a grove user can act on, so it never reaches stderr.
export function isSqliteExperimentalWarning(warning: Error): boolean {
  return (
    warning.name === 'ExperimentalWarning' &&
    /\bsqlite\b/i.test(warning.message)
  );
}

export function installWarningFilter(
  emitter: WarningEmitter = process as unknown as WarningEmitter,
): void {
  const previous = [...emitter.listeners('warning')];
  emitter.removeAllListeners('warning');
  emitter.on('warning', (warning: Error) => {
    if (isSqliteExperimentalWarning(warning)) {
      return;
    }
    for (const listener of previous) {
      listener(warning);
    }
  });
}
