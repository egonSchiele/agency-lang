import { defineConfig } from "vitest/config";
import path from "path";

// The performance suite (mirrors vitest.integration.config.ts). Kept apart from
// the default unit run because it is slow and must run serially — parallel tests
// contend for CPU and poison the timings.
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
