// SPIKE: the unit suite on the promise-tracking context store. Every `async`
// function in the code under test is rewritten into promise code, and the
// seam is switched to the new store. See scripts/portable-loader.mjs.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(
  base,
  defineConfig({
    esbuild: {
      supported: { "async-await": false, "async-generator": false, "for-await": false },
    },
    test: {
      env: { AGENCY_PORTABLE_CONTEXT: "1" },
    },
  }),
);
