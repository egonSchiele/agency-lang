# std::agency `test()` and the eval AgencyTestGrader

Date: 2026-08-20. Status: designed, revised per review (v2, v3), not yet
planned.

v3 addresses the re-review's six findings: compilation consumes the exact
validated closure snapshot instead of re-reading files (re-review finding 1),
the synthesized grader module gets a stable logical identity whose revision
covers the harness files (2), the wrapper writes a tagged envelope so
`failure` survives the transport (3), the local-machine guarantee is
explicitly scoped to Agency code and excludes sibling `graders.ts` (4),
`input` binding follows the language's real arity rules (5), and the new
`dir` anchors on `compile`/`runCode` have exact signatures (6).

v2 addresses all nine findings in
`2026-08-20-std-agency-test-design-REVIEW.md`: dir-confined imports replace
the unconfined policy (finding 1), splice refusal is ordered before splice
expansion by design (2), per-case limits join the case type (3), the eval
grader gates with `threshold: 1` (4), the CLI migrates to the shared parser
and verdict in this change (5), the `input` conversion has an algorithm and
the field ledger is complete (6), grader discovery synthesizes a grading
module (7), the wrapper reports through a file, not stdout (8), and approving
scripted answers are refused at eval preflight (9).

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
- Sandboxed code may span several files: a harness imports the solution, the
  solution imports its own helpers. This requires loosening the current
  std::-only import rule; how far it loosens is defined below.

## Non-goals

- Full parity with the `agency test` CLI runner. The sandbox profile of the
  format (defined below) supports a deliberate subset; everything else is
  refused loudly, never ignored.
- Replacing the CLI runner's execution path. `agency test` tests *your* code
  (arbitrary imports, interrupts answered authoritatively); `test()` tests
  *someone else's* (sandboxed, handler-gated). Those are two trust postures.
  What they share — in this change, not "later" — is one test-file parser and
  one exact-match verdict helper (details in "One parser, one verdict").
  If the subset ever grows to parity and one execution engine is wanted, the
  migration is the CLI runner adopting the IPC subprocess runner with a
  trusted mode — a separate project this design must not block or assume.
- A new config format. The typed `TestCase[]` parameter of `test()` IS the
  "config in Agency" experience (autocomplete, static checking, real values
  instead of escaped strings); the `.test.json` file stays the portable wire
  format. No third format.

## The safety invariant and the import policy

Two separate things, deliberately kept apart:

**The safety invariant** — what makes sandboxed execution safe at all: the
transitive compile closure contains nothing but Agency source and `std::`
imports. TypeScript or JavaScript anywhere in the closure means destructive
code with no interrupt. A **closure validator** owns this invariant for every
sandboxed compile (`compile`, `runCode`, `runFile`, `test`, `testFile`). It
walks the transitive import closure and refuses, naming the file and the
offending import:

- any TypeScript/JavaScript file (interop by the back door),
- any node builtin (`process`, `fs`, `child_process`, ...),
- any `pkg::` package whose own closure reaches either of the above,
- any compile-time splice (`$( ... )`) anywhere in the closure (ordering
  rules below).

Everything that passes compiles under the same discipline as the root file,
so every effect it can produce is interrupt-gated. Static initializers
included: the subprocess routes their interrupts through the parent's chain
like everything else (verified empirically during the fib work).

**The import policy** — which files may be in the closure. v1 of this spec
allowed any relative or absolute `.agency` path and claimed the eval grader's
scratch directory made outside files "simply absent". The review showed that
claim false: imports resolve against the host filesystem in the compiling
process, so `../../secret.agency` and absolute paths escape the scratch
directory, those reads happen with no `std::read` interrupt the wrapper could
veto, and results vary by machine. The revised policy:

- **`std::` modules**: always allowed.
- **Local `.agency` files, confined to the sandbox directory**: allowed when
  the compile has a `dir` anchor. Every non-stdlib, non-pkg module in the
  closure must resolve — after `fs.realpath` on the resolved file, so a
  symlink cannot point out — to a path inside the realpath of `dir`
  (subdirectories included). `..` segments and absolute paths that land
  inside `dir` are therefore fine; anything resolving outside is refused
  with the file and the escaping import named.
- **`pkg::` packages**: allowed, subject to the closure validator walking
  the package's own Agency closure under the same rules (the package's
  files live in `node_modules`, outside `dir`; the confinement boundary for
  a package is its own package root). A suite using `pkg::` grades only on
  machines where the package is installed — an accepted, documented
  hermeticity trade for `pkg::` specifically, not a general one.

`compile(source)` and `runCode(source)` take strings, which have no anchor.
Both grow an optional `dir` parameter — exact signatures, appended as
trailing optional parameters so every existing call site keeps working:

```ts
export def compile(source: string, dir: string = ""): Result
export def runCode(source, node, args, wallClock, memory, ipcPayload,
                   stdout, maxCost, cwd, dir: string = ""): Result
```

`dir` is **compile-only**: the base directory relative imports resolve
against and the confinement boundary for the closure. `runCode`'s existing
`cwd` is **execution-only**: the subprocess's working directory. The two are
independent (compile from the seeded files, run in a scratch dir, or vice
versa); passing neither keeps today's behavior. Absent `dir`, only `std::`
and `pkg::` are importable — relative paths have nothing to resolve against.
Internally the string form uses a base-directory compile option consuming
the validated snapshot (finding 1 above); it must NOT be plumbed through
`compileSource`'s `sourcePath`, which re-reads from disk and ignores the
passed source. File-based entry points (`runFile`, `test`, `testFile`)
anchor at their own directory. One rule everywhere a dir exists; no other
policy knobs.

Hermeticity now follows honestly: with confinement, a run directory's
workdir + graders snapshot really is everything a grading compile can read
(pkg:: aside, as documented above).

### Splice refusal must precede splice execution

This ordering is design, not a planner verification note. `compileSource`
today calls `expandSplices` (`lib/compiler/compile.ts:142`) before building
the symbol table or closure — a validator bolted on at the natural
post-resolution point would run after the entry file's splices had already
executed in the compiling process. Untrusted code must get no compile-time
execution hook, so the sandboxed compile path is its own entry point:

1. Parse the entry file and walk the raw import graph — resolving and
   parsing each reachable module, following re-export edges and `pkg::`
   modules — applying the closure validator (including splice detection on
   the raw ASTs) as each file is parsed. The walk produces a **closure
   snapshot**: canonical realpath → the source bytes read and the AST parsed
   from exactly those bytes.
2. Compilation consumes that snapshot. The compile pipeline is given the
   validated bytes/ASTs and must not reopen or re-resolve any user file —
   otherwise a file or symlink swapped between the validation read and a
   second compile read could smuggle in a splice or JS import the validator
   never saw (a filesystem time-of-check/time-of-use hole). This matters
   beyond eval grading: the same entry point backs public `compile`,
   `runCode`, and `runFile`, and the invariant must not depend on nobody
   writing to a caller-owned directory mid-compile. Note the current
   pipeline does the opposite — `compileSource` with a `sourcePath`
   deliberately re-reads the file from disk (`lib/compiler/compile.ts:120`)
   — so the sandboxed path needs a source-bytes-in, no-reread mode, not just
   a validation pass bolted on front.

Two pinned tests: (a) a fixture whose splice generator has an observable
side effect (writes a sentinel file) — assert the compile is refused AND the
sentinel does not exist; a diagnostic-only test cannot prove the ordering.
(b) a controlled swap seam that replaces a closure file's content after
validation — compilation must either use the validated bytes or fail closed,
never execute the swapped splice.

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
  // Per-case overrides of the call-wide limits. Everything else about a
  // case's subprocess uses the call-wide values.
  wallClock?: number;
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
// solution like any agency test does. dir is also the import-confinement
// boundary for the whole closure.
export def test(
  dir: string,
  filename: string,
  cases: TestCase[],
  wallClock: number = 60s,      // per case, unless the case overrides it
  memory: number = 512mb,       // per case
  ipcPayload: number = 100mb,   // per case
  stdout: number = 1mb,         // per case
  maxCost: number | null = null // for the WHOLE call, not per case
): Result<TestReport>

// Wrapper: reads the portable .test.json format and delegates to test().
export def testFile(dir: string, filename: string): Result<TestReport>
```

`testFile` delegates cleanly because per-case timeouts live on `TestCase`:
the JSON's per-case `timeoutMs` becomes that case's `wallClock` override, and
the file-level `defaultTimeoutMs` becomes the call-wide `wallClock` argument.

Result semantics — the line between the two failure levels:

- **`failure` = couldn't test.** Harness compile failure (including closure
  validator refusals and "solution doesn't export X"), malformed or
  unsupported `.test.json`, an `input` that fails the conversion algorithm
  or arity check (validated for every case up front, before any case runs),
  the whole-call cost guard tripping. Fix the input and call again.
- **`success` with `pass: false` entries = tested, and it's wrong.** Wrong
  values, rejected interrupts, per-case limits, scripted-answer mismatches.
  A failing case never stops the batch; the report carries every case's
  verdict.

Effects: `testFile` raises `std::read` for the JSON and the harness file
(canonical `{ dir, filename }` payload); each case's subprocess launch raises
`std::run` exactly as `run()` does. No new effect labels in v1.

## One parser, one verdict — shared with the CLI runner NOW

v1 of this spec promised a shared schema and verdict but let the CLI adopt
them "later". The review is right that this is incompatible with the
invariant "the same output cannot pass under one runner and fail under the
other": today `lib/cli/test.ts` compares `JSON.stringify(actual)` against the
raw `expectedOutput` string (key-order and whitespace sensitive), defines its
JSON shape as unchecked TypeScript types, ignores a documented `sourceFile`
field in favor of filename derivation, and accidentally treats an empty
`evaluationCriteria` array as a pass. So this feature migrates the CLI in the
same change, keeping its trusted execution path untouched:

**One parser** (`lib/testFormat/` — new home, one concept) owns the
`.test.json` schema, with two profiles:

- **Full profile** (CLI): every existing field, validated instead of
  unchecked. `sourceFile` is honored (with the filename-derivation default
  kept for files that omit it).
- **Sandbox profile** (`testFile`): the subset below; any other field is
  refused with an error naming it.

Both profiles require `evaluationCriteria` to be well-formed: the sandbox
profile requires exactly `[{ "type": "exact" }]`; the full profile requires
at least one criterion of a known type. Missing, empty, or unknown criteria
are errors in both — the current empty-array-passes accident does not become
contract. Migration item: audit `tests/**/*.test.json` for fixtures that
violate the validated schema (empty criteria, unknown fields, unused
`sourceFile` mismatches) and fix them.

**One verdict helper** (in `stdlib-lib`, imported by both the stdlib and the
CLI runner): structural equality on canonicalized values (key-order
insensitive) between the actual result and the JSON-parsed `expectedOutput`,
plus the diff rendering. One documented divergence, by profile: when
`expectedOutput` does not parse as JSON, the full profile falls back to the
CLI's legacy raw-string comparison (existing fixtures depend on it); the
sandbox profile refuses the file with an error saying how to quote a string.
A refusal is not a divergent verdict.

### The sandbox profile, complete field ledger

Supported: `sourceFile`, file-level `description`, `defaultTimeoutMs`;
per-case `nodeName`, `input`, `expectedOutput`,
`evaluationCriteria` (exactly one `exact`), `interruptHandlers` with actions
`approve`/`reject` and `expectedMessage`, `timeoutMs`, `description`.

Refused, each with an error naming the field: `llmMocks`, `fetchMocks` (file
and case level), `fakeClock`, `argv`, `retry`, `skip`, `skipOnCI`,
`skipReason`, `useTestLLMProvider`, `expectedCompileError`, `llmJudge`
criteria, interrupt actions `modify` and `resolve`, `modifiedArgs`. An empty
`tests` array is an error (mirrors `loadInputs`' empty-suite rule).

### The `input` conversion algorithm

The wire format's `input` is an Agency argument-expression string (possibly
several positional expressions: `"alice", "coffee"` or `10, 5`), while the
core takes named `args`. The conversion, owned by the shared parser's
sandbox profile:

1. Empty string → no args.
2. Otherwise parse the string as an Agency argument list with the language
   parser (never `eval`, `Function`, or string splitting).
3. Require every argument to be a literal JSON-representable value (string,
   number, boolean, null, and arrays/objects of those). A non-literal
   expression (a call, an identifier, an interpolation) is refused, naming
   the case and the expression.
4. Bind the values positionally to the named node's declared parameters
   (parameter names come from the parsed harness AST), following the
   language's real call rules rather than a naive count comparison:
   required non-defaulted parameters set the minimum, fixed parameters set
   the maximum unless the node is variadic, omitted defaulted parameters
   stay absent so runtime defaults apply, and extra values bind to a
   variadic parameter in the shape `run()` expects. The type checker
   already distinguishes exact, minimum, and ranged arity (AG6016–AG6018);
   the converter reuses the existing parameter/argument resolution owner
   instead of re-deriving those rules in the parser package. A genuine
   arity violation is refused, naming the node, the accepted range, and
   what was given.

All conversion happens up front for every case — a bad `input` is a
whole-call `failure` before any case runs, not a mid-batch surprise.

## Execution semantics

**One compile per call.** The harness file is compiled once through the
sandboxed compile entry point (validate raw closure, then compile); every
case runs against that one `CompiledProgram`.

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

**Verdict.** The shared helper described above. Failure feedback is the
rendered expected/actual diff, or the run failure text when the case died
rather than returned.

**Budget.** Per-case limits forward to each `run()` (a case's own
`wallClock` overrides the call-wide value). `maxCost` wraps the whole case
loop in `guard(cost:)` — the same pattern `run()` itself uses — so N cases
cannot multiply the budget by N. The guard tripping is a whole-call
`failure` in the same `limit_exceeded` shape as `run()`'s other limits.

## Eval framework: the AgencyTestGrader

### Conventions in an eval test directory

- `files/*.test.json` (+ harness `.agency` beside each) — **visible tests**.
  Seeded into the agent's workdir like everything in `files/`, so the agent
  self-checks with `agency test fib-tests.test.json`. Graded too.
- `holdout/*.test.json` (+ harness beside each) — **held-out tests**. Same
  format, same mechanics, never seeded; the agent never sees them. This is
  the generalization check: a solution written to the visible tests fails
  here, and the reward-hacking failure mode the optimizer work surfaced
  (agents writing to the visible test) becomes a visible score split.

Each `.test.json` in either set becomes one grader and one score row, named
by basename (`fib-tests`, `fib-holdout`). Basenames must be unique across
the union of both directories (uniqueness within one directory comes free
from the filesystem); a collision is refused at `eval run` preflight, naming
both files. `fib-tests` passing while `fib-holdout` fails is the overfitting
signature, visible in `runs list` and usable by optimizers.

**Preflight also refuses `approve` scripted answers in eval test files.**
The eval wrapper rejects every tested-code effect, and any reject wins, so a
scripted approval can never take effect during grading — a file that passed
under `agency test` on the strength of an approval would silently fail under
grading. Refusing at preflight ("eval grading rejects all effects; this
scripted approval cannot take effect — remove it or restructure the test")
keeps the visible test file honestly identical under self-check and grading.
Scripted `reject` answers are fine: the wrapper rejects anyway, so the
semantics agree.

### Ownership: discovery synthesizes a grading module

v1 hand-waved this as "the existing snapshot mechanism, unchanged in kind".
Concretely, a `Test` owns at most one `graders` module path, and
`snapshotGradingModule` bundles exactly one module and records one bundle
identity on the run row. Discovery therefore **synthesizes a grading
module** per eval test at `eval run` time and feeds it through that existing
single-module path, extended only where the revision identity requires it
(see the snapshot bullet):

- The framework writes a small TS module (to the run's staging area) that
  imports `AgencyTestGrader` from `agency-lang/eval` and default-exports one
  instance per discovered `.test.json`, each constructed with the pair's
  declared paths and `{ name: <basename>, mustPass: true, threshold: 1 }`.
- **Composition with a sibling `graders.ts`:** the synthesized module
  re-exports the sibling module's default list (when present) and appends
  the discovered graders. The test's `graders` path on the run row points at
  the synthesized module; the sibling module travels into the bundle like
  any other import. Explicit `--graders` still overrides everything, and
  the `eval.graders` config fallback stays irrelevant when discovery found
  anything (discovery output is the test's own graders).
- **Snapshot and revision:** the synthesized module is bundled and stored
  like a hand-written one (esbuild bundle, harness pairs collected via
  `externalFiles()`, content-hash storage, `graders: { source, bundleFile,
  judgeFiles, origin: "test" }` on the run row) — but NOT through
  `snapshotGradingModule` verbatim, because the existing revision is
  `<source>@<sha256 of bundle>` where `source` is the module's absolute
  physical path and the hash covers only the bundle code
  (`lib/eval/grading/gradingModule.ts`). For a module generated into a
  per-run staging path that would make every run a new revision while
  edits to harness files (which live outside the bundle, as external
  files) change nothing — the opposite of what lineage needs. So the
  snapshot path gains an entry point taking `{ physicalPath,
  sourceIdentity, revisionInputs }`: `sourceIdentity` derives from the
  eval test directory (stable across runs and machines), and
  `revisionInputs` is the sorted list of content hashes of every
  discovered harness pair, folded into the revision hash alongside the
  bundle. Hand-written modules keep today's identity untouched. Pinned
  tests: two runs of the same suite produce identical revisions; editing
  only a harness changes the revision. Per-grader lineage is the basename
  via the grader `name`, so re-grades supersede correctly.
- `threshold: 1` is load-bearing: `BaseGrader.passes` is
  `value >= (threshold ?? 0)`, so a fractional score with bare
  `mustPass: true` would gate nothing — even 0 passes a 0 threshold. The
  eval tests pin both behaviors: partial credit in the objective, all-cases
  gate via `mustPass` + `threshold: 1`.

Every discovered harness JSON is validated (sandbox profile) at `eval run`
preflight, matching the "broken graders fail before any agent runs" rule.
Consequence worth knowing: holdout files travel inside run directories, so
the secrecy boundary is "during the agent's run", not forever; a suite
author republishing run directories publicly ships the holdouts with them.

### What one grading pass does (per `.test.json`)

1. Make a scratch directory under `process.cwd()` (compiled Agency resolves
   `agency-lang` from the directory it runs in — never `os.tmpdir()`).
2. Copy the run's **workdir wholesale** — with multi-file solutions only the
   agent knows which files matter — then overwrite the harness `.agency` and
   `.test.json` with fresh copies from the graders snapshot. That is the
   whole tamper defense: everything the agent wrote is testable input;
   everything that judges comes from the snapshot. (Import confinement to
   the scratch dir's realpath means a symlink the agent planted cannot pull
   in files from outside it, either.)
3. Spawn the framework-owned Agency **wrapper** via `agency run`
   (`process.execPath` + `process.argv[1]`; grading always runs inside the
   agency CLI). The wrapper takes the scratch dir, the JSON filename, and a
   framework-chosen **report path outside the scratch dir**. It calls
   `testFile()` inside a reject-all handler — approve `std::run` and the two
   known `std::read`s, reject every other effect with a message naming it —
   then writes a **report envelope** to the report path with its own
   approved write. `testFile` returns `Result<TestReport>`, and on
   `failure` there is no report to write — so the envelope is a tagged
   union, written for every normally completed call:
   `{ status: "tested", report: TestReport }` or
   `{ status: "could-not-test", error: <serialized failure> }`. The
   wrapper is the only sandbox-policy owner; it ships with the framework,
   never with suites.
4. The TypeScript grader reads the envelope. **Stdout is diagnostics
   only**: `_run` pipes the tested subprocess's stdout through to the
   parent, so tested code can print anything — including a forged report —
   and stdout can never be the data channel. Tested code cannot write the
   report file because its every `std::write` is rejected; the wrapper's own
   write happens outside the `handle` block, after the tests.
5. Score = **fraction of cases passed**, `mustPass: true, threshold: 1`.
   Feedback = the failing cases' feedback lines; a `could-not-test`
   envelope (compile error, malformed test JSON, cost guard) is score 0
   with the serialized error verbatim — pinned by tests that drive a
   compile failure and a malformed JSON through the actual wrapper
   transport, not only through direct `testFile()` calls. Wrapper crash,
   timeout, or a missing/malformed envelope file is score 0 with the
   stdout tail as diagnostics. No workdir on the run → score 0,
   "run left no workdir".

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
what stops agent-written code — or hostile Agency test files in a suite —
from deleting my home directory?"

Scope first, honestly: the guarantee covers **Agency code** — the agent's
solution, and a suite's harness `.agency` and `.test.json` files. It does
NOT cover a sibling `graders.ts`: that is suite-authored TypeScript the
grading process executes directly, per the eval framework's existing,
documented trust boundary ("graders are code the harness executes — pulling
a remote suite means trusting it"). No closure validator or wrapper handler
constrains TypeScript running in the grading process. What this feature
changes is that coding tests no longer *need* a `graders.ts` at all — a
suite shipping only `.test.json` + harness files sits entirely inside the
sandbox guarantee, which is a strictly smaller trust surface than today.
For the Agency side, the chain:

1. The tested code can only produce effects through interrupts (closure
   validator: nothing in the compile closure escapes to TS/node, and splices
   are refused before anything expands).
2. Compile-time file access is confined: every local file in the closure
   must realpath-resolve inside the scratch directory, so compilation cannot
   even read outside it (the one read class interrupts cannot see).
3. Every interrupt from the subprocess is voted on by the wrapper's
   reject-all handler, and any reject wins — including over the code's own
   `with approve` (scripted approvals never reach grading; preflight refused
   them).
4. The wrapper is framework code the user already trusts by running the CLI;
   suites cannot substitute it (the harness and solution both run *inside*
   the sandbox the wrapper polices).
5. The only approvals in the chain are the sandbox launch itself, the two
   known harness-file reads, and the wrapper's own report write.

## Testing

**Stdlib execution tests (`tests/agency/`, no LLM)** — the bulk:

- passing / failing cases, diff feedback, batch continues past a failure
- compile failure (including "solution doesn't export X")
- **parent veto**: a reject-all handler around `test()` rejects an effect
  the solution raises — the load-bearing safety test
- scripted answers: approve with value; reject; `expectedMessage` mismatch;
  leftover answers fail the case; exhausted answers propagate to an outer
  handler
- a two-file solution with a local import; an import escaping the dir
  (via `..` and via a symlink) refused with the confinement error
- closure-validator refusals: a TS import, a node builtin
- **splice ordering**: the side-effect fixture described above — refusal
  AND no sentinel file; the swap-seam test (content replaced after
  validation → validated bytes used, or fail closed)
- per-case timeout (case-level `wallClock` override) → case-level
  `limit_exceeded` feedback
- `testFile`: JSON mapping incl. `defaultTimeoutMs`; `sourceFile`
  defaulting; the `input` algorithm (multi-arg positional bind, defaulted
  and variadic nodes accepted per the language's arity rules, non-literal
  refused, genuine arity violations refused, all up front); one refusal test per
  unsupported field/action; empty `tests`; unparseable `expectedOutput`;
  empty/unknown `evaluationCriteria`

**TS unit tests (vitest):** closure validator (its own file, one concept);
the shared parser, both profiles; the shared verdict/diff helper including
the full profile's raw-string fallback.

**CLI migration tests:** the existing `agency test` suite keeps passing on
the shared parser/verdict (the fixture audit above); a regression test that
an empty `evaluationCriteria` array now errors instead of passing.

**Eval framework (vitest):** grader auto-discovery and module synthesis
(two runs of the same suite → identical revisions; a harness edit → a new
revision); envelope transport (compile failure and malformed JSON driven
through the actual wrapper, not only direct `testFile()`); composition with a sibling
`graders.ts`; holdout not seeded (a seeding test on `runAgent`);
basename-collision refusal and approve-answer refusal at preflight; tamper
defense (agent-edited harness overwritten from snapshot); fraction score
with the `threshold: 1` gate pinned; snapshot rebind (grade a copied run
directory); report-file transport (a tested case that prints a forged
report to stdout does not affect the score).

**End to end:** the fib migration above, exercised by CI's eval coverage.

## Documentation

- New `docs/dev/std-agency-test.md`: the contract, the closure-validator
  invariant and confinement rule, splice-before-expansion ordering, the
  one-vote scripted-answer rule, wrapper/report-file/tamper-defense
  mechanics, holdout, grader-module synthesis, and the CLI-runner
  convergence (shared parser + verdict now; execution split by trust
  posture).
- Update `docs/dev/eval-grading.md`'s coding-test section: the suite-local
  pattern is now framework surface.
- CLAUDE.md pointers for both. Site docs (`docs/site/**`) stay owner-side.

## Decisions log

From the brainstorm:

- v1 scope: minimal, evals-first; sandbox-safe subset of the test format.
- Input shape: typed core + JSON file wrapper; no separate Agency config
  format (the typed parameter is that experience).
- Scripted answers are one vote; parents can veto (same story as `run()`).
- Eval integration: framework-owned grader, convention-based discovery.
- Sandbox stance: reject-all, no escape hatch in v1.
- One eval test directory = one agent run; multiple `.test.json` files =
  multiple named grader scores, never multiple eval directories.
- Held-out tests live in `holdout/` (the name carries the rule; `tests/` is
  overloaded and doesn't distinguish the sets).

Changed in v2 (per review):

- Import policy: dir-confined local imports (realpath, symlinks resolved)
  replace unconfined relative/absolute paths. `pkg::` stays allowed with a
  validated closure and a documented hermeticity caveat. This walks back
  part of the "open it all the way up" brainstorm decision: the review
  showed the unconfined version made compile-time reads the wrapper can
  neither veto nor observe, and broke the hermetic-grading claim.
- Splice refusal ordered before expansion via a dedicated untrusted compile
  entry point; side-effect test pinned.
- Per-case `wallClock` on `TestCase`; `defaultTimeoutMs` mapped.
- `{ mustPass: true, threshold: 1 }` on every discovered grader.
- CLI migrates to the shared parser + verdict in this change; strict
  `evaluationCriteria`; documented raw-string fallback in the full profile.
- `input` conversion algorithm defined (language parser, literals only,
  positional bind, up-front validation); complete field ledger including
  `resolve` and `modifiedArgs`.
- Grader discovery synthesizes a deterministic grading module through the
  existing single-module snapshot path; composition and revision identity
  specified.
- Wrapper reports through a framework-chosen file; stdout is diagnostics
  only (tested code shares the stdout pipe and could forge it).
- Eval preflight refuses `approve` scripted answers (the wrapper's rejects
  would silently defeat them; refusing keeps self-check and grading
  honest).

Changed in v3 (per re-review):

- Compilation consumes the validated closure snapshot (bytes + ASTs);
  never validate, discard, and re-read — the TOCTOU hole. Swap-seam test
  pinned; `compileSource`'s re-read-from-`sourcePath` behavior explicitly
  not the plumbing route.
- Synthesized grader modules get a stable `sourceIdentity` (from the eval
  test dir) and a revision that folds in the harness pairs' content
  hashes, via a new snapshot entry point; the existing physical-path @
  bundle-hash identity could be neither stable across runs nor sensitive
  to harness edits. Hand-written modules unchanged.
- The wrapper writes a tagged envelope (`tested` / `could-not-test`) so a
  `failure` from `testFile` survives the file transport with its error.
- The local-machine guarantee is scoped to Agency code; a sibling
  `graders.ts` remains trusted suite TypeScript per the existing eval
  contract (and coding tests no longer need one).
- `input` binding follows the language's arity rules (defaults, variadic;
  AG6016–AG6018), reusing the existing resolution owner.
- Exact `compile`/`runCode` signatures for the `dir` anchor; `dir` is
  compile-only, `cwd` execution-only, both trailing optional.
