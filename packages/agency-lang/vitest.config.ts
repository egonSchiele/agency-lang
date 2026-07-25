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
    // The whole `tests/` tree is excluded from the default unit run: those
    // suites run via the Agency test runner or a dedicated config (e.g. the
    // gated integration suite uses vitest.integration.config.ts), and a bare
    // denylist of subdirs would silently sweep any newly-added tests/<dir>
    // into this run.
    // `*.perf.test.ts` is the performance suite — slow, timing-sensitive, and
    // run apart via vitest.perf.config.ts (the `test:perf` script). Excluding it
    // here keeps it out of the default unit run and watch mode.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests', '.worktrees/**', 'runs/**', '**/*.perf.test.ts'],
    setupFiles: ['./lib/parsers/vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './lib'),
    },
  },
});
