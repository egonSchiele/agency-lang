import { defineConfig } from "vitest/config";
import { aliases } from "./vitest.aliases.ts";

// The browser smoke test: bundles tests/browser/hello.agency for the browser
// and runs it in headless Chromium. Apart from the unit run because it needs
// dist/ (run `make`) and a Chromium that `playwright-core install chromium`
// downloaded. The `test:browser` script runs it.
export default defineConfig({
  test: {
    include: ["tests/browser/**/*.test.ts"],
    testTimeout: 120_000,
  },
  resolve: {
    alias: aliases,
  },
});
