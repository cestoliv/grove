import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  entry: { grove: 'src/grove.ts' },
  format: ['esm'],
  target: 'node22',
  clean: true,
  shims: true,
  // tsup rewrites `node:sqlite` to `sqlite`, and that module has no bare
  // alias, so every command that opens the state store dies in the bundle.
  removeNodeProtocol: false,
  define: { __VERSION__: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
});
