// Verify that a project using compiled Agency code can be bundled with esbuild.

import {
  installDev, run, assertIncludes, withTestProject,
  writeHelloAgency, writeHelloEntryPoint,
} from "../helpers.mjs";

const MARKER = "ESBUILD TEST PASSED";

withTestProject("esbuild", (dir) => {
  installDev(dir, "esbuild");
  writeHelloAgency(dir);
  writeHelloEntryPoint(dir, "entry.mjs", "esbuild", MARKER);
  run(dir, "npx esbuild entry.mjs --bundle --outfile=out.mjs --platform=node --format=esm --packages=external");
  const output = run(dir, "node out.mjs");
  assertIncludes(output, MARKER);
});
