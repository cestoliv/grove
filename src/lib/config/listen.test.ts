import { describe, expect, it } from 'vitest';
import { isListen, isLoopback, parseListen } from './listen.js';

describe('parseListen', () => {
  it('splits a host and a port', () => {
    expect(parseListen('127.0.0.1:9130')).toEqual({
      host: '127.0.0.1',
      port: 9130,
    });
  });

  it('reads a bracketed IPv6 host', () => {
    expect(parseListen('[::1]:9130')).toEqual({ host: '::1', port: 9130 });
  });

  it('accepts a host name', () => {
    expect(parseListen('localhost:9130')).toEqual({
      host: 'localhost',
      port: 9130,
    });
  });

  it('refuses a bare port, because every interface should be a choice', () => {
    expect(() => parseListen(':9130')).toThrow(RangeError);
  });

  it('refuses a missing port and a port out of range', () => {
    expect(() => parseListen('127.0.0.1')).toThrow(RangeError);
    expect(() => parseListen('127.0.0.1:0')).toThrow(RangeError);
    expect(() => parseListen('127.0.0.1:70000')).toThrow(RangeError);
    expect(() => parseListen('127.0.0.1:http')).toThrow(RangeError);
  });

  it('answers the same question without throwing', () => {
    expect(isListen('127.0.0.1:9130')).toBe(true);
    expect(isListen('9130')).toBe(false);
  });
});

describe('isLoopback', () => {
  it('knows the three ways to say this machine', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.4.5.6')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
  });

  it('knows every other address is not', () => {
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('10.0.0.4')).toBe(false);
    expect(isLoopback('::')).toBe(false);
  });
});
