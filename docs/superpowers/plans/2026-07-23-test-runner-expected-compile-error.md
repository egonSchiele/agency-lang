# Test Runner Expected Compile Errors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `.test.json` say "this `.agency` file must fail to compile, and the failure must mention X," so compile-time diagnostics (starting with the code-templates `AG8001`/`AG8002`) can be tested from the ordinary test suite.

**Architecture:** A new file-level field, `expectedCompileError`, on the `.test.json` shape. Files carrying it are carved out of the up-front precompile pass, and the runner handles them by spawning `agency compile` in a child process and judging the child's exit code and output. The child process is the whole point: `compile()` reports most failures with `process.exit(1)` rather than a throw, so an in-process attempt would kill the test runner mid-run.

**Tech Stack:** TypeScript, vitest for unit tests, the Agency CLI test runner (`lib/cli/test.ts`), commander (`scripts/agency.ts`), `child_process.execFile` via the promisified `execFileAsync` in `lib/cli/util.ts`.

**Spec:** `/Users/adityabhargava/agency-lang/worktree-code-templates/docs/superpowers/specs/2026-07-23-test-runner-expected-compile-error.md`

## Global Constraints

All paths below are relative to `/Users/adityabhargava/agency-lang/worktree-code-templates/packages/agency-lang` unless written absolute.

- **No dynamic imports.** Static imports only.
- **Objects, not Maps. Arrays, not Sets. `type`, not `interface`.**
- **Never force-push, never amend commits, never commit to `main`.** Check `git branch --show-current` before every commit.
- **Never edit `CHANGELOG.md`.**
- **Comments explain why, never what.** Do not add a comment that restates the line below it.
- **Colors come from `lib/utils/termcolors.ts`** (`import { color } from "@/utils/termcolors.js"`), never raw ANSI escapes.
- **Run `make` before running any `agency` CLI command.** `pnpm run build` skips parts of the build; the CLI you spawn is `dist/scripts/agency.js` and it must be current.
- **Do not run the whole Agency test suite locally.** It is slow and expensive. Run the specific fixture files this plan names. CI runs the rest.
- **Save test output to a file** so a failure can be read without re-running: `pnpm test:run <path> 2>&1 | tee /tmp/out.txt`.
- **Anti-pattern audit before the PR:** read `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md` and check the diff against them.

## Background an implementer needs

Three facts about this codebase drive every decision below. Read them before Task 1 or the code will look arbitrary.

**1. `compile()` mostly does not throw — it exits the process.** Inside `compileEntry` (`lib/compiler/buildSession.ts`), a parse failure prints `Failed to parse Agency program` and calls `process.exit(1)` (line 624-628); a type error under `typechecker.strict` prints `formatErrors(...)` and calls `process.exit(1)` — but only when some diagnostic has `severity === "error"`; warnings-only output compiles fine (line 645-655, the `hasFatal` check); a type error *without* strict only warns, and the compile succeeds; an import-closure failure is converted to `process.exit(1)` (line 339-346). The single failure that actually throws is an exception during code generation, because nothing wraps `generateTypeScript` (line 520-530). That is how the code-templates work raises `AG8001`.

**2. The runner compiles everything up front.** `precompileTestSources` (`lib/cli/test.ts:979-987`) compiles every collected source before any test runs, and a failure there ends the process. A fixture that intentionally doesn't compile must be excluded from that pass or it takes the whole suite down. `lib/cli/precompile.ts:36-43` already does this for `skip: true` files.

**3. Diagnostic codes are not inside message strings.** `diagnostic()` (`lib/typeChecker/diagnostics.ts:672-687`) puts `code` and `message` in separate fields. Only `formatErrors` (`lib/typeChecker/index.ts:555`) joins them, when printing. So matching the substring `"AG2001"` works against a child process's *output*, and would not work against an in-process `Error.message`.

Together these say: spawn a child, and judge it by exit code plus printed output.

## File Structure

**Create:**

- `lib/cli/expectedCompileError.ts` — the pure decision logic: given what a compile attempt produced, did it meet the expectation? No I/O, no spawning. This is where all the interesting behavior lives, which is why it is separated from the runner glue.
- `lib/cli/expectedCompileError.test.ts` — vitest for the above.
- `tests/agency/expectedCompileError/agency.json` — dir-local config turning on `typechecker.strict` for the type-error fixture.
- `tests/agency/expectedCompileError/parseFailure.agency` + `.test.json` — a file that cannot be parsed.
- `tests/agency/expectedCompileError/typeError.agency` + `.test.json` — a file that parses but fails the typechecker.

**Modify:**

- `lib/cli/precompile.ts:32-43,57` — broaden the precompile exclusion.
- `lib/cli/precompile.test.ts` — a test for the new exclusion.
- `lib/cli/test.ts:79-97` (the `Tests` type), `:799` (`tests.tests.length`), and a new branch plus spawn helper in `runTestFile`.
- `scripts/agency.ts:262-266` — the `compile` action honors `AGENCY_ALLOW_TEST_IMPORTS`.
- `agency.json` — add the fixture directory to `coverage.exclude`.
- `docs/misc/TESTING.md:119-158` — document the field.

**Task order rationale:** the pure matcher first (Tasks 1), because everything else consumes its types; then the two small independent edits it does not depend on (Tasks 2 and 3); then the runner wiring that pulls them together (Task 4); then the end-to-end fixtures that can only exist once the wiring is real (Task 5); then docs (Task 6).

---

### Task 1: The verdict function

The one piece of real logic: given the outcome of a compile attempt and the expected substring, decide pass or fail and say why. Pure, so it can be tested in every direction without spawning anything or leaving a permanently-broken fixture in the tree.

**Files:**
- Create: `lib/cli/expectedCompileError.ts`
- Test: `lib/cli/expectedCompileError.test.ts`

**Interfaces:**
- Consumes: `formatDiff` from `@/utils/diff.js` — signature `formatDiff(expected: string, actual: string, opts?: { colorize?: boolean }): string` (`lib/utils/diff.ts:347-354`).
- Produces, all used by Task 4:
  - `type CompileAttempt = { exitCode: number | null; output: string; killedBy?: "timeout" | "abort" }`
  - `type CompileVerdict = { ok: true } | { ok: false; reason: string }`
  - `function judgeCompileAttempt(expected: string, attempt: CompileAttempt): CompileVerdict`
  - `function findIncompatibleField(tests: { tests?: unknown[]; fetchMocks?: unknown[] }): string | null`

- [ ] **Step 1: Write the failing test**

Create `lib/cli/expectedCompileError.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  findIncompatibleField,
  judgeCompileAttempt,
} from "./expectedCompileError.js";

describe("judgeCompileAttempt", () => {
  test("nonzero exit whose output contains the substring passes", () => {
    const verdict = judgeCompileAttempt("AG2001", {
      exitCode: 1,
      output: "main.agency:3:5 - error AG2001: Type 'string' is not assignable",
    });
    expect(verdict.ok).toBe(true);
  });

  test("nonzero exit without the substring fails and shows both sides", () => {
    const verdict = judgeCompileAttempt("AG2001", {
      exitCode: 1,
      output: "Failed to parse Agency program: unexpected {",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("AG2001");
    expect(verdict.reason).toContain("Failed to parse");
  });

  test("a clean compile fails, naming what was expected", () => {
    const verdict = judgeCompileAttempt("AG8001", {
      exitCode: 0,
      output: "main.agency → main.js (in 12.00ms)",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("compiled");
    expect(verdict.reason).toContain("AG8001");
  });

  test("a timed-out compile fails as a timeout, not as a mismatch", () => {
    const verdict = judgeCompileAttempt("AG8001", {
      exitCode: null,
      output: "",
      killedBy: "timeout",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("timed out");
  });

  test("a suite-aborted compile fails as an abort", () => {
    const verdict = judgeCompileAttempt("AG8001", {
      exitCode: null,
      output: "",
      killedBy: "abort",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("aborted");
  });

  test("a killed compile that printed the substring still fails", () => {
    // Output produced before the kill says nothing about the exit path;
    // treating it as a pass would let a hung compile masquerade as a
    // clean refusal.
    const verdict = judgeCompileAttempt("AG8001", {
      exitCode: null,
      output: "error AG8001: unfilled holes",
      killedBy: "timeout",
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("findIncompatibleField", () => {
  test("a non-empty tests array is incompatible", () => {
    expect(findIncompatibleField({ tests: [{}] })).toBe("tests");
  });

  test("file-level fetchMocks are incompatible", () => {
    expect(findIncompatibleField({ fetchMocks: [] })).toBe("fetchMocks");
  });

  test("file-level llmMocks are incompatible", () => {
    expect(findIncompatibleField({ llmMocks: [] })).toBe("llmMocks");
  });

  test("an absent or empty tests array is fine", () => {
    expect(findIncompatibleField({})).toBe(null);
    expect(findIncompatibleField({ tests: [] })).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/cli/expectedCompileError.test.ts 2>&1 | tee /tmp/task1.txt`

Expected: FAIL — `Failed to resolve import "./expectedCompileError.js"`.

- [ ] **Step 3: Write the implementation**

Create `lib/cli/expectedCompileError.ts`:

```ts
/**
 * Deciding whether a `.test.json` with `expectedCompileError` passed.
 *
 * Kept free of I/O so every branch is testable without spawning a
 * compiler or committing a fixture that fails on purpose. The spawning
 * lives in lib/cli/test.ts; this file only judges what came back.
 */
import { formatDiff } from "@/utils/diff.js";

/** What a child `agency compile` produced. `exitCode` is null when the
 *  child was killed rather than exiting on its own. `output` is stderr
 *  and stdout concatenated: the compiler's failure paths do not agree on
 *  a stream (parse and typecheck errors go to stderr, an uncaught codegen
 *  throw is reported by node itself), and a fixture author should not
 *  have to know which one their diagnostic takes. */
export type CompileAttempt = {
  exitCode: number | null;
  output: string;
  killedBy?: "timeout" | "abort";
};

export type CompileVerdict = { ok: true } | { ok: false; reason: string };

export function judgeCompileAttempt(
  expected: string,
  attempt: CompileAttempt,
): CompileVerdict {
  // A killed child says nothing about whether the file compiles, so this
  // is reported as its own outcome rather than as a mismatch — even when
  // the expected text appears in what it printed before dying.
  if (attempt.killedBy === "timeout") {
    return {
      ok: false,
      reason: "The compile timed out, so it never reported success or failure.",
    };
  }
  if (attempt.killedBy === "abort") {
    return {
      ok: false,
      reason: "The compile was aborted with the suite before it finished.",
    };
  }
  if (attempt.exitCode === 0) {
    return {
      ok: false,
      reason: `The file compiled, but was expected to fail with: ${expected}`,
    };
  }
  if (!attempt.output.includes(expected)) {
    return {
      ok: false,
      reason:
        `The compile failed, but not with the expected message.\n` +
        formatDiff(expected, attempt.output),
    };
  }
  return { ok: true };
}

/**
 * Name the first field that cannot be combined with
 * `expectedCompileError`, or null when there is none. Nothing runs in
 * this mode, so mocks and cases are not merely unused — they mean the
 * author expected something this mode does not do, and a silent ignore
 * would hide that.
 */
export function findIncompatibleField(tests: {
  tests?: unknown[];
  fetchMocks?: unknown[];
  llmMocks?: unknown;
}): string | null {
  if (Array.isArray(tests.tests) && tests.tests.length > 0) return "tests";
  if (tests.fetchMocks !== undefined) return "fetchMocks";
  // llmMocks is a per-case field today, but a file-level one is a natural
  // thing to write; catching it here keeps this mode's "rejected, not
  // ignored" promise honest.
  if (tests.llmMocks !== undefined) return "llmMocks";
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/cli/expectedCompileError.test.ts 2>&1 | tee /tmp/task1.txt`

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must NOT be main
git add lib/cli/expectedCompileError.ts lib/cli/expectedCompileError.test.ts
git commit -m "feat: verdict function for expected-compile-error tests"
```

---

### Task 2: The CLI honors `AGENCY_ALLOW_TEST_IMPORTS`

Every compile the test runner performs sets `allowTestImports`, which honors `import test { … }` (`lib/cli/util.ts:240-243`, `lib/compiler/buildSession.ts:61-64`). The child process this feature spawns needs the same, or a fixture that uses a test import — or imports something that does — fails for an unrelated reason and still "passes," because the matcher only sees a nonzero exit and some text.

An environment variable rather than a CLI flag: that is how the runner already talks to its children (`AGENCY_LLM_MOCKS`, `AGENCY_USE_TEST_LLM_PROVIDER`, `AGENCY_COVERAGE_OUTDIR`), and this is harness plumbing that should not appear in `agency compile --help`.

This also settles the incremental-build manifest. `resolveFreshness` (`lib/compiler/buildSession.ts:101-116`) maps `allowTestImports` to `freshness: "always"`, which consults and records nothing — so a manifest entry left over from a run where the fixture *did* compile can never short-circuit the child to "1 file(s) up to date" and exit zero.

**Files:**
- Modify: `scripts/agency.ts:262-266`

**Interfaces:**
- Consumes: `CompileOptions.allowTestImports` (`lib/compiler/buildSession.ts:64`).
- Produces: the environment contract `AGENCY_ALLOW_TEST_IMPORTS=1`, which Task 4 sets on the child.

- [ ] **Step 1: Make the change**

In `scripts/agency.ts`, the `compile` command's action currently reads:

```ts
          for (const input of inputs) {
            compile(config, input, undefined, {
              ts: opts.ts,
              freshness: opts.force ? "force" : undefined,
            });
          }
```

Replace with:

```ts
          // Test-harness only, mirroring the option every other test-runner
          // compile passes (lib/cli/util.ts). Set by lib/cli/test.ts on the
          // child it spawns for `expectedCompileError` files; nothing else
          // sets it, so the default stays deny.
          const allowTestImports =
            process.env.AGENCY_ALLOW_TEST_IMPORTS === "1";
          for (const input of inputs) {
            compile(config, input, undefined, {
              ts: opts.ts,
              freshness: opts.force ? "force" : undefined,
              allowTestImports,
            });
          }
```

- [ ] **Step 2: Build**

Run: `make 2>&1 | tail -20 | tee /tmp/task2-build.txt`

Expected: build completes with no TypeScript errors.

- [ ] **Step 3: Verify by hand, both directions**

This one needs the built CLI, so it is checked with two commands rather than a unit test. Create a scratch fixture:

```bash
mkdir -p .agency-tmp/test-imports
printf 'import test { _advanceTime } from "std::date"\n\nnode main() {\n  return "ok"\n}\n' > .agency-tmp/test-imports/main.agency
```

Run without the variable:

```bash
node ./dist/scripts/agency.js compile .agency-tmp/test-imports/main.agency 2>&1 | tee /tmp/task2-deny.txt; echo "exit=$?"
```

Expected: fails, with a message about test imports not being allowed.

Run with it:

```bash
AGENCY_ALLOW_TEST_IMPORTS=1 node ./dist/scripts/agency.js compile .agency-tmp/test-imports/main.agency 2>&1 | tee /tmp/task2-allow.txt; echo "exit=$?"
```

Expected: `.agency-tmp/test-imports/main.agency → .agency-tmp/test-imports/main.js (in Nms)` and `exit=0`.

Clean up: `rm -rf .agency-tmp/test-imports`

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # must NOT be main
git add scripts/agency.ts
git commit -m "feat: agency compile honors AGENCY_ALLOW_TEST_IMPORTS for the test harness"
```

---

### Task 3: Carve these files out of the precompile pass

`precompileTestSources` compiles every collected source before any test runs, and a failure there ends the process (`lib/cli/test.ts:979-987`). Without this task, adding one deliberately-broken fixture kills the entire suite before a single test executes.

The existing exclusion for `skip: true` files is right next door and exists for the same stated reason — a skipped file "may intentionally not compile." The function gets a name that covers both reasons.

**Files:**
- Modify: `lib/cli/precompile.ts:32-43,57`
- Test: `lib/cli/precompile.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks import. The behavior is what Task 5's fixtures depend on.

- [ ] **Step 1: Write the failing test**

In `lib/cli/precompile.test.ts`, immediately after the existing test `"file-level skipped test files are excluded"` (line 65-79), add:

```ts
  test("expectedCompileError test files are excluded", () => {
    const root = writeTree({
      live: { "main.agency": TRIVIAL, "main.test.json": TEST_JSON },
      broken: {
        "main.agency": "this does not even parse {{{",
        "main.test.json": JSON.stringify({ expectedCompileError: "AG2001" }),
      },
    });
    const groups = groupTestSources({}, [
      path.join(root, "live/main.test.json"),
      path.join(root, "broken/main.test.json"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toEqual([path.join(root, "live/main.agency")]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/cli/precompile.test.ts 2>&1 | tee /tmp/task3.txt`

Expected: FAIL — the broken directory is still grouped, so `groups` has length 2.

- [ ] **Step 3: Write the implementation**

In `lib/cli/precompile.ts`, replace the function at lines 32-43:

```ts
// File-level skip mirror of runTestFile's check: a `skip: true` (or
// `skipOnCI: true` under CI) .test.json never runs, so its source must not
// be precompiled either — it may intentionally not compile. Malformed
// .test.json is treated as live; the runner will surface the real error.
function isFileLevelSkipped(testJsonFile: string): boolean {
  try {
    const tests = JSON.parse(fs.readFileSync(testJsonFile, "utf-8"));
    return tests.skip === true || (tests.skipOnCI === true && !!process.env.CI);
  } catch {
    return false;
  }
}
```

with:

```ts
// Two kinds of .test.json must not be precompiled, both because their
// source may intentionally not compile — and a failure in this pass ends
// the process before any test runs:
//   - `skip: true` (or `skipOnCI: true` under CI), mirroring runTestFile.
//   - `expectedCompileError`, whose whole point is a source that fails;
//     runTestFile compiles it in a child process instead.
// Malformed .test.json is treated as live; the runner will surface the
// real error.
function isExcludedFromPrecompile(testJsonFile: string): boolean {
  try {
    const tests = JSON.parse(fs.readFileSync(testJsonFile, "utf-8"));
    return (
      tests.skip === true ||
      (tests.skipOnCI === true && !!process.env.CI) ||
      typeof tests.expectedCompileError === "string"
    );
  } catch {
    return false;
  }
}
```

Then update the call site at line 57:

```ts
    if (isExcludedFromPrecompile(testJsonFile)) continue;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:run lib/cli/precompile.test.ts 2>&1 | tee /tmp/task3.txt`

Expected: PASS, including the pre-existing grouping tests.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must NOT be main
git add lib/cli/precompile.ts lib/cli/precompile.test.ts
git commit -m "feat: exclude expectedCompileError files from the precompile pass"
```

---

### Task 4: The runner mode

The wiring: the `Tests` type gains the field, `runTestFile` grows a branch that spawns a child compile and reports one pass or one fail.

Two ordering details that will bite if missed. First, `const total = tests.tests.length` runs at `lib/cli/test.ts:799`, *before* the file-level skip check — so a `.test.json` with no `tests` array throws a TypeError today, and the new branch has to sit above that line while the line itself learns to tolerate an absent array. Second, `isTimeoutError` (`lib/cli/test.ts:141-145`) only recognizes a timeout kill when the signal is `SIGKILL`, so the spawn must pass `killSignal: "SIGKILL"` or a timed-out compile will be misreported as an ordinary nonzero exit.

**Files:**
- Modify: `lib/cli/test.ts` — the `Tests` type (79-97), imports (1-20), `runTestFile` (786-802), plus a new helper function.

**Interfaces:**
- Consumes: `judgeCompileAttempt`, `findIncompatibleField`, `CompileAttempt` from Task 1; the `AGENCY_ALLOW_TEST_IMPORTS=1` contract from Task 2; `execFileAsync` from `./util.js`; `isTimeoutError` / `isAbortError` (`lib/cli/test.ts:141-154`); `resolveTimeoutMs(testCase, fileDefaults)` (`lib/cli/test.ts:115-122`); `TestStats` (`lib/cli/test.ts:474-481`); `SuiteContext` (`lib/cli/test.ts:158+`).
- Produces: the `expectedCompileError` field that Task 5's fixtures use.

- [ ] **Step 1: Add the imports**

At the top of `lib/cli/test.ts`, next to the existing `import { formatDiff } from "@/utils/diff.js";` (line 20), add:

```ts
import {
  findIncompatibleField,
  judgeCompileAttempt,
  type CompileAttempt,
} from "./expectedCompileError.js";
import { safeDeleteFile } from "@/utils.js";
```

`path` (line 22) and `fs` (line 4) are already imported.

- [ ] **Step 2: Extend the `Tests` type**

In `lib/cli/test.ts`, the `Tests` type begins at line 79 with `sourceFile?: string;` and `tests: TestCase[];`. Change those two lines and add the new fields:

```ts
type Tests = {
  sourceFile?: string;
  // Optional because a file with `expectedCompileError` has no cases to
  // run: the compile itself is the test.
  tests?: TestCase[];
  // When set, this file asserts that its sibling .agency FAILS to compile
  // and that the failure text contains this substring. Diagnostic codes
  // ("AG8001") are the intended values; a distinctive phrase works too,
  // which is what parse errors need since they carry no code.
  //
  // The compile runs in a child `agency compile` process. That is not an
  // implementation detail: compile() reports parse failures, strict type
  // errors, and closure failures with process.exit(1) rather than a throw
  // (lib/compiler/buildSession.ts), so compiling in-process would kill the
  // test runner. Such files are also skipped by the precompile pass
  // (lib/cli/precompile.ts) for the same reason.
  expectedCompileError?: string;
  // Printed when the file runs, same role as the per-case field.
  description?: string;
```

Leave the rest of the type as it is.

- [ ] **Step 3: Let `resolveTimeoutMs` work without a test case**

A file in this mode has no `TestCase`, only the file-level `defaultTimeoutMs`. In `lib/cli/test.ts:115-122`, change the signature and the first line of the body:

```ts
function resolveTimeoutMs(
  testCase: TestCase | undefined,
  fileDefaults: Tests,
): number {
  const requested =
    testCase?.timeoutMs ?? fileDefaults.defaultTimeoutMs ?? DEFAULT_PER_TEST_MS;
```

The rest of the function, including the clamp to `TIMEOUT_CEILINGS.perTestMs`, is unchanged, and the existing call at line 877 still typechecks.

- [ ] **Step 4: Add the spawn helper and the mode handler**

Add both functions to `lib/cli/test.ts` directly above `async function runTestFile(` (line 773):

```ts
/**
 * Compile `sourcePath` in a child `agency compile` process and report what
 * happened. Never throws for a compile failure — a failed compile is the
 * expected outcome here, so it comes back as data.
 */
async function compileInSubprocess(
  sourcePath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CompileAttempt> {
  // The CLI entry this runner is itself executing, so the child is
  // guaranteed to be the same build as the parent.
  const cliEntry = process.argv[1];
  const options = {
    cwd: path.dirname(sourcePath),
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    // isTimeoutError only recognizes a timeout kill by SIGKILL.
    killSignal: "SIGKILL" as const,
    signal,
    env: { ...process.env, AGENCY_ALLOW_TEST_IMPORTS: "1" },
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliEntry, "compile", sourcePath],
      options,
    );
    return { exitCode: 0, output: `${stderr}${stdout}` };
  } catch (e) {
    // Abort before timeout, mirroring the per-case path (runSingleTest):
    // both kills use SIGKILL here, and the abort shape is the more
    // specific claim.
    if (isAbortError(e)) {
      return { exitCode: null, output: "", killedBy: "abort" };
    }
    if (isTimeoutError(e)) {
      return { exitCode: null, output: "", killedBy: "timeout" };
    }
    const err = e as { code?: unknown; stdout?: string; stderr?: string };
    // An error with no captured streams never ran a compile — a missing
    // CLI entry, a bad cwd. Reporting it as a compile attempt would let a
    // broken harness masquerade as a failing fixture.
    if (err.stdout === undefined && err.stderr === undefined) {
      throw e;
    }
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      output: `${err.stderr ?? ""}${err.stdout ?? ""}`,
    };
  }
}

/**
 * Run a `.test.json` whose `expectedCompileError` is set. The file counts
 * as exactly one test so suite totals and sharding stay honest.
 */
async function runExpectedCompileError(
  tests: Tests,
  testFile: string,
  suite: SuiteContext,
  log: (msg: string) => void,
): Promise<TestStats> {
  const expected = tests.expectedCompileError!;
  const sourcePath = testFile.replace(/\.test\.json$/, ".agency");
  const siblingJs = sourcePath.replace(/\.agency$/, ".js");

  log(color.cyan(`Expecting compile to fail with: ${expected}`));
  if (tests.description) {
    log(color.cyan("Description:", tests.description) + "\n");
  }

  const fail = (reason: string): TestStats => {
    log(color.red(`  ✗ ${reason}`));
    return {
      passed: 0,
      failed: 1,
      filesPassed: 0,
      filesFailed: 1,
      failedFiles: [testFile],
      slowTests: [],
    };
  };

  const incompatible = findIncompatibleField(tests);
  if (incompatible) {
    // Returned normally, so the file belongs in `completed` (the
    // suite-abort summary's definition, SuiteContext) even though it
    // never compiled anything.
    suite.completed.push(testFile);
    return fail(
      `'${incompatible}' cannot be combined with 'expectedCompileError': ` +
        `nothing runs in this mode, only the compile.`,
    );
  }

  // Any .js here is from an earlier run, and these sources exist to be
  // broken — preferCompiled (lib/cli/util.ts) would happily execute one.
  // safeDeleteFile no-ops quietly when there is nothing to delete.
  safeDeleteFile(siblingJs, false);
  const attempt = await compileInSubprocess(
    sourcePath,
    resolveTimeoutMs(undefined, tests),
    suite.abortController.signal,
  );
  safeDeleteFile(siblingJs, false);

  // Matches the per-case path: a file that ran to a verdict is completed,
  // pass or fail. Only an abort leaves it off the list.
  if (attempt.killedBy !== "abort") suite.completed.push(testFile);

  const verdict = judgeCompileAttempt(expected, attempt);
  if (!verdict.ok) return fail(verdict.reason);

  log(color.green(`  ✓ Compile failed as expected`));
  return {
    passed: 1,
    failed: 0,
    filesPassed: 1,
    filesFailed: 0,
    failedFiles: [],
    slowTests: [],
  };
}
```

- [ ] **Step 5: Wire the branch into `runTestFile`**

In `runTestFile`, the code at lines 797-799 currently reads:

```ts
    let passed = 0;
    const total = tests.tests.length;
```

Replace with:

```ts
    let passed = 0;
    const cases = tests.tests ?? [];
    const total = cases.length;
```

The one binding covers both the absent-array TypeError and every later use — no optional chaining, no non-null assertions. Update the two later uses of `tests.tests` in the function to `cases`: the loop bound already uses `total`, and the indexed access at line 831 becomes `cases[i]`.

Then, *after* the file-level skip early-return (the `if (tests.skip || ...)` block ending around line 817) and before `let skipped = 0`, insert the mode branch:

```ts
    // After the skip check — a skipped file is skipped no matter what
    // else it declares — and before any per-case machinery, because a
    // file in this mode has no cases: the compile is the test.
    if (tests.expectedCompileError !== undefined) {
      return await runExpectedCompileError(tests, testFile, suite, log);
    }
```

Ordering matters here: the spec says `skip`/`skipOnCI` keep their existing meaning, so skip must win over `expectedCompileError`. (For such a file the skip message prints "Skipped 0 test(s)" — accurate, since it has no cases.)

- [ ] **Step 6: Typecheck and build**

Run: `pnpm run typecheck 2>&1 | tee /tmp/task4-tsc.txt && make 2>&1 | tail -5`

Expected: no errors from either.

- [ ] **Step 7: Confirm nothing regressed in the runner's own unit tests**

Run: `pnpm test:run lib/cli 2>&1 | tee /tmp/task4-unit.txt`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must NOT be main
git add lib/cli/test.ts
git commit -m "feat: expectedCompileError mode in the agency test runner"
```

---

### Task 5: The fixtures, end to end

Two fixtures, covering the two failure shapes that matter. The parse-failure one is the proof of the whole design: under any in-process approach it would end the process instead of failing a test. The type-error one proves that matching a diagnostic *code* works, which is the shape every future `AG8002`-style consumer will use.

They live in their own directory, for two reasons. The dir-local `agency.json` would otherwise form its own precompile group, and `compileGroups` throws when groups with differing configs share a module (`lib/compiler/buildSession.ts:196-213`). And the whole directory is what goes into `coverage.exclude` — `agency test --coverage` maps each `.test.json` to its sibling and compiles it for a source map (`lib/cli/coverage.ts:76-98`), where a parse failure would `process.exit(1)` and kill the report. `agency.json` already excludes `tests/agency/topsort/cycles/**` for exactly this reason.

**Files:**
- Create: `tests/agency/expectedCompileError/agency.json`
- Create: `tests/agency/expectedCompileError/parseFailure.agency`, `parseFailure.test.json`
- Create: `tests/agency/expectedCompileError/typeError.agency`, `typeError.test.json`
- Modify: `agency.json` (repo `coverage.exclude`)

**Interfaces:**
- Consumes: the `expectedCompileError` field from Task 4, the precompile exclusion from Task 3, the env-var contract from Task 2.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Write the fixtures**

`tests/agency/expectedCompileError/agency.json` — the child's `compile` command reads exactly `process.cwd()/agency.json` (`loadConfig`, `lib/cli/commands.ts:95-100`) — no walk-up, and a missing file means an **empty** config (`loadConfigSafe`, `lib/config.ts:512-514`), not the repo root's. The child's cwd is this directory, so this file is the entire config and must be complete on its own:

```json
{
  "typechecker": {
    "enabled": true,
    "strict": true
  }
}
```

`tests/agency/expectedCompileError/parseFailure.agency`:

```
node main() {
  return "unterminated
}
```

`tests/agency/expectedCompileError/parseFailure.test.json`:

```json
{
  "expectedCompileError": "Failed to parse Agency program",
  "description": "A file that cannot be parsed reports as one failing compile, and does not end the suite"
}
```

`tests/agency/expectedCompileError/typeError.agency`:

```
node main(): string {
  const n: number = "not a number"
  return n
}
```

`tests/agency/expectedCompileError/typeError.test.json` — the code goes in at Step 3, once the compiler has told you which one it is:

```json
{
  "expectedCompileError": "AG0000",
  "description": "A type error under strict mode reports as one failing compile, matched by diagnostic code"
}
```

- [ ] **Step 2: Build**

Run: `make 2>&1 | tail -5`

Expected: build completes.

- [ ] **Step 3: Find the real diagnostic code**

Run the child command by hand, exactly as the runner will:

```bash
cd tests/agency/expectedCompileError && AGENCY_ALLOW_TEST_IMPORTS=1 node ../../../dist/scripts/agency.js compile typeError.agency 2>&1 | tee /tmp/task5-code.txt; echo "exit=$?"; cd -
```

Expected: a nonzero exit and a line of the form `typeError.agency:2:9 - error AG2001: Type 'string' is not assignable to type 'number' …`.

Read the actual code out of `/tmp/task5-code.txt` and put it in `typeError.test.json` in place of `AG0000`. Do not guess it — `AG2001` and `AG2005` are both plausible for this shape and only the compiler settles it.

- [ ] **Step 4: Run both fixtures**

Run: `pnpm run a test tests/agency/expectedCompileError 2>&1 | tee /tmp/task5-run.txt`

Expected: `2/2 tests passed`, with two green `✓ Compile failed as expected` lines, and no stray `.js` files left behind (`ls tests/agency/expectedCompileError` shows only the five source files).

- [ ] **Step 5: Prove the wrong-way-round case by hand**

Temporarily change `parseFailure.test.json`'s `expectedCompileError` to `"AG9999"` and re-run:

Run: `pnpm run a test tests/agency/expectedCompileError 2>&1 | tee /tmp/task5-negative.txt`

Expected: `1/2 tests passed`, the failing file reported with a diff showing `AG9999` against the real parse message — and, critically, a normal summary rather than a killed process. Then put the original value back and re-run Step 4 to confirm it is green again.

- [ ] **Step 6: Exclude the directory from coverage**

In the repo's `agency.json`, the `coverage.exclude` array currently reads:

```json
  "coverage": {
    "exclude": [
      "tests/agency/topsort/cycles/**"
    ]
  }
```

Change it to:

```json
  "coverage": {
    "exclude": [
      "tests/agency/topsort/cycles/**",
      "tests/agency/expectedCompileError/**"
    ]
  }
```

- [ ] **Step 7: Verify the coverage path survives**

Run: `pnpm run a test tests/agency/expectedCompileError --coverage 2>&1 | tail -30 | tee /tmp/task5-coverage.txt`

Expected: the two tests pass and the command exits normally with a coverage summary (which will report no data for this directory). Without the exclude, the parse-failure fixture would end the process during the report.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must NOT be main
git add tests/agency/expectedCompileError agency.json
git commit -m "test: end-to-end fixtures for expectedCompileError"
```

---

### Task 6: Document the field

`docs/misc/TESTING.md` is the testing guide CLAUDE.md points at, and it lists every `.test.json` field. A field that isn't there is a field nobody finds.

**Files:**
- Modify: `docs/misc/TESTING.md:152-158`

**Interfaces:**
- Consumes: the behavior built in Tasks 1-5.
- Produces: nothing.

- [ ] **Step 1: Extend the file-level field list**

In `docs/misc/TESTING.md`, the "File-level fields (siblings of `tests`)" list ends with the `defaultTimeoutMs` bullet. Add after it:

```markdown
- `expectedCompileError` (optional) — assert that the sibling `.agency` file **fails to compile**, and that the failure text contains this substring. A file that sets it has no `tests` array: the compile is the test. See below.
```

- [ ] **Step 2: Add the explanatory section**

Immediately after the "File-level fields" list and before the `### Evaluation criteria` heading, add:

````markdown
### Expected compile errors

Some things are supposed to be rejected at compile time — a program with an
unfilled template hole, a type error you want pinned by its diagnostic code.
A `.test.json` can assert that:

```json
{
  "expectedCompileError": "AG2001",
  "description": "A string cannot be assigned to a number"
}
```

The test passes when compiling the sibling `.agency` file fails **and** the
failure text contains the substring. Substring rather than exact match,
because compiler output carries absolute paths and line numbers that differ
by machine; the diagnostic code is the stable part. Parse errors carry no
code, so those tests pin a phrase from the message instead
(`"Failed to parse Agency program"`).

Two things to know:

- The compile runs in a child `agency compile` process whose working
  directory is the fixture's own directory, and the CLI reads its config
  from exactly there: `<fixture dir>/agency.json`, used as-is — not merged
  over the project config the way the rest of the runner does it, and not
  inherited from the repo root. A fixture directory without its own
  `agency.json` compiles with an **empty** config (typechecker off), so
  every fixture directory in this mode ships a complete `agency.json`.
  Type-error fixtures need `typechecker.strict`, and the diagnostic must
  be error severity — strict mode only refuses to compile on errors, not
  warnings.
- These files are skipped by the up-front precompile pass, which is what
  lets a deliberately-broken source sit in the tree without ending the run.
  Keep them in a directory of their own, and add that directory to
  `coverage.exclude` in `agency.json` so `--coverage` does not try to
  compile them for a source map.

`llmMocks`, `fetchMocks`, and a non-empty `tests` array are rejected rather
than ignored — nothing runs in this mode, so their presence means the test
was expected to do something it does not do.
````

- [ ] **Step 3: Commit**

```bash
git branch --show-current   # must NOT be main
git add docs/misc/TESTING.md
git commit -m "docs: expectedCompileError in the testing guide"
```

---

## Before opening the PR

- [ ] Read `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md`, then check `git diff main...HEAD` against them. Pay attention to comments that restate their code — delete those.
- [ ] Run `pnpm run lint:structure 2>&1 | tee /tmp/lint.txt`. Expected: clean.
- [ ] Run `pnpm run typecheck 2>&1 | tee /tmp/tsc.txt`. Expected: clean.
- [ ] Run `pnpm test:run lib/cli 2>&1 | tee /tmp/unit.txt`. Expected: PASS.
- [ ] Run `pnpm run a test tests/agency/expectedCompileError 2>&1 | tee /tmp/fixtures.txt`. Expected: 2/2.
- [ ] Confirm no `.js` files were left in `tests/agency/expectedCompileError/`.
- [ ] Write the commit message and PR description in files and pass them with `-F`; apostrophes typed directly on the command line break the shell.
