import { defineConfig } from "vitest/config";

// The integration tests start real Daytona containers. They have their own
// config and script, and are not part of the default run or of CI.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "dist/**", "**/*.integration.test.ts", "tests/**"],
  },
});
