// Verify that a project using compiled Agency code can be built with Vite.

import {
  installDev, writeFile, run, assertIncludes, withTestProject,
  writeHelloAgency, writeHelloEntryPoint,
} from "../helpers.mjs";

const MARKER = "VITE TEST PASSED";

withTestProject("vite", (dir) => {
  installDev(dir, "vite@6");
  writeHelloAgency(dir);
  writeHelloEntryPoint(dir, "entry.mjs", "vite", MARKER);

  writeFile(dir, "vite.config.mjs", `import { defineConfig } from "vite";
export default defineConfig({
  build: {
    ssr: true,
    target: "esnext",
    rollupOptions: {
      input: "./entry.mjs",
      output: { format: "esm" },
    },
    outDir: "dist",
  },
});
`);

  run(dir, "npx vite build");
  const output = run(dir, "node dist/entry.js");
  assertIncludes(output, MARKER);
});
