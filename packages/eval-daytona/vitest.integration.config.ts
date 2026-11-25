import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
