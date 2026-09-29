import { defineConfig } from "vitest/config";

// Its own config, so vitest does not walk up to another package's.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
