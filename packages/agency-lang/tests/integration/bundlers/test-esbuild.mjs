// Verify that a project using compiled Agency code can be bundled with esbuild.

import { resolve } from "node:path";
import {
  createTempProject, initProject, installTarball, installDev,
  writeFile, run, assertIncludes, cleanup, getTarballPath,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("esbuild");

try {
  initProject(dir);
  installTarball(dir, tarball);
  installDev(dir, "esbuild");

  writeFile(dir, "hello.agency", `
node main(name: string) {
  return "Hello, " + name + "!"
}
`);
  run(dir, "npx agency compile hello.agency");

  // Entry point imports compiled Agency node
  writeFile(dir, "entry.mjs", `
import { main } from "./hello.js";
const result = await main("esbuild");
const value = result?.data ?? result;
if (value !== "Hello, esbuild!") {
  console.error("Expected 'Hello, esbuild!' but got:", JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log("ESBUILD TEST PASSED");
`);

  // Bundle with esbuild — packages=external keeps node_modules as imports
  run(dir, "npx esbuild entry.mjs --bundle --outfile=out.mjs --platform=node --format=esm --packages=external");

  const output = run(dir, "node out.mjs");
  assertIncludes(output, "ESBUILD TEST PASSED");

  console.log("=== esbuild test passed ===");
  cleanup(dir);
} catch (err) {
  console.error("esbuild test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
