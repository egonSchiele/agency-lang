# std::agency `test()` and the eval AgencyTestGrader

Date: 2026-08-20. Status: designed, not yet planned.

## Background

The eval suite for the bundled agency agent (`evals/agency-agent/`) grades
coding tests by running the agent's code. The fib test
(`evals/agency-agent/fib/`) is the reference: the agent writes `fib.agency`,
and a grader checks it by running agency tests against it. Today that takes
three hand-written layers per test:

1. `graders.ts` — a TypeScript `BaseGrader` subclass that makes a scratch
   directory, copies the solution out of the run's workdir, lays down a fresh
   harness, and spawns `agency test`.
2. `fib-harness.agency` — an Agency program that reads the solution as a
   string, appends a driver node by string concatenation, compiles it with
   `std::agency`, and runs each assertion through `run()` inside a
   hand-written reject-everything handler.
3. `fib-harness.test.json` — the agency-test JSON that runs the harness.

The reason the agent writes Agency rather than Python: Agency is the one
language where running untrusted code locally is safe without a container.
`std::agency`'s `compile()` restricts what the code can import, and `run()`
executes it in a subprocess whose every interrupt is voted on by the parent's
handlers — any handler's reject wins, so a parent that rejects everything
vetoes every effect, including the code's own inline `with approve`.

`docs/dev/eval-grading.md` already says the fib pattern should be promoted to
framework surface "when a second coding test wants the same grader". This
spec does that promotion, and adds the missing primitive underneath it: a
`test()` function in `std::agency` that runs agency tests the way `run()`
runs a node — programmatically, in the sandbox, with the parent's handlers in
charge.

## Goals

- A stdlib way to run agency tests against Agency code, with the same safety
  story as `run()`: every effect the tested code (or the test harness itself)
  raises is gated by the caller's handlers.
- Eval coding tests become declarative: a test directory ships test files and
  nothing else — no per-test `graders.ts`, no hand-written sandbox handler.
- Held-out tests: a set the agent never sees, so solutions must generalize.
- Open up imports for sandboxed code, module-wide, without weakening the
  safety guarantee (details below — this fell out of the design and is a
  deliberate scope addition).

## Non-goals

- Full parity with the `agency test` CLI runner. `llmMocks`, `fetchMocks`,
  `fakeClock`, `argv`, `expectedCompileError`, `retry`, `llmJudge` criteria,
  and the `modify` interrupt action are out of scope for v1; `testFile()`
  refuses files that use them (loudly, never by ignoring the field).
- Replacing the CLI runner. `agency test` tests *your* code (arbitrary
  imports, interrupts answered authoritatively); `test()` tests *someone
  else's* (sandboxed, handler-gated). Those are two trust postures, not two
  implementations of one thing. What they must share is the JSON schema and
  the pass/fail verdict logic, each with a single TypeScript owner, so a test
  cannot pass under one runner and fail under the other on the same output.
  If the subset ever grows to parity and one execution engine is wanted, the
  migration is the CLI runner adopting the IPC subprocess runner with a
  trusted mode — a separate project this design must not block or assume.
- A new config format. The typed `TestCase[]` parameter of `test()` IS the
  "config in Agency" experience (autocomplete, static checking, real values
  instead of escaped strings); the `.test.json` file stays the portable wire
  format. No third format.

## The safety invariant, and opening up imports

The sandbox guarantee rests on exactly one thing: **the transitive compile
closure contains nothing but Agency source and `std::` imports.** TypeScript
or JavaScript anywhere in the closure means destructive code with no
interrupt. Everything else — which directories the files sit in, whether a
package is involved — is policy, not safety.

Today `compile()`/`runFile()` enforce a much narrower rule (only `std::`
imports, nothing else at all), which makes the natural test-authoring shape
impossible: a harness cannot `import { fib } from "fib.agency"`. Decision:
open imports up, module-wide, and enforce the actual invariant instead.

**New rule, applied uniformly to `compile`, `runCode`, `runFile`, and
`test`/`testFile`:** imports may name `std::` modules, relative or absolute
`.agency` file paths, and `pkg::` packages. A **closure validator** — one
new, single-purpose check in the compile path — walks the transitive import
closure and refuses, naming the file and the offending import:

- any TypeScript/JavaScript file (interop by the back door),
- any node builtin (`process`, `fs`, `child_process`, ...),
- any `pkg::` package whose own closure reaches either of the above,
- any compile-time splice (`$( ... )`) anywhere in the closure. Splices
  execute code at compile time in the compiling process, outside the sandbox;
  untrusted code gets no compile-time execution hook regardless of imports.

Everything that passes the validator compiles under the same discipline as
the root file, so every effect it can produce is interrupt-gated, and the
parent-veto story is unchanged. Static initializers included: the subprocess
routes their interrupts through the parent's chain like everything else
(verified empirically during the fib work).

`compile(source)` and `runCode(source)` take strings, which have no anchor to
resolve `"./fib.agency"` against. Both grow an **optional `dir` parameter**:
absent, relative imports simply cannot resolve (today's behavior); present,
it is the base directory for relative imports. File-based entry points
(`runFile`, `test`, `testFile`) anchor at their own directory.

**Verification task for the planner:** confirm what `_compile` does today
with a splice in the source (the AG8001/AG8002 refusal machinery exists for
template Agency; the untrusted-compile path must be shown to refuse splices,
with a test that would fail if it didn't). This is load-bearing for the
whole design.

Deliberately NOT built: per-directory confinement, allow/deny lists, any
policy knob about which roots are importable. The validator owns the
invariant; there are no other rules to maintain. Out-of-dir imports cost
hermeticity (a harness importing a file outside the test directory grades
differently on different machines) — for eval grading that is mitigated
structurally, because the grader runs everything from a scratch directory it
populated itself, so anything not in the workdir or the graders snapshot is
simply absent.

## The authoring model

The unit under test is a directory of `.agency` files. Three roles:

1. **Solution** — what the agent (or user) wrote, e.g. `fib.agency` with
   `export def fib(n: number): number`. Can be several files importing each
   other.
2. **Harness** — an ordinary Agency test file, written the way every agency
   test in this repo is written: it imports the solution and exports one node
   per test case.

   ```ts
   import { fib } from "fib.agency"

   export node testFive(): number {
     return fib(5)
   }
   ```

3. **Test JSON** — the same `.test.json` format `agency test` runs, naming
   the harness nodes and their expected outputs.

   ```json
   {
     "sourceFile": "fib-tests.agency",
     "tests": [
       {
         "nodeName": "testFive",
         "input": "",
         "expectedOutput": "5",
         "evaluationCriteria": [{ "type": "exact" }]
       }
     ]
   }
   ```

There is no driver synthesis and no string concatenation: the harness IS the
driver layer, and the import boundary is honest — the harness sees only what
the solution exports, and "the solution does not export `fib`" is a compile
failure with a precise message, which is itself part of what is being tested.

The whole harness runs **inside** the sandbox (unlike today's fib harness,
which runs in the parent and calls `run()` itself). Harness bugs cannot
accidentally execute outside the sandbox, and the harness needs no sandbox
code of its own.

## API: new exports in `stdlib/agency.agency`

### Types

```ts
export type TestCase = {
  // Exported node in the harness file to run.
  node: string;
  // Real values, not strings: named args for the node, and the expected
  // return value, compared structurally (key order insensitive).
  args?: Record<string, any>;
  expected: any;
  // Scripted answers for interrupts raised while this case runs, consumed
  // in order. Each is ONE VOTE in the normal handler chain: every parent
  // handler still sees the interrupt, and any reject wins. A test file can
  // never approve something the caller's handler would reject.
  interrupts?: InterruptAnswer[];
  description?: string;
}

export type InterruptAnswer = {
  action: "approve" | "reject";
  // For approve: the value the interrupt resolves to (approve(value)).
  value?: any;
  // When set, the case fails if the interrupt's message differs.
  expectedMessage?: string;
}

export type CaseResult = {
  node: string;
  pass: boolean;
  // Empty on pass. On failure: the structural diff, or the run failure
  // (rejection message, limit_exceeded detail, "no node named X", ...).
  feedback: string;
}

export type TestReport = {
  pass: boolean;      // every case passed
  cases: CaseResult[];
}
```

### Functions

```ts
// Core. dir/filename name the harness file; the harness imports the
// solution like any agency test does.
export def test(
  dir: string,
  filename: string,
  cases: TestCase[],
  wallClock: number = 60s,      // per case
  memory: number = 512mb,       // per case
  ipcPayload: number = 100mb,   // per case
  stdout: number = 1mb,         // per case
  maxCost: number | null = null // for the WHOLE call, not per case
): Result<TestReport>

// Wrapper: reads the portable .test.json format and delegates to test().
export def testFile(dir: string, filename: string): Result<TestReport>
```

Result semantics — the line between the two failure levels:

- **`failure` = couldn't test.** Harness compile failure (including closure
  validator refusals and "solution doesn't export X"), malformed or
  unsupported `.test.json`, the whole-call cost guard tripping. Fix the
  input and call again.
- **`success` with `pass: false` entries = tested, and it's wrong.** Wrong
  values, rejected interrupts, per-case limits, scripted-answer mismatches.
  A failing case never stops the batch; the report carries every case's
  verdict.

Effects: `testFile` raises `std::read` for the JSON and the harness file
(canonical `{ dir, filename }` payload); each case's subprocess launch raises
`std::run` exactly as `run()` does. No new effect labels in v1.

### `testFile` JSON mapping

`sourceFile` resolves relative to `dir`; default is the sibling `.agency`
with the same basename (matching the CLI runner). Field mapping:

| JSON | TestCase |
|---|---|
| `nodeName` | `node` |
| `input` (argument-literal string) | `args` |
| `expectedOutput` (JSON string) | `expected` (parsed) |
| `interruptHandlers` | `interrupts` |
| `timeoutMs` | that case's `wallClock` |
| `description` | `description` |

`expectedOutput` must parse as JSON; the error for a bare unquoted string
says how to quote it. Unsupported fields (`llmMocks`, `fetchMocks`,
`fakeClock`, `retry`, `skip`/`skipOnCI`, `expectedCompileError`, `llmJudge`
criteria, `modify` actions) are refused with an error naming the field — a
silently ignored mock would make a test pass for the wrong reason. An empty
`tests` array is an error (mirrors `loadInputs`' empty-suite rule).

## Execution semantics

**One compile per call.** The harness file is compiled once (closure
validator over the whole import tree — harness plus solution plus anything
they import); every case runs against that one `CompiledProgram`.

**Cases run sequentially**, each in its own `run()` subprocess. Deterministic
ordering is what makes scripted answers meaningful.

**The scripted-answer handler.** Each case's `run()` call is wrapped in one
stdlib handler:

- The call's own sandbox launch (`std::run` carrying this compile's
  `moduleId`) → `approve()`. The parent still sees it and can veto (the
  any-reject rule guarantees that); the internal approval just means a bare
  `test()` call with no parent handler does not prompt once per case.
- Any other interrupt → consume the case's next `InterruptAnswer`:
  `approve(value)` or `reject`. If `expectedMessage` is set and does not
  match, the answer rejects and the case fails with the mismatch as
  feedback.
- Answers exhausted → the handler stays silent, so the interrupt propagates
  outward per the normal rules (to parent handlers, then the user, then a
  headless crash). Nothing is approved by omission.
- Case ends with unconsumed answers → the case fails ("expected N
  interrupts, saw M"). Scripted answers are assertions about behavior, not
  just permissions.

**Verdict.** Structural equality on canonicalized values, implemented as a
TypeScript helper in `stdlib-lib` — the shared owner from the convergence
decision, placed where `lib/cli/test.ts` can adopt the same helper later.
Failure feedback is a rendered expected/actual diff, or the run failure text
when the case died rather than returned.

**Budget.** Per-case limits forward to each `run()`. `maxCost` wraps the
whole case loop in `guard(cost:)` — the same pattern `run()` itself uses — so
N cases cannot multiply the budget by N. The guard tripping is a whole-call
`failure` in the same `limit_exceeded` shape as `run()`'s other limits.

## Eval framework: the AgencyTestGrader

### Conventions in an eval test directory

- `files/*.test.json` (+ harness `.agency` beside each) — **visible tests**.
  Seeded into the agent's workdir like everything in `files/`, so the agent
  self-checks with the exact same `agency test fib-tests.test.json` it will
  be graded by. Graded too.
- `holdout/*.test.json` (+ harness beside each) — **held-out tests**. Same
  format, same mechanics, never seeded; the agent never sees them. This is
  the generalization check: a solution written to the visible tests fails
  here, and the reward-hacking failure mode the optimizer work surfaced
  (agents writing to the visible test) becomes a visible score split.

Each `.test.json` in either set becomes one framework-attached grader and
one score row, named by basename (`fib-tests`, `fib-holdout`). A basename
collision between the two sets is refused at `eval run` preflight, naming
both files. `fib-tests` passing while `fib-holdout` fails is the overfitting
signature, visible in `runs list` and usable by optimizers. Both sets carry
`mustPass: true` — the split is about information, not leniency.

Auto-discovered graders count as the *test's own* graders in the existing
precedence chain (flag > snapshot > test's own > config > goal judge), so an
explicit `--graders` still overrides, and they coexist with a test's `goal`
the way any test-owned graders do.

### Snapshot story (unchanged in kind)

Harness `.agency` + `.test.json` pairs are the grader's `externalFiles()`,
so `eval run` stores them in `<runDir>/graders/` by content hash and grading
a copied run directory uses the stored copies — the existing mechanism.
Every harness JSON is validated at `eval run` preflight (parse, supported
fields), matching the "broken graders fail before any agent runs" rule.
Consequence worth knowing: holdout files travel inside run directories, so
the secrecy boundary is "during the agent's run", not forever; a suite
author republishing run directories publicly ships the holdouts with them.

### What one grading pass does (per `.test.json`)

1. Make a scratch directory under `process.cwd()` (compiled Agency resolves
   `agency-lang` from the directory it runs in — never `os.tmpdir()`).
2. Copy the run's **workdir wholesale** — with open imports the solution may
   be several files and only the agent knows which — then overwrite the
   harness `.agency` and `.test.json` with fresh copies from the graders
   snapshot. That is the whole tamper defense: everything the agent wrote is
   testable input; everything that judges comes from the snapshot.
3. Spawn the framework-owned Agency **wrapper** via `agency run`
   (`process.execPath` + `process.argv[1]`; grading always runs inside the
   agency CLI). The wrapper takes the scratch dir and the JSON filename,
   calls `testFile()` inside a reject-all handler — approve `std::run` and
   the two known `std::read`s, reject every other effect with a message
   naming it — and prints the `TestReport` as JSON on stdout. The wrapper is
   the only sandbox-policy owner; it ships with the framework, never with
   suites. The stdlib `test()`/`testFile()` machinery does all test-shaped
   work; `agency test` (the CLI runner) is not involved in grading.
4. Score = **fraction of cases passed** (richer signal for optimizers than
   binary), `mustPass: true`. Feedback = the failing cases' feedback lines;
   a `failure` from `testFile` (e.g. compile error) is score 0 with the
   error verbatim; wrapper crash/timeout/unparseable stdout is score 0 with
   the output tail. No workdir on the run → score 0, "run left no workdir".

The spawn exists for one reason: the veto chain is made of Agency handlers,
and the grading process is TypeScript. One thin Agency parent holds the
handler; everything else is the stdlib function.

### What this deletes

`evals/agency-agent/fib/graders.ts` and the sandbox scaffolding in
`fib-harness.agency`. The fib test becomes `files/fib-tests.agency` (imports
`fib.agency`, one exported node per case — no `compile`/`run`/handler code)
plus `files/fib-tests.test.json`, plus a new `holdout/` pair. This migration
is the end-to-end acceptance test for the feature.

## The local-machine guardrail, end to end

The question this design must answer: "if I run `eval grade` on my laptop,
what stops agent-written code — or a hostile test suite — from deleting my
home directory?" The chain:

1. The tested code can only produce effects through interrupts (closure
   validator: nothing in the compile closure escapes to TS/node).
2. Every interrupt from the subprocess is voted on by the wrapper's
   reject-all handler, and any reject wins — including over the code's own
   `with approve` and over scripted answers in a hostile `.test.json`
   (one-vote rule).
3. The wrapper is framework code the user already trusts by running the CLI;
   suites cannot substitute it (the harness and solution both run *inside*
   the sandbox the wrapper polices).
4. The only approvals in the chain are the sandbox launch itself and the two
   known harness-file reads.

## Testing

**Stdlib execution tests (`tests/agency/`, no LLM)** — the bulk:

- passing / failing cases, diff feedback, batch continues past a failure
- compile failure (including "solution doesn't export X")
- **parent veto**: a reject-all handler around `test()` rejects an effect
  the solution raises — the load-bearing safety test
- scripted answers: approve with value; reject; `expectedMessage` mismatch;
  leftover answers fail the case; exhausted answers propagate to an outer
  handler
- a two-file solution with a local import
- closure-validator refusals: a TS import, a node builtin, a splice
- per-case timeout → case-level `limit_exceeded` feedback
- `testFile`: JSON mapping, `sourceFile` defaulting, one refusal test per
  unsupported field, empty `tests`, unparseable `expectedOutput`

**TS unit tests (vitest):** closure validator (its own file, one concept),
shared verdict/diff helper, JSON schema parser.

**Eval framework (vitest):** grader auto-discovery (`files/` + `holdout/`),
holdout not seeded (a seeding test on `runAgent`), basename-collision
refusal at preflight, tamper defense (agent-edited harness overwritten from
snapshot), fraction scoring + `mustPass`, snapshot rebind (grade a copied
run directory).

**End to end:** the fib migration above, exercised by CI's eval coverage.

## Documentation

- New `docs/dev/std-agency-test.md`: the contract, the closure-validator
  invariant, the one-vote scripted-answer rule, wrapper/tamper-defense
  mechanics, holdout, and the CLI-runner convergence stance (shared schema +
  verdict; execution deliberately split by trust posture).
- Update `docs/dev/eval-grading.md`'s coding-test section: the suite-local
  pattern is now framework surface.
- CLAUDE.md pointers for both. Site docs (`docs/site/**`) stay owner-side.

## Decisions log (from the brainstorm)

- v1 scope: minimal, evals-first; sandbox-safe subset of the test format.
- Input shape: typed core + JSON file wrapper; no separate Agency config
  format (the typed parameter is that experience).
- Scripted answers are one vote; parents can veto (same story as `run()`).
- Eval integration: framework-owned grader, convention-based discovery.
- Sandbox stance: reject-all, no escape hatch in v1.
- Imports: opened module-wide to anything whose closure is pure Agency +
  `std::`; the closure validator owns the invariant; no confinement or
  policy knobs. Chosen explicitly to minimize current and future machinery.
- One eval test directory = one agent run; multiple `.test.json` files =
  multiple named grader scores, never multiple eval directories.
- Held-out tests live in `holdout/` (the name carries the rule; `tests/` is
  overloaded and doesn't distinguish the sets).
