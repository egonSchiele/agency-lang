import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Agency fixtures compile the same index.agency to index.js.
    // Finish each file before another test can overwrite that shared output.
    fileParallelism: false,
  },
});
