import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors.js';

describe('errorMessage', () => {
  it('reads the message of an Error', () => {
    expect(errorMessage(new Error('no route to host'))).toBe(
      'no route to host',
    );
  });

  it('describes a thrown value that is not an Error', () => {
    expect(errorMessage('boom')).toBe('boom');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ code: 7 })).toBe('[object Object]');
  });
});
