# Eval grading of Agency coding tests: `agency test --agency-only --reject '*'`

Date: 2026-08-22. Status: designed, awaiting owner review. Supersedes the
"Eval AgencyTestGrader" half of
`docs/superpowers/specs/2026-08-20-std-agency-test-design.md`
and all of
`docs/superpowers/specs/2026-08-21-combined-grader-external-files-design.md`
(the synthesized grading module, which this design removes).

## Background: what we are trying to do, and why Agency makes it possible

An eval coding test asks an agent to write Agency code. The fib test says
"write `export def fib(n: number): number` in `fib.agency`". To grade it,
the framework has to run the agent's code against tests the agent did not
see and count how many pass.

Running code an agent wrote, on the machine doing the grading, is normally
unsafe. If the task were "write fib in Python", the grader would need a
container, because nothing stops a Python solution from deleting the home
directory when imported. Agency is different, and this is the whole reason
the eval asks for Agency:

- Every effect in the standard library (writing a file, running a shell
  command, sending a request) is an **interrupt**: the code asks a handler
  for permission and does nothing until it gets it.
- Handlers form a chain from the innermost `with approve` out to the root of
  the process, and **a reject anywhere in the chain wins** over an approve
  anywhere else (`lib/runtime/interrupts.ts:409`, "reject > propagate >
  approve > noResponse"; pinned by `tests/agency/connector-core.agency`).
  So the tested code writing `deleteHome() with approve` does not help it:
  an outer handler that rejects still wins.
- Code that is not Agency has no interrupts. A `.ts` file or a `fs` import
  in the closure is a hole. The closure validator merged in #878
  (`lib/compiler/closureValidator.ts`) refuses those before anything
  compiles.

So grading is safe exactly when two things are both true: the agent's code
is pure Agency (validated), and the grader holds the outermost handler and
that handler rejects everything. This spec is about the plainest way to make
both true.

The earlier design (#880 as it stands) did this with a framework-owned
Agency program, `agencyTestWrapper.agency`, that called
`std::agency`'s `testFile()` inside a reject-all `handle` block, returned
its report through a file, and was attached to the eval through a generated
TypeScript grading module. It worked, but it is three mechanisms where one
will do: the grader's policy lived in an Agency file nobody reads, the
report crossed a process boundary in an invented envelope, and the
harness files were preserved by generating and bundling source code.

## The design in one paragraph

`agency test` gains the run command's policy flags and two of its own.
`--policy <name|path>` (with `--approve` / `--reject`) installs the same
root handler `agency run --policy` already installs, inside the process that
runs each test case, so the tested code's effects are all voted on by a
policy the caller chose. `--agency-only` compiles each tested file through
the #878 closure validator, so the closure cannot contain anything that
escapes the interrupt system. `--json` prints the results as one JSON
document. `--reject '*'` (already meaningful on `agency run`) rejects every
effect. The eval grader then is: copy the agent's workdir to a scratch directory, put the
framework's own copy of the harness pair in place, run
`agency test --json --agency-only --reject '*' <harness>.test.json`
there, and score the passing fraction. The harness files are kept in the run
directory as plain files so `eval grade` can repeat this later from the
directory alone.

## Part 1: `agency test` flags

### `--policy <name|path>`

Same meaning and same resolution as on `agency run`: a built-in policy name
or a policy JSON file (`lib/cli/runPolicy.ts`, `resolveRunPolicy`). The test
runner threads the resolved policy into each test case's child process as
`AGENCY_RUN_POLICY`, the way `agency run` does for its child
(`lib/cli/commands.ts:304-313`, clear-then-set so nothing inherited from the
parent shell leaks in). Nothing else is needed: the runtime's `runNode`
already installs the handler from that variable at the end of bootstrap,
before the entry node's body runs (`lib/runtime/node.ts:201`), and the
resume path re-installs it on every leg (`lib/runtime/interrupts.ts:799`).
The test runner's evaluate script enters through those two functions.

How this interacts with a test case's scripted `interruptHandlers`: the
policy handler is the outermost handler and votes first. An effect the
policy rejects is rejected; the scripted answers never see it. An effect the
policy does not mention (no rule, no wildcard) gets no vote from the policy
and surfaces to the scripted answers as today. So `--policy` narrows what a
test file can do; it never widens it.

Without the flag, the runner deletes any inherited `AGENCY_RUN_POLICY` /
`AGENCY_RUN_POLICY_INTERACTIVE` from the child's environment, matching
`agency run`. Today these leak through from the parent shell; that was never
intended and is corrected here.

`--max-cost <dollars>` and `--max-time <duration>` are added alongside, with
`agency run`'s meaning (`AGENCY_MAX_COST` / `AGENCY_MAX_TIME`, installed by
`installRootBudget` next to the policy handler). They matter for grading
because `llm()` is not an interrupt: a reject-all policy stops a solution
from touching the filesystem but not from spending money. A cost cap does.

### `--agency-only`

For each test file, the tested source is compiled through
`compileSandboxed({ entry: { file: <basename> }, dir: <source's directory> })`
(`lib/compiler/compileSandboxed.ts`) instead of the normal compile. The
validator refuses, with a list of every violation: TypeScript/JavaScript
files, Node built-ins (`fs`, `child_process`), `pkg::` packages, compile-time
splices, and local imports that are absolute, leave the directory, or go
through a symlink. `import test { … }` is refused too (the sandboxed compile
never honors it). Only `std::` modules and relative `.agency` files inside
the source's directory remain.

A refusal or compile error is a **file failure reported like any other**:
the file's cases are marked failed with the diagnostics as feedback, the
run continues to the next file, and the exit code is 1 at the end. It is not
a `process.exit`, because "the agent's code does not compile" is a normal
grading outcome (this is the rule `docs/dev/eval-grading.md` already
states for the old `graders.ts`).

The compiled output (entry code, plus every non-entry module from
`CompileResult.modules`) is written beside the sources as `<name>.js`, the
same layout a normal compile produces, and the cases run it through the
existing `preferCompiled` path. The precompile pass is skipped for the file.

The same flag goes on `agency run`: its one compile call
(`lib/cli/commands.ts:282`) is replaced by the same helper when the flag is
set, and `agency run` already has `--policy`. A user can then run agent-
written Agency code directly with `agency run --agency-only --reject '*'
solution.agency`; the grader is that command line with `test` in place of
`run`.

`--agency-only` does not imply `--policy`, and the reverse. They answer
different questions (can the code escape the interrupt system; what does the
interrupt system answer) and the grader passes both. A future `agency.json`
default for either is out of scope.

### `--json`

With `--json`, everything the runner prints today goes to stderr, and stdout
receives exactly one JSON document when the run ends. The exit code is 1
when any case failed or any file could not run (the document's `filesFailed`
count, which is non-zero even when the file declared no cases). Two edges:
a compile failure in the shared precompile pass (not `--agency-only`) ends
the command with exit 1 before any document, so a missing document is a
failure; and `--coverage` is refused alongside `--json` unless
`--collect-only` is also given, because the coverage report prints to
stdout.

```json
{
  "version": 1,
  "files": [
    {
      "file": "fib-holdout.test.json",
      "sourceFile": "fib-holdout.agency",
      "status": "ran",
      "cases": [
        { "node": "fifteen", "status": "passed", "durationMs": 812 },
        { "node": "twenty", "status": "failed", "durationMs": 790,
          "feedback": "- 6765\n+ 6764" }
      ]
    },
    {
      "file": "broken.test.json",
      "sourceFile": "broken.agency",
      "status": "compile-failed",
      "error": "Sandboxed compilation refused:\n  - broken.agency imports 'fs', which is not Agency source ...",
      "cases": []
    }
  ],
  "passed": 1,
  "failed": 1,
  "skipped": 0,
  "filesFailed": 2
}
```

- `files[].status`: `ran` (cases executed), `compile-failed` (the source
  did not compile or was refused; `error` carries the text), `skipped`
  (file-level `skip` / `skipOnCI`), `aborted` (suite abort hit it).
- `cases[].status`: `passed`, `failed`, `skipped`, `aborted`.
- `cases[].feedback`: present on `failed`; the exact-match diff, the judge
  explanation, the execution error, or the interrupt mismatch text, exactly
  what the human output prints.
- `cases[].description` and `cases[].input` are copied from the test case
  when present.
- `version` is 1 and bumps on any incompatible change.

The human summary line (`N/M tests passed`) is unchanged on stderr. Nothing
else in the human output is part of the contract.

### Reject-all: `--reject '*'`

`agency run` already has `--approve <effects>` / `--reject <effects>`
(`resolveRunPolicy`, `lib/cli/runPolicy.ts`), and a policy's wildcard key
is the literal `"*"` (`lib/runtime/policy.ts:44`), so `--reject '*'` is
already a reject-every-effect policy on `agency run`. `agency test` gets
the same two flags alongside `--policy`, and the grader uses `--reject '*'`.
No new built-in policy is added in this change; see "Open questions" for
the larger policy clean-up.

## Part 2: the eval grader

### Discovery (unchanged from #880)

Every `*.test.json` directly inside a test directory's `files/` (seeded into
the agent's workdir, so the agent self-checks with the same file) and
`holdout/` (never seeded) is one harness. Each needs its sibling `.agency`
of the same basename; basenames must be unique across the two directories,
because they become grader names and score-row names. A test with at least
one harness needs no `goal`. This is `discoverAgencyTests` in
`lib/eval/loadInputs.ts` today and stays as it is.

### Preflight, before any agent runs

Each harness `.test.json` is parsed under the CLI's full profile
(`parseTestFileFull`, since `agency test` is what will run it) and then
checked against an eval-only refusal list, in a new
`parseTestFileEvalHarness` beside the other profiles in
`lib/testFormat/schema.ts`:

- `interruptHandlers` on any case: refused. Under `--reject '*'` the policy
  answers every effect before a scripted answer could, so a scripted
  `approve` can never take effect and a scripted `reject` is redundant; a
  file declaring them would fail with "expected N interrupts, saw 0" for a
  reason the author could not see.
- `llmMocks`, `fetchMocks` (file and case), `fakeClock`,
  `useTestLLMProvider`, `argv`: refused. They are developer-machine test
  conveniences, not part of a grading contract.
- `skip`, `skipOnCI`, `skipReason`, `expectedCompileError`: refused. A
  harness that does not run grades nothing.
- `evaluationCriteria` must be exactly one `exact` criterion. An `llmJudge`
  criterion would call a model from inside grading with no budget.
- `sourceFile`, when declared, must be the sibling harness basename. A json
  naming another file would test something other than its pair.

Refusals name the file, the case, and the field, and happen in
`runSuite`'s grader snapshot step, so a broken harness stops the suite
before the first agent launches and costs nothing.

The sandbox profile (`parseTestFileSandbox`, with its `args` object) stays
exactly as it is for `std::agency`'s `testFile()`. It is no longer on the
eval path.

### Run time: keep the framework's copy of every harness

When a run directory is written (`foldIntoRunDirectory` in
`lib/eval/run/runSuite.ts`), both files of every harness pair are stored
under the directory's `graders/` by the existing content-hash file store
(`recordCompletedRun({ gradersFiles })`, `writeGradersFiles` in
`lib/runDirectory/mutations.ts`), exactly as judge prompt files are stored
today. The run row records them:

```json
"harness": [
  { "name": "fib-tests", "visibility": "visible",
    "agency": "3f1c….agency", "json": "9a02….test.json",
    "sha256": "c41d…" },
  { "name": "fib-holdout", "visibility": "holdout",
    "agency": "…", "json": "…", "sha256": "…" }
]
```

`harness` is a new optional field on the `run` annotation
(`RunAnnotationSchema` in `lib/runDirectory/annotations.ts`), beside the
existing `graders` field, which is untouched. `agency` and `json` are the
stored names, `<sha256 of content><extension>`, the same rule judge files
already use (`snapshotGradingModule`); `sha256` is the hash of the two
contents concatenated with a `\0` between, and is the grader's revision. Nothing is generated, bundled,
or given a synthetic identity. A directory from before this field has no
`harness` and grades exactly as before.

Two reasons the framework keeps its own copy rather than reading the pair
from the workdir snapshot: the `holdout/` pair is never in the workdir, and
the `files/` pair in the workdir is the agent's copy, which the agent may
have edited to make its cases pass. The grade must use the framework's
bytes for both.

### Grade time: one grader per harness

`effectiveGraders` in `lib/eval/grading/gradeRun.ts` keeps its precedence for
module graders (override > test-owned snapshot > recorded module path >
config-origin snapshot > fallback) and **appends** one `AgencyTestGrader`
per `harness` entry, bound to the stored files under `graders/`. Harness
graders are test-owned, so they survive `--goal` the way a test's own
`graders.ts` does. When grading live from a suite (no run directory), each
grader binds to the test directory's files directly.

`AgencyTestGrader` (`lib/eval/grading/agencyTestGrader.ts`, rewritten):

1. Refuse to grade when the run left no workdir.
2. Create a scratch directory under the project's `.agency-tmp/`
   (`makeAgencyTempDir`; never `os.tmpdir()`, because compiled Agency
   resolves `agency-lang` from the directory it runs in) and copy the
   workdir into it, **skipping symlinks** (a `cpSync` filter on `lstat`).
   No code is written to support links: a link the agent planted is simply
   not there in the copy, so nothing can follow it, and the validator's own
   symlink refusal is never even reached. This is the same rule as CLAUDE.md
   ("do not add code to support symlinks").
3. Install both harness files from the framework's copy: remove whatever
   sits at the destination (`rmSync` with `force` and `recursive`; after
   step 2 it can only be a regular file or directory the agent wrote), then
   write with the `wx` flag.
4. Spawn `node <agency cli> test --json --agency-only --reject '*'
   --max-cost 5 <json basename>` with `cwd` = scratch and a wall-clock
   timeout (10 minutes, as today). The CLI path is `process.argv[1]` when
   grading runs inside the agency CLI, else the package's own
   `dist/scripts/agency.js` (the argv[1]-or-package-root rule from #880,
   unchanged).
5. Parse stdout as the `--json` document (strictly, with zod; anything
   else is a grader failure whose feedback is the stderr tail).
6. Score: `passed / cases.length` over the one file, `0` when the file's
   status is not `ran`, `1` for a file with zero cases (it ran and nothing
   failed). `mustPass: true, threshold: 1`, as before: partial credit feeds
   the objective, anything short of all-green gates.
7. Feedback: the failing cases' `node: feedback` lines, or the file's
   `error`, or the spawn diagnostics tail (ANSI stripped, last 2000 chars).
8. Delete the scratch directory with `safeDeleteDirectoryWithin`.

The default cap is **$5**: a solution may legitimately call `llm()`, and
the cap is there to bound a runaway, not to forbid model use. A test
directory can change it with a `harnessMaxCost` field in its `test.json`
(dollars), recorded on the harness entry so `eval grade` uses the same cap.
The cap is the runtime's root budget, which lives in the process that runs
one case, so it is **per case**: a ten-case harness can spend up to ten
times the cap. A per-harness total would need the grader to sum spend across
cases from the statelog; that is not in this change.

### Why this is safe (the argument, in one place)

- `--agency-only` means the closure is `std::` plus relative `.agency`
  files the validator read itself. There is no TypeScript, no Node
  built-in, no package, no splice, no symlink, and the mirror compile reads
  only the bytes that were validated (#878). So every effect the tested
  code can perform is an interrupt.
- `--reject '*'` installs the root handler before the entry node's
  body runs, and the chain resolves reject over approve, so the tested
  code's own `with approve` is a vote that loses.
- Code that runs before the handler exists (static initializers, top-level
  callbacks) cannot raise an interrupt at all: there is no node frame to
  checkpoint, and the runtime throws "Cannot create checkpoint: no current
  node id" (see the memory `interrupts-cannot-gate-startup-reads`, proven
  in PR #694). An effectful initializer therefore fails rather than runs.
- A subprocess the tested code launches through `std::run` is an IPC child,
  which forwards its interrupts to this root chain and installs no policy
  of its own (`installRunPolicyHandler` is root-only).
- Money: `llm()` is not an interrupt; `--max-cost` trips the root budget
  when a case's spend crosses the cap, and the case fails. Time: the case `timeoutMs` and the grader's
  wall-clock kill. Disk: the scratch directory is the only writable place
  and it is deleted.
- The harness files come from the framework's copy, installed after the
  workdir copy, without following links.

What this does **not** defend against, stated so it is not assumed: a
solution that burns CPU inside the time limit, or reads files the scratch
directory happens to contain (it is a copy of the agent's own workdir, so
there is nothing there the agent did not already have).

## Part 3: what is removed

- `lib/agents/eval/agencyTestWrapper.agency` and its policy test
  `tests/agency/agency-test-wrapper-policy.*`.
- `lib/eval/grading/reportEnvelope.ts`.
- `lib/eval/grading/synthesizeGradersModule.ts` and its test.
- The `revision` override in `lib/eval/grading/gradingModule.ts`
  (`GraderRevision`, the `loadGradingSnapshot` branch) and the `revision`
  field of `GradersIdentity` in `lib/runDirectory/annotations.ts`.
- `_formatFailurePayload` from `stdlib/agency.agency` (its only caller was
  the wrapper). `testFile()` and its `maxCost` parameter stay; they are
  stdlib features in their own right, merged in #879.
- `docs/superpowers/specs/2026-08-21-combined-grader-external-files-design.md`:
  the problem it describes (a sibling `graders.ts` combined with synthesized
  graders cannot use `externalFiles()`) no longer exists, because nothing
  is synthesized; module graders and harness graders are two lists
  concatenated at load time.

## Part 4: the fib eval

Unchanged from the current #880 branch: `files/fib-tests.agency` +
`files/fib-tests.test.json` (visible), `holdout/fib-holdout.agency` +
`holdout/fib-holdout.test.json`, `test.json` pointing the agent at
`agency test fib-tests.test.json`. The harness files already use no
`input` for their no-argument nodes, so they parse under both the CLI's
full profile and the eval refusal list. `graders.ts` stays deleted.

## Decisions taken, for the record

- **Option C over a user-written grader program.** A per-eval
  `grade.agency` would be explicit but is ten lines of handler boilerplate
  that is easy to get subtly wrong (forgetting to approve `std::run` makes
  every case fail silently). Two CLI flags whose meaning is already
  documented for `agency run` are the smaller surface, and a test directory
  that needs a custom policy can ship a policy JSON and name it in
  `test.json` later (`harnessPolicy`; not in this change).
- **The CLI runs the harness, not `testFile()`.** One executor for the
  agent's self-check and for grading, so "passes for the agent, fails in
  grading" cannot come from two runners disagreeing. `testFile()` remains
  for Agency programs that want to run tests under their own handlers.
- **Plain files in the run directory, not a bundle.** A harness is data.
  The content-hash store already exists for judge files.
- **`--json` is a small public contract.** Version field, stderr for
  humans, stdout for the document. The owner should confirm the field
  names before implementation; they are the one thing here that is hard to
  change later.

## Decided in review (2026-08-22)

- `--json`, not `--reporter json`.
- Default harness cost cap $5, per case; `harnessMaxCost` in `test.json`.
- Symlinks: never add code to support them; the workdir copy skips them.
- `--agency-only` goes on `agency run` as well, in this change.
- Flag name: `--agency-only` (`--sandbox` promises isolation the flag does
  not provide; `--pure-agency` was the runner-up).

## Open questions for the reviewer

1. Named policies. Today `run`, `agent`, `test`, and `remote call` all
   resolve `--policy` through one list (`lib/runtime/builtinPolicies.ts`),
   so the names are shared, but each built-in is a hand-written list of
   effects. `std::capabilities` already names the groups (`FileRead`,
   `Shell`, `Network`, …) as compile-time effect sets. The clean-up: let
   `--approve` / `--reject` accept a capability set name as well as an
   effect name, expanded from `std::capabilities` when the policy is
   resolved, and rewrite the built-ins as unions of sets. Decided: out of
   scope for this change; this spec only needs `--reject '*'`.
2. Inherited `AGENCY_RUN_POLICY` (spec says `agency test` clears it when
   run without a policy flag, as `agency run` does).
