import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  installWarningFilter,
  isSqliteExperimentalWarning,
  type WarningEmitter,
} from './node-warnings.js';

function warning(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('isSqliteExperimentalWarning', () => {
  it('matches the node:sqlite experimental warning', () => {
    expect(
      isSqliteExperimentalWarning(
        warning(
          'ExperimentalWarning',
          'SQLite is an experimental feature and might change at any time',
        ),
      ),
    ).toBe(true);
  });

  it('does not match other experimental warnings', () => {
    expect(
      isSqliteExperimentalWarning(
        warning(
          'ExperimentalWarning',
          'buffer.File is an experimental feature',
        ),
      ),
    ).toBe(false);
  });

  it('does not match a deprecation warning that mentions sqlite', () => {
    expect(
      isSqliteExperimentalWarning(
        warning('DeprecationWarning', 'sqlite option is deprecated'),
      ),
    ).toBe(false);
  });
});

describe('installWarningFilter', () => {
  it('drops the sqlite warning and keeps every other warning', () => {
    const emitter = new EventEmitter();
    const seen: string[] = [];
    emitter.on('warning', (value: Error) => {
      seen.push(value.message);
    });

    installWarningFilter(emitter as unknown as WarningEmitter);
    emitter.emit(
      'warning',
      warning('ExperimentalWarning', 'SQLite is an experimental feature'),
    );
    emitter.emit('warning', warning('DeprecationWarning', 'do not do that'));

    expect(seen).toEqual(['do not do that']);
  });

  it('leaves nothing listening twice', () => {
    const emitter = new EventEmitter();
    emitter.on('warning', () => undefined);
    installWarningFilter(emitter as unknown as WarningEmitter);
    expect(emitter.listenerCount('warning')).toBe(1);
  });
});
