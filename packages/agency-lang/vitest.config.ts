import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    // runs/ holds eval/optimize run output; optimize copies the whole
    // working dir (test files included) into iter-N/workspace/, so without
    // this exclude a local optimize session pollutes the test run.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/agency/**', 'tests/agency-js/**', 'tests/cli/**', 'tests/cli-main/**', 'tests/serve/**', 'tests/smoke/**', 'tests/statelog/**', 'tests/stdlib-sandbox/**', 'tests/stdlib-sandbox-js/**', 'tests/optimize-efficacy/**', 'tests/bundlers/**', '.worktrees/**', 'runs/**'],
    setupFiles: ['./lib/parsers/vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './lib'),
    },
  },
});
