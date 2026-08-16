import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(version),
  },
  test: {
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    isolate: false,
    maxWorkers: 1,
  },
});
