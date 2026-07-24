import { defineConfig } from "vitest/config";
import path from "path";

// The performance suite. Kept apart from the default unit run (which excludes
// `**/*.perf.test.ts`) because these tests are slow by nature and must not run
// concurrently: parallel test files contend for CPU and poison the timings the
// whole suite depends on. Mirrors vitest.integration.config.ts's separate-config
// pattern.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.perf.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests", ".worktrees/**", "runs/**"],
    setupFiles: ["./lib/parsers/vitest.setup.ts"],
    // Perf measurements repeat large workloads many times; the default 5s
    // per-test timeout is far too short for a scaling test on an 8000-node file.
    testTimeout: 120_000,
    // Serialize everything — no cross-test CPU contention.
    fileParallelism: false,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./lib"),
    },
  },
});
