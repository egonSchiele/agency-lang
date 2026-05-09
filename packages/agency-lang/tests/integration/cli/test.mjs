// CLI end-to-end tests: compile+run, stdlib imports, interrupts/handlers, test runner.
// All tests avoid LLM calls.

import { resolve } from "node:path";
import {
  createTempProject, initProject, installTarball,
  writeFile, run, assertIncludes, cleanup, getTarballPath,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("cli");

try {
  initProject(dir);
  installTarball(dir, tarball);

  // --- Test 1: Basic compile and run ---
  console.log("--- Test 1: Basic compile and run ---");
  writeFile(dir, "basic.agency", `node main() {
  const greeting = "hello " + "world"
  print(greeting)
  return greeting
}
`);
  const basicOutput = run(dir, "npx agency run basic.agency");
  assertIncludes(basicOutput, "hello world");
  console.log("Test 1 passed");

  // --- Test 2: Stdlib imports ---
  console.log("--- Test 2: Stdlib imports ---");
  writeFile(dir, "stdlib-test.agency", `import { map } from "std::array"
import { add } from "std::math"
import { join } from "std::path"
import { now } from "std::date"
import { mapValues } from "std::object"

node main() {
  const nums = [1, 2, 3]
  const doubled = map(nums) as n {
    return n * 2
  }
  print(doubled)

  const sum = add(10, 20)
  print(sum)

  const p = join("foo", "bar", "baz.txt")
  print(p)

  const t = now()
  print(t)

  const obj = { a: 1, b: 2 }
  const doubled2 = mapValues(obj) as (v, k) {
    return v * 2
  }
  print(doubled2)

  return "stdlib ok"
}
`);
  const stdlibOutput = run(dir, "npx agency run stdlib-test.agency");
  // Verify stdlib functions produced correct output
  assertIncludes(stdlibOutput, "[ 2, 4, 6 ]");  // map doubled
  assertIncludes(stdlibOutput, "30");             // add(10, 20)
  assertIncludes(stdlibOutput, "foo/bar/baz.txt"); // join
  assertIncludes(stdlibOutput, "{ a: 2, b: 4 }"); // mapValues doubled
  console.log("Test 2 passed");

  // --- Test 3: Interrupts and handlers ---
  console.log("--- Test 3: Interrupts and handlers ---");
  writeFile(dir, "interrupt-test.agency", `def dangerousAction() {
  return interrupt("Are you sure?")
  return "action completed"
}

node main() {
  handle {
    const result = dangerousAction()
  } with (data) {
    return approve()
  }
  return result
}
`);
  // If the handler works, execution completes without error (exit code 0).
  // If the interrupt isn't handled, the program would fail.
  run(dir, "npx agency run interrupt-test.agency");
  console.log("Test 3 passed");

  // --- Test 4: Agency test runner ---
  console.log("--- Test 4: Agency test runner ---");
  writeFile(dir, "testable.agency", `node greet(name: string) {
  return "hi " + name
}
`);
  writeFile(dir, "testable.test.json", JSON.stringify({
    tests: [
      {
        nodeName: "greet",
        input: '"Alice"',
        expectedOutput: '"hi Alice"',
        evaluationCriteria: [{ type: "exact" }],
      },
    ],
  }, null, 2));
  run(dir, "npx agency test testable.agency");
  console.log("Test 4 passed");

  console.log("=== All CLI tests passed ===");
  cleanup(dir);
} catch (err) {
  console.error("CLI test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
