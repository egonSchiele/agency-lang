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
    exclude: ['**/node_modules/**', '**/dist/**', 'tests', '.worktrees/**', 'runs/**'],
    setupFiles: ['./lib/parsers/vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './lib'),
    },
  },
});
