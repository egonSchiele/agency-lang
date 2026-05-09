// Verify that a project using compiled Agency code can be built with Vite.

import { resolve } from "node:path";
import {
  createTempProject, initProject, installTarball, installDev,
  writeFile, run, assertIncludes, cleanup, getTarballPath,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("vite");

try {
  initProject(dir);
  installTarball(dir, tarball);
  installDev(dir, "vite");

  writeFile(dir, "hello.agency", `
node main(name: string) {
  return "Hello, " + name + "!"
}
`);
  run(dir, "npx agency compile hello.agency");

  writeFile(dir, "entry.mjs", `
import { main } from "./hello.js";
const result = await main("vite");
const value = result?.data ?? result;
if (value !== "Hello, vite!") {
  console.error("Expected 'Hello, vite!' but got:", JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log("VITE TEST PASSED");
`);

  // SSR build — bundles for Node, not browser
  writeFile(dir, "vite.config.mjs", `
import { defineConfig } from "vite";
export default defineConfig({
  build: {
    ssr: true,
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
  assertIncludes(output, "VITE TEST PASSED");

  console.log("=== Vite test passed ===");
  cleanup(dir);
} catch (err) {
  console.error("Vite test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
