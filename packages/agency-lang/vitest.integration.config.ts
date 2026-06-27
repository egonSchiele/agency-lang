import { defineConfig } from 'vitest/config';
import path from 'path';

// Dedicated config for the gated integration suite (real model download +
// inference). The default `vitest.config.ts` excludes the whole `tests/` tree,
// so the integration suite needs its own include. Run with:
//   AGENCY_LLM_INTEGRATION=1 pnpm exec vitest run -c vitest.integration.config.ts
// The tests themselves no-op unless AGENCY_LLM_INTEGRATION=1 is set.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./lib/parsers/vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './lib'),
    },
  },
});
