// CLI end-to-end tests: compile+run, stdlib imports, interrupts/handlers, test runner.
// All tests avoid LLM calls.

import { resolve, join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
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

  // Position always wins, so an agency flag after the filename goes to the
  // program, and the warning is the only thing standing between that and a
  // silent surprise. greet does not declare --max-cost, so its own parser then
  // rejects it — which is also the proof the flag really was forwarded. That it
  // is forwarded rather than intercepted is pinned in commandLine.test.ts.
  const warned = run(
    dir,
    "./node_modules/.bin/agency run greet.agency --max-cost 5 2>&1",
    { expectFail: true },
  );
  assertIncludes(warned, "Warning: --max-cost went to your program");
  assertIncludes(warned, "unknown flag --max-cost");

  // The same flag in the spellings a naive check would miss.
  for (const [spelling, reported] of [
    ["--max-cost=5", "--max-cost"],
    ["-cfoo.json", "-c"],
    ["-iv", "-i"],
  ]) {
    const missed = run(
      dir,
      `./node_modules/.bin/agency run greet.agency ${spelling} 2>&1`,
      { expectFail: true },
    );
    assertIncludes(missed, `Warning: ${reported} went to your program`);
  }

  // A flag the program owns draws no warning, and neither does one the user
  // deliberately claimed with a separator.
  const quiet = run(
    dir,
    "./node_modules/.bin/agency run greet.agency --name alice 2>&1",
  );
  if (quiet.includes("Warning:")) {
    throw new Error(`warned about a flag agency does not define: ${quiet}`);
  }
  const claimed = run(
    dir,
    "./node_modules/.bin/agency run greet.agency -- --max-cost 5 2>&1",
    { expectFail: true },
  );
  if (claimed.includes("Warning:")) {
    throw new Error(`warned about a flag the user claimed with --: ${claimed}`);
  }
  assertIncludes(claimed, "unknown flag --max-cost");

  // A short token agency does not own must forward without comment. Reading
  // every letter would find the `i` in -print and warn about agency's -i.
  const programShort = run(
    dir,
    "./node_modules/.bin/agency run greet.agency -print 2>&1",
    { expectFail: true },
  );
  if (programShort.includes("Warning:")) {
    throw new Error(`warned about a program-owned short token: ${programShort}`);
  }

  // Bare --trace and an explicit path both work before the filename. `--trace
  // [file]` could do neither: it swallowed the filename as its value.
  run(dir, "./node_modules/.bin/agency run --trace greet.agency");
  if (!existsSync(join(dir, "greet.trace"))) {
    throw new Error("bare --trace wrote no trace file");
  }
  run(dir, "./node_modules/.bin/agency run --trace-file custom.trace greet.agency");
  if (!existsSync(join(dir, "custom.trace"))) {
    throw new Error("--trace-file wrote no trace file");
  }

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
  // --- The shorthand behaves exactly like `agency run` ---
  // `agency greet.agency` is documented as shorthand for `agency run
  // greet.agency`, so every case above must hold with the word left out.
  const shortGreeted = run(dir, "./node_modules/.bin/agency greet.agency --name alice");
  assertIncludes(shortGreeted, "Hello, alice!");

  const shortWithAgencyFlag = run(
    dir,
    "./node_modules/.bin/agency --max-cost 5 greet.agency --name alice",
  );
  assertIncludes(shortWithAgencyFlag, "Hello, alice!");

  const shortSeparator = run(
    dir,
    "./node_modules/.bin/agency greet.agency -- --name alice",
  );
  assertIncludes(shortSeparator, "Hello, alice!");

  const shortWarned = run(
    dir,
    "./node_modules/.bin/agency greet.agency --max-cost 5 2>&1",
    { expectFail: true },
  );
  assertIncludes(shortWarned, "Warning: --max-cost went to your program");

  // A real command must not be mistaken for a filename. compile takes a list of
  // files, so a separator pushed in here would break it.
  run(dir, "./node_modules/.bin/agency compile greet.agency basic.agency");

  // Including commander's implicit `help`, which is not in program.commands.
  // Treating it as a filename turns these into failed runs of a missing
  // program instead of printing help and the version.
  const helpHelp = run(dir, "./node_modules/.bin/agency help --help 2>&1");
  assertIncludes(helpHelp, "Usage: agency");
  const helpVersion = run(dir, "./node_modules/.bin/agency help --version 2>&1");
  if (helpVersion.includes("Warning:")) {
    throw new Error(`the implicit help command was treated as a file: ${helpVersion}`);
  }
  // And a hidden command, which visibleCommands leaves out.
  const remoteHelp = run(dir, "./node_modules/.bin/agency remote --help 2>&1");
  if (remoteHelp.includes("Warning:")) {
    throw new Error(`a hidden command was treated as a file: ${remoteHelp}`);
  }

  // --- --model reaches the compiled program ---
  // `--model` lives on addRunOptions, which `run` and the shorthand share.
  // `agency compile` has its own option list and does NOT take it, so these
  // cases drive the two supported surfaces and read what they compiled.
  //
  // Start from an agency.json that already names a provider, so the bare-model
  // case has something to clear and cannot pass for the wrong reason.
  writeFile(dir, "agency.json", JSON.stringify({
    client: { defaultModel: "gpt-4o-mini", defaultProvider: "openrouter" },
  }, null, 2));

  // A bare model replaces the model AND drops the inherited provider, so
  // smoltalk infers one from the name.
  const bareRun = run(dir, "./node_modules/.bin/agency run --model claude-opus-4-8 greet.agency --name alice");
  assertIncludes(bareRun, "Hello, alice!");
  const bareOut = readFileSync(join(dir, "greet.js"), "utf-8");
  assertIncludes(bareOut, 'model: "claude-opus-4-8"');
  // Anchored on a baked literal: the bare token `provider` also appears in
  // unrelated generated output.
  if (/provider:\s*"/.test(bareOut)) {
    throw new Error("a bare --model left a provider in the generated config");
  }

  // The shorthand takes the flag too, and a prefixed value sets both fields.
  const prefixedRun = run(dir, "./node_modules/.bin/agency --model openrouter/anthropic/claude-sonnet-4 greet.agency --name alice");
  assertIncludes(prefixedRun, "Hello, alice!");
  const prefixedOut = readFileSync(join(dir, "greet.js"), "utf-8");
  assertIncludes(prefixedOut, 'model: "anthropic/claude-sonnet-4"');
  if (!/provider:\s*"openrouter"/.test(prefixedOut)) {
    throw new Error("a prefixed --model did not bake its provider");
  }

  // An unknown bare model fails BEFORE compiling. Give it a fresh source name
  // whose output cannot exist from an earlier case; asserting that output was
  // never created proves the ordering without deleting a test artifact first.
  writeFile(dir, "invalid-model.agency", `node main() {
  print("must not execute")
}
`);
  const badModel = run(
    dir,
    "./node_modules/.bin/agency run --model gpt-4o-minii invalid-model.agency 2>&1",
    { expectFail: true },
  );
  assertIncludes(badModel, 'Unknown model "gpt-4o-minii"');
  assertIncludes(badModel, 'Did you mean "gpt-4o-mini"');
  if (badModel.includes("    at ")) {
    throw new Error(`an unknown model printed a stack trace: ${badModel}`);
  }
  if (existsSync(join(dir, "invalid-model.js"))) {
    throw new Error("compilation happened despite an invalid --model");
  }

  // The position rule applies to the new flag like any other: after the
  // filename it belongs to the program, is NOT validated by agency, and draws
  // the standard warning. greet does not declare --model, so its own parser
  // rejects it — which is also the proof the flag was forwarded. Use an
  // unknown attached value: that distinguishes "not validated" from a valid
  // value that agency might have validated successfully, and covers
  // `--model=value` in the boundary scanner at the same time.
  const modelAfterFile = run(
    dir,
    "./node_modules/.bin/agency run greet.agency --model=definitely-not-a-real-model 2>&1",
    { expectFail: true },
  );
  assertIncludes(modelAfterFile, "Warning: --model went to your program");
  assertIncludes(modelAfterFile, "unknown flag --model");
  if (modelAfterFile.includes("Unknown model")) {
    throw new Error("agency validated a --model that belonged to the program");
  }

  // Restore neutral configuration for the later cases in this file. Writing
  // the fixture is safer and clearer than deleting a path during a test.
  writeFile(dir, "agency.json", "{}\n");

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

  // --- Test 8d: flag ownership — a flag is valid after its owner, never before ---
  console.log("--- Test 8d: flag ownership matrix ---");

  // A subcommand flag written before the subcommand word is an ERROR naming
  // the owner and the fix — never `Unknown command 'run'`.
  for (const misplaced of [
    "./node_modules/.bin/agency --model claude-opus-4-8 run greet.agency",
    "./node_modules/.bin/agency --max-cost 5 run greet.agency",
  ]) {
    const ownerError = run(dir, `${misplaced} 2>&1`, { expectFail: true });
    assertIncludes(ownerError, "write it after 'run'");
    if (ownerError.includes("Unknown command")) {
      throw new Error(`misplaced flag produced the old misdiagnosis: ${ownerError}`);
    }
  }

  // A flag nobody owns is a plain unknown option, also not a file error.
  const nonsense = run(
    dir,
    "./node_modules/.bin/agency --nonsense greet.agency 2>&1",
    { expectFail: true },
  );
  assertIncludes(nonsense, "unknown option");

  // Command typos get commander's suggestion; an explicit `run` with a missing
  // input is only ever a file problem, never a command suggestion.
  const typo = run(dir, "./node_modules/.bin/agency formt 2>&1", { expectFail: true });
  assertIncludes(typo, "unknown command 'formt'");
  assertIncludes(typo, "format");
  const missingInput = run(
    dir,
    "./node_modules/.bin/agency run formt 2>&1",
    { expectFail: true },
  );
  if (missingInput.includes("unknown command")) {
    throw new Error(`explicit run suggested a command for its input: ${missingInput}`);
  }

  // A pre-input separator ends option parsing but the input is still agency's.
  const preInputSeparator = run(
    dir,
    "./node_modules/.bin/agency run -- greet.agency --name alice",
  );
  assertIncludes(preInputSeparator, "Hello, alice!");

  // The budget cap is REAL on the run path: the child process carries it in
  // AGENCY_MAX_COST. Pure Agency + a js helper — no LLM call.
  writeFile(dir, "budget-env.js", `export function maxCostEnv() {
  return process.env.AGENCY_MAX_COST ?? "unset";
}
`);
  writeFile(dir, "budget-probe.agency", `import { maxCostEnv } from "./budget-env.js"

node main() {
  print("AGENCY_MAX_COST=" + maxCostEnv())
}
`);
  const budgeted = run(
    dir,
    "./node_modules/.bin/agency run --max-cost 5 budget-probe.agency",
  );
  assertIncludes(budgeted, "AGENCY_MAX_COST=5");

  // Nested default commands still answer at the parent's position: the
  // default `list` action runs and reports the missing credential by name.
  // Asserting the exact action-level error (not just "no unknown option")
  // proves the action executed rather than help or an unrelated failure.
  for (const remoteDefault of ["projects", "keys"]) {
    const credential = run(
      dir,
      `./node_modules/.bin/agency remote ${remoteDefault} --host https://h --api-key-env MISSING_KEY 2>&1`,
      { expectFail: true },
    );
    assertIncludes(credential, "Missing API key — set $MISSING_KEY.");
  }

  // `trace` defaults to `trace run`: the probe executes (no LLM) and the
  // requested trace file exists and is non-empty — exit status alone would
  // not prove the default action ran.
  writeFile(dir, "trace-probe.agency", `node main() {
  print("traced")
}
`);
  run(dir, "./node_modules/.bin/agency trace trace-probe.agency --output probe.trace");
  if (!existsSync(join(dir, "probe.trace"))) {
    throw new Error("trace default-run wrote no trace file");
  }
  if (readFileSync(join(dir, "probe.trace"), "utf-8").length === 0) {
    throw new Error("trace default-run wrote an empty trace file");
  }

  // `test` defaults to `test run` and reports the passing test by name.
  writeFile(dir, "passing.agency", `node main(): number {
  return 42
}
`);
  writeFile(dir, "passing.test.json", JSON.stringify({
    tests: [{
      nodeName: "main",
      input: "",
      expectedOutput: "42",
      evaluationCriteria: [{ type: "exact" }],
    }],
  }, null, 2));
  const agencyTest = run(dir, "./node_modules/.bin/agency test passing.agency 2>&1");
  assertIncludes(agencyTest, "passing");
  console.log("Test 8d passed");

  // --- Test 8e: the agent surface — full delegation + explicit config ---
  console.log("--- Test 8e: agent flag delegation and --config ---");

  // The agent's own schema is the single help source, budget flags included.
  const agentHelp = run(dir, "./node_modules/.bin/agency agent --help 2>&1");
  for (const flag of ["--max-cost", "--max-time", "--config"]) {
    assertIncludes(agentHelp, flag);
  }

  // An invalid duration is the LAUNCHER's rejection, before spawn — not a
  // commander unknown-option, and the agent never starts.
  const badDuration = run(
    dir,
    "./node_modules/.bin/agency agent -p hi --max-time bogus 2>&1",
    { expectFail: true },
  );
  assertIncludes(badDuration, "--max-time");
  if (badDuration.includes("unknown option")) {
    throw new Error(`the launcher misread --max-time as commander's: ${badDuration}`);
  }

  // A bare budget flag is left for the AGENT's parser to report: the launcher
  // ignores the empty value and forwards the original argv unchanged.
  const bareBudget = run(
    dir,
    "./node_modules/.bin/agency agent -p hi --max-time 2>&1",
    { expectFail: true },
  );
  assertIncludes(bareBudget, "--max-time");

  // Full delegation: -c after `agent` reaches the agent program, whose own
  // parser rejects it by name — proof it was forwarded, not intercepted.
  const agentDashC = run(
    dir,
    "./node_modules/.bin/agency agent -c cfg.json 2>&1",
    { expectFail: true },
  );
  assertIncludes(agentDashC, "unknown short flag -c");

  // Hash every compiled .js in the installed agent tree before any configured
  // run — agent.js alone is not enough, the compiler writes recursively.
  const installedAgentDir = join(
    dir, "node_modules", "agency-lang", "dist", "lib", "agents", "agency-agent",
  );
  // Canonical: sorted entries, because readdirSync order is not guaranteed
  // and a plain-object JSON comparison would depend on insertion order.
  const agentTreeHashes = () => {
    const hashes = [];
    const visit = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith(".js")) {
          hashes.push([full, createHash("sha256").update(readFileSync(full)).digest("hex")]);
        }
      }
    };
    visit(installedAgentDir);
    hashes.sort((a, b) => a[0].localeCompare(b[0]));
    return hashes;
  };
  const hashesBefore = agentTreeHashes();

  // A malformed explicit config is the exact config-load error, before any
  // child output — this is the production proof that the forwarded-config
  // path invokes staging rather than the shipped agent.js (which would have
  // happily printed help).
  writeFile(dir, "malformed.json", "{not json");
  const badConfig = run(
    dir,
    "./node_modules/.bin/agency agent --config malformed.json --help 2>&1",
    { expectFail: true },
  );
  assertIncludes(badConfig, "Error loading config from");

  // Valid explicit configs run (forwarded and root forms). --help keeps these
  // no-LLM; config precedence is proven by the deterministic orchestration
  // tests, and these two prove installed-tree isolation on the real wiring.
  writeFile(dir, "sentinel-cfg.json", JSON.stringify({
    client: { defaultModel: "gpt-4o-mini" },
  }));
  const forwardedConfigHelp = run(
    dir,
    "./node_modules/.bin/agency agent --config sentinel-cfg.json --help 2>&1",
  );
  assertIncludes(forwardedConfigHelp, "--max-cost");
  const rootConfigHelp = run(
    dir,
    "./node_modules/.bin/agency -c sentinel-cfg.json agent --help 2>&1",
  );
  assertIncludes(rootConfigHelp, "--max-cost");

  // The installed tree is byte-for-byte unchanged, and a plain invocation
  // still works afterwards (no configured build leaked into the fast path).
  const hashesAfter = agentTreeHashes();
  if (JSON.stringify(hashesAfter) !== JSON.stringify(hashesBefore)) {
    throw new Error("a configured agent run modified the installed agent tree");
  }
  const plainAgentHelp = run(dir, "./node_modules/.bin/agency agent --help 2>&1");
  assertIncludes(plainAgentHelp, "--max-cost");
  console.log("Test 8e passed");

  console.log("=== All CLI tests passed ===");
  cleanup(dir);
} catch (err) {
  console.error("CLI test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
