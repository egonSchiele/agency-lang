// Smoke test: install Agency from tarball, compile an .agency file,
// import the compiled output from TypeScript, and run it.

import { resolve } from "node:path";
import {
  createTempProject, initProject, installTarball, installDev,
  writeFile, run, assertIncludes, cleanup, getTarballPath,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("smoke");

try {
  // 1. Create fresh project and install Agency
  initProject(dir);
  installTarball(dir, tarball);
  installDev(dir, "tsx");

  // 2. Write a simple .agency file (no LLM calls)
  writeFile(dir, "hello.agency", `
node main(name: string) {
  const greeting = "Hello, " + name + "!"
  print(greeting)
  return greeting
}
`);

  // 3. Compile it
  run(dir, "npx agency compile hello.agency");

  // 4. Write a TS test file that imports the compiled output and the runtime
  // Agency nodes return a result object with { data, messages, tokens }.
  // The actual return value is in .data.
  writeFile(dir, "test.ts", `
import { main } from "./hello.js";

async function test() {
  const result = await main("World");
  const value = result?.data ?? result;
  if (value !== "Hello, World!") {
    console.error("Expected 'Hello, World!' but got:", JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log("SMOKE TEST PASSED");
}

test();
`);

  // 5. Run the test
  const output = run(dir, "npx tsx test.ts");
  assertIncludes(output, "SMOKE TEST PASSED");

  // 6. Also verify runtime import works
  writeFile(dir, "test-runtime.ts", `
import "agency-lang/runtime";
console.log("RUNTIME IMPORT PASSED");
`);
  const runtimeOutput = run(dir, "npx tsx test-runtime.ts");
  assertIncludes(runtimeOutput, "RUNTIME IMPORT PASSED");

  console.log("=== Smoke test passed ===");
  cleanup(dir);
} catch (err) {
  console.error("Smoke test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
