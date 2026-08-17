import { describe, expect, it } from 'vitest';
import {
  escapeXml,
  plistString,
  systemdEnvironment,
  systemdQuoted,
  systemdSpecifiers,
} from './unit-format.js';

describe('unit formatting', () => {
  it('escapes every XML metacharacter', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('writes a plist key and string pair', () => {
    expect(plistString('Label', 'com.cestoliv.grove.daemon')).toBe(
      '  <key>Label</key>\n  <string>com.cestoliv.grove.daemon</string>',
    );
  });

  it('doubles a percent so systemd does not read it as a specifier', () => {
    expect(systemdSpecifiers('100%')).toBe('100%%');
  });

  it('quotes and escapes a systemd value', () => {
    expect(systemdQuoted('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
    expect(systemdEnvironment('PATH', '/usr/bin:/bin')).toBe(
      'Environment="PATH=/usr/bin:/bin"',
    );
  });
});
