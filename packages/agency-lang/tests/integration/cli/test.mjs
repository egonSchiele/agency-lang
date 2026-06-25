// CLI end-to-end tests: compile+run, stdlib imports, interrupts/handlers, test runner.
// All tests avoid LLM calls.

import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
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
import { add, multiply } from "std::math"
import { join } from "std::path"
import { mapValues } from "std::object"

node main() {
  const nums = [1, 2, 3]
  const doubled = map(nums) as n {
    return n * 2
  }
  print(doubled)

  const sum = add(10, 20)
  print(sum)

  const product = multiply(3, 7)
  print(product)

  const p = join("foo", "bar", "baz.txt")
  print(p)

  const obj = { a: 1, b: 2 }
  const doubled2 = mapValues(obj) as (v, k) {
    return v * 2
  }
  print(doubled2)

  return "stdlib ok"
}
`);
  const stdlibOutput = run(dir, "npx agency run stdlib-test.agency");
  assertIncludes(stdlibOutput, "[ 2, 4, 6 ]");
  assertIncludes(stdlibOutput, "30");
  assertIncludes(stdlibOutput, "21");
  assertIncludes(stdlibOutput, "foo/bar/baz.txt"); // CI runs on Linux; Windows would use backslashes
  assertIncludes(stdlibOutput, "{ a: 2, b: 4 }");
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

  // --- Test 5: Literate weave ---
  console.log("--- Test 5: Literate weave ---");
  writeFile(dir, "literate-input.agency", `/* hello literate world */

def add(a: number, b: number): number {
  // sum
  return a + b
}
`);
  run(dir, "npx agency literate weave literate-input.agency -o literate-out");
  const literateOutput = readFileSync(
    join(dir, "literate-out", "literate-input.md"),
    "utf-8",
  );
  assertIncludes(literateOutput, "hello literate world");
  assertIncludes(literateOutput, "```agency");
  assertIncludes(literateOutput, "def add");
  // line comment stays inside the fence (i.e. not lost)
  assertIncludes(literateOutput, "// sum");
  console.log("Test 5 passed");

  // --- Test 6: eval run with an inline goal ---
  console.log("--- Test 6: eval run with an inline goal ---");
  writeFile(dir, "eval-agent.agency", `optimize const greeting = "hello"

node main(): string {
  return greeting + " world"
}
`);
  run(dir, "npx agency eval run --agent eval-agent.agency --goal \"Say hello\" --runs-dir eval-runs --run-id smoke");
  const evalSummary = JSON.parse(readFileSync(join(dir, "eval-runs", "smoke", "summary.json"), "utf-8"));
  if (evalSummary.okCount !== 1 || evalSummary.errorCount !== 0) {
    throw new Error(`eval run summary unexpected: ${JSON.stringify(evalSummary)}`);
  }
  console.log("Test 6 passed");

  // --- Test 7: eval optimize baseline-only run ---
  // --iterations 0 skips the mutator, but the greedy optimizer still grades the
  // baseline with the goal judge — an llm() call. Mock it so the smoke test runs
  // offline (no API key in CI); without a mock the judge's structured output is
  // empty and fails schema validation. The flat-array form routes every llm()
  // call through one queue; eval-agent itself makes none.
  const judgeMockEnv = {
    AGENCY_LLM_MOCKS: JSON.stringify([
      { return: { score: 1, reasoning: "mock judge verdict" } },
      { return: { score: 1, reasoning: "mock judge verdict" } },
    ]),
  };
  console.log("--- Test 7: eval optimize baseline-only ---");
  const optimizeOutput = run(
    dir,
    "npx agency eval optimize eval-agent.agency --goal \"Say hello\" --iterations 0 --runs-dir optimize-runs --run-id smoke --no-writeback 2>&1",
    { env: judgeMockEnv },
  );
  assertIncludes(optimizeOutput, "1 target(s)");
  assertIncludes(optimizeOutput, "eval-agent.agency:global:greeting");
  assertIncludes(optimizeOutput, "champion iteration baseline");
  assertIncludes(optimizeOutput, "Optimized variables");
  const optimizeSummary = JSON.parse(readFileSync(join(dir, "optimize-runs", "smoke", "summary.json"), "utf-8"));
  if (optimizeSummary.championIter !== "baseline") {
    throw new Error(`optimize summary unexpected: ${JSON.stringify(optimizeSummary)}`);
  }
  // The legacy flag surface must stay dead.
  const legacyOutput = run(dir, "npx agency eval optimize --agent eval-agent.agency --goal x 2>&1", { expectFail: true });
  assertIncludes(legacyOutput, "unknown option");
  // --silent prints nothing.
  const silentOutput = run(
    dir,
    "npx agency eval optimize eval-agent.agency --goal \"Say hello\" --iterations 0 --runs-dir optimize-runs --run-id silent-smoke --no-writeback --silent 2>&1",
    { env: judgeMockEnv },
  );
  if (silentOutput.trim() !== "") {
    throw new Error(`--silent printed output: ${JSON.stringify(silentOutput)}`);
  }
  console.log("Test 7 passed");

  console.log("=== All CLI tests passed ===");
  cleanup(dir);
} catch (err) {
  console.error("CLI test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
