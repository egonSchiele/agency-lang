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
  // task is unused: eval entry nodes must take exactly one parameter (the
  // input's task; --goal supplies the goal text as the task).
  writeFile(dir, "eval-agent.agency", `optimize const greeting = "hello"

node main(task: string): string {
  return greeting + " world"
}
`);
  // --no-grade: this test checks the run plumbing (compile, workdir, artifacts),
  // not scoring. eval run grades with the goal judge by default, which is an
  // llm() call, and there is no API key in this job. Test 7 below covers the
  // judge path with a mock.
  run(dir, "npx agency eval run --agent eval-agent.agency --goal \"Say hello\" --runs-dir eval-runs --run-id smoke --no-grade");
  const evalSummary = JSON.parse(readFileSync(join(dir, "eval-runs", "smoke", "summary.json"), "utf-8"));
  if (evalSummary.okCount !== 1 || evalSummary.errorCount !== 0) {
    throw new Error(`eval run summary unexpected: ${JSON.stringify(evalSummary)}`);
  }
  console.log("Test 6 passed");

  // --- Test 6b: agency logs --csv over the run directory just written ---
  console.log("--- Test 6b: agency logs --csv ---");
  const csvOutput = run(dir, "npx agency logs eval-runs --csv");
  assertIncludes(csvOutput, "agent");
  assertIncludes(csvOutput, "run");
  console.log("Test 6b passed");

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

  // --- Test 8: a program reads its own command line ---
  console.log("--- Test 8: command line reaches the program ---");
  writeFile(dir, "greet.agency", `import { parseArgs } from "std::args"

node main() {
  const args = parseArgs({
    programName: "greet",
    flags: { name: { type: "string", default: "world" } },
  })
  print("Hello, " + args.flags.name + "!")
}
`);
  // The form the docs teach: a flag after the filename belongs to the program.
  // Three guarantees in one assertion — the words reach process.argv, agency
  // does not claim them, and std::args parses them.
  const greeted = run(
    dir,
    "./node_modules/.bin/agency run greet.agency --name alice",
  );
  assertIncludes(greeted, "Hello, alice!");

  // The installed binary, not npx: npx consumes `--` before agency sees it.
  // The separator still works for anyone who types it, and the program must
  // never see the separator itself — std::args would read it as "stop reading
  // flags" and quietly fall back to the default.
  const greetedWithSeparator = run(
    dir,
    "./node_modules/.bin/agency run greet.agency -- --name alice",
  );
  assertIncludes(greetedWithSeparator, "Hello, alice!");

  // Agency's own flags still work, before the filename.
  const greetedWithAgencyFlag = run(
    dir,
    "./node_modules/.bin/agency run --max-cost 5 greet.agency --name alice",
  );
  assertIncludes(greetedWithAgencyFlag, "Hello, alice!");

  // Root flags keep working where they read most naturally, between the
  // subcommand and the filename. An earlier approach to this feature broke
  // exactly this.
  const greetedWithRootFlag = run(
    dir,
    "./node_modules/.bin/agency run -v greet.agency --name alice",
  );
  assertIncludes(greetedWithRootFlag, "Hello, alice!");

  // -c takes a value, so the boundary walk must not mistake its value for the
  // filename. The attached spelling is the same flag written differently.
  writeFile(dir, "custom.json", "{}\n");
  for (const configFlag of ["-c custom.json", "-ccustom.json"]) {
    const greetedWithConfig = run(
      dir,
      `./node_modules/.bin/agency run ${configFlag} greet.agency --name alice`,
    );
    assertIncludes(greetedWithConfig, "Hello, alice!");
  }

  // The guard: an agency flag after the filename would otherwise be forwarded
  // and silently do nothing. `--max-cost` caps spend, so failing quietly there
  // is worse than failing loudly.
  const misplaced = run(
    dir,
    "./node_modules/.bin/agency run greet.agency --max-cost 5",
    { expectFail: true },
  );
  assertIncludes(misplaced, "Error: --max-cost is an agency flag");

  // The same flag written in the spellings a naive check would miss.
  for (const [spelling, reported] of [
    ["--max-cost=5", "--max-cost"],
    ["-cfoo.json", "-c"],
    ["-iv", "-i"],
  ]) {
    const missed = run(
      dir,
      `./node_modules/.bin/agency run greet.agency ${spelling}`,
      { expectFail: true },
    );
    assertIncludes(missed, `Error: ${reported} is an agency flag`);
  }

  // A nested command reading an option declared on its parent. Enabling
  // commander's positional parsing on the root would break this, so it is
  // pinned here rather than left to the label suite.
  // `--store` is declared on `label`, not on `ingest`. The source does not
  // exist, so this fails either way; what matters is which error comes back.
  const parentOption = run(
    dir,
    "./node_modules/.bin/agency eval label ingest no-such-dir --store label-store 2>&1",
    { expectFail: true },
  );
  if (parentOption.includes("unknown option '--store'")) {
    throw new Error("parent-command options stopped reaching subcommands");
  }

  // ...unless the user claims it for the program with a separator. greet does
  // not declare a --max-cost flag, so it rejects it — and that rejection is the
  // proof: the flag reached the program instead of being caught by the guard.
  const claimed = run(
    dir,
    "./node_modules/.bin/agency run greet.agency -- --max-cost 5",
    { expectFail: true },
  );
  assertIncludes(claimed, "unknown flag --max-cost");

  // A short phrase: commander re-wraps help text to the terminal width, so a
  // longer assertion can straddle a line break and fail on correct output.
  const runHelp = run(dir, "./node_modules/.bin/agency run --help");
  assertIncludes(runHelp, "Arguments after the filename");

  // A declared parameter is no longer filled from the command line, and the
  // runtime state object must never land in it. It used to arrive as the first
  // argument, printing "[object Object]".
  writeFile(dir, "argful.agency", `node main(task: string): string {
  print("got: " + task)
  return task
}
`);
  // Supplying a word makes this assertion distinguish the new contract from
  // the old argv-to-parameter mapping.
  const withoutMappedArg = run(
    dir,
    "./node_modules/.bin/agency run argful.agency ignored",
  );
  assertIncludes(withoutMappedArg, "got: undefined");
  console.log("Test 8 passed");

  // --- Test 8b: a node parameter default applies on the direct-run path ---
  console.log("--- Test 8b: direct-run parameter default ---");
  writeFile(dir, "argdefault.agency", `node main(name: string = "fallback"): string {
  print("got: " + name)
  return name
}
`);
  const defaulted = run(
    dir,
    "./node_modules/.bin/agency run argdefault.agency Ada",
  );
  assertIncludes(defaulted, "got: fallback");
  console.log("Test 8b passed");

  // --- Test 8c: a compiled or packed program reads its command line too ---
  console.log("--- Test 8c: compiled and packed command line ---");
  // The form the docs recommend for development: compile once, run with node.
  // A separate output path from pack, which inlines the whole package.
  run(dir, "./node_modules/.bin/agency compile greet.agency");
  const compiledGreeting = run(dir, "node greet.js --name alice");
  assertIncludes(compiledGreeting, "Hello, alice!");

  run(dir, "./node_modules/.bin/agency pack greet.agency -o packed-greet.mjs");
  // No `--` here: node passes everything after the script through untouched.
  const packedGreeting = run(dir, "node packed-greet.mjs --name alice");
  assertIncludes(packedGreeting, "Hello, alice!");

  // And `--` must NOT be carried over from the `agency run` form. std::args
  // reads it as "stop reading flags", so the flag silently becomes a positional
  // and the default wins. Documented, and pinned here because the failure is
  // quiet.
  const packedWithSeparator = run(dir, "node packed-greet.mjs -- --name alice");
  assertIncludes(packedWithSeparator, "Hello, world!");
  console.log("Test 8c passed");

  console.log("=== All CLI tests passed ===");
  cleanup(dir);
} catch (err) {
  console.error("CLI test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
