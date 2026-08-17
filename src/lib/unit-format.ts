// The escaping a launchd plist and a systemd unit need. Both the runner
// writer in `stack/native-units.ts` and the daemon writer in
// `daemon/units.ts` produce these two file formats, so the rules live here
// once rather than drifting apart in two places.

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function plistString(key: string, value: string): string {
  return `  <key>${key}</key>\n  <string>${escapeXml(value)}</string>`;
}

// systemd expands a bare `%` as the start of a specifier (`%h`, `%%`, ...) in
// every unit value, so a literal `%` is doubled wherever it appears.
export function systemdSpecifiers(value: string): string {
  return value.replaceAll('%', '%%');
}

// A quoted value also goes through systemd's own quoting syntax, which reads a
// backslash and a quote. An unquoted field does not, which is why Description
// only gets the doubling above.
export function systemdEscape(value: string): string {
  return systemdSpecifiers(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"');
}

export function systemdQuoted(value: string): string {
  return `"${systemdEscape(value)}"`;
}

export function systemdEnvironment(name: string, value: string): string {
  // systemd splits an unquoted value on whitespace, so every value is quoted.
  return `Environment="${name}=${systemdEscape(value)}"`;
}
