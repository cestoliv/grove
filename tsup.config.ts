import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  entry: { grove: 'src/grove.ts' },
  format: ['esm'],
  target: 'node20',
  clean: true,
  shims: true,
  define: { __VERSION__: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
});
