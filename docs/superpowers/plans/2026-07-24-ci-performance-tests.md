# CI performance regression tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a performance-regression test suite to CI that catches algorithmic
regressions (an accidental O(n²), a newly-quadratic typechecker path) in the core
commands — parse, compile, typecheck, fmt, lint, lsp — plus a few others, without
becoming flaky on shared runners. The suite runs **informational-only** at first
(records and reports, never blocks a merge) so we can calibrate thresholds against
real runner noise before flipping it to gating.

**Architecture:** A small custom harness measures work at increasing input sizes
and asserts the growth *ratio* stays near-linear — a check that is robust to
absolute machine speed because it compares two measurements from the same run.
The harness interleaves its samples so intra-run contention cancels, and every
assertion routes through one gate (`PERF_ENFORCE`) that records-and-passes during
the informational period and fails once enforcement is on. Tests call the pipeline
functions directly (not the CLI), and the two paths that hit the process-wide
parse cache are given explicit cache neutralization so they measure work, not
caching.

**Source of truth:** the spec at
`/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-24-ci-performance-tests-design.md`
and its `-REVIEW.md`. Read both before starting — the REVIEW's reconciliation
section carries three corrections that override the spec body (interleaved
sampling, the parse-cache neutralization, and `formatSource` as the fmt target).

## Global Constraints

- **Informational-first.** Nothing this plan adds may block a merge until a
  separate, deliberate flip. The perf CI job runs with `PERF_ENFORCE` unset and
  `continue-on-error: true` for the entire duration of this plan.
- **Never commit on `main`; re-check the branch before every commit.** Branches:
  PR 1 = `adit/perf-tests-1`, PR 2 = `adit/perf-tests-2` (after PR 1 merges), PR 3
  = `adit/perf-tests-3` (after PR 2).
- **Measure the algorithm, not node.** Tests call library functions
  (`parseAgency`, `typeCheck`, `lintSource`, `formatSource`, `runDiagnostics`)
  directly. The only shell-out is the deliberate CLI cold-start smoke (PR 3).
- **A perf test that re-measures the same input MUST be cache-free or evict
  between runs.** The compile-via-pipeline and incremental-build tests hit the
  process-wide `parseAgencyFileCached` and the build manifest; they use
  `evictParseCache` or a unique synthesized path per timed run. The primitive-call
  tests (parse-on-string, typecheck, lint, fmt) are already cache-free — confirm
  this per test, do not assume it.
- **Every perf test asserts the work actually happened**, outside the timed
  section: the parse produced n functions, `lintSource` returned n findings,
  compile produced non-empty TS, etc. A test that measures a fixture which
  silently parsed to `[]`, or calls the wrong entry point, produces a clean ratio
  and passes forever — the exact bogus-benchmark trap. "Measures nothing" and
  "measures linear work" must not be indistinguishable.
- **The timing boundary is a contract:** `build(n)` does all untimed setup
  (generate source, build the `TextDocument`, write temp files); the closure it
  returns contains *only* the work under test. A closure that generates its own
  source times string concatenation, not the algorithm.
- **House rules:** objects not maps, arrays not sets, types not interfaces, no
  dynamic imports, no silent catch, colors via `color` from
  `lib/utils/termcolors.ts`. Never touch CHANGELOG.md.
- **Testing the tests:** save output (`pnpm test:perf 2>&1 | tee /tmp/<name>.txt`).
  Do not run the full agency suite.

## Background the implementer needs

### Why ratios, and why interleaved

Absolute-time assertions ("compile in < 500 ms") flake on shared runners and rot
as machines change (spec, "Why absolute-time assertions fail on CI"). We assert
growth instead: a linear pass on an 8× input takes ~8× as long; a quadratic one
takes ~64×. The ratio is taken from two measurements in the *same run*, so
steady-state machine speed cancels.

But — this is the review's key correction — the ratio does **not** cancel
*intra-run* contention (a noisy-neighbor VM whose load varies second-to-second).
If the small size is timed during a quiet moment and the large size during a
spike, the ratio lies. Dividing two independently-noisy numbers is noisier than
either. The fix is to **interleave and alternate the order**: round to round,
time small and large adjacent but flip which goes first (small→large, then
large→small, …), and take the **median of the per-round ratios**
`t(large)/t(small)`, not the ratio of two separately-taken medians. Interleaving
cancels random second-to-second noise; alternating also cancels *monotonic drift*
(a runner getting steadily busier would otherwise bias the always-later size the
same way every round, and a median can't remove a bias present in every round).
The harness owns this schedule (Task 1); a naive "all-small then all-large" — or
even a fixed-order interleave — is what we are explicitly not doing.

### The parse cache (the thing both the spec and first review missed)

`lib/parseCache.ts` is a **process-wide** cache of successful file parses
(`parseAgencyFileCached`), consumed by the compile path
(`lib/compiler/buildSession.ts`, `compileClosure.ts`); the build manifest
(`lib/compiler/buildManifest.ts`) separately decides whether to compile a file at
all. So a compile measured repeatedly on the same file times a cache hit, not a
compile, and the N-vs-large ratio is meaningless. `evictParseCache(absPath)` is
exported for exactly this. The low-level `parseAgency(source, …)` string path does
**not** consult this cache, so parse/typecheck/lint/fmt tests that call the
primitives on strings are clean.

### Entry points (confirm each signature at implementation time)

- parse — `parseAgency(source, config, applyTemplate)` — `lib/parser.ts`
- typecheck — `buildCompilationUnit(...)` (`lib/compilationUnit.ts`) then
  `typeCheck(program, config, info)` (`lib/typeChecker/index.ts`)
- fmt — `formatSource(source, config): string | null` — `lib/formatter.ts` (the
  sync pure core; **not** the async `format` in `commands.ts`)
- lint — `lintSource(source, filePath, config)` and each rule's `run(ctx)` —
  `lib/linter/registry.ts`, `lib/linter/rules/*`
- lsp — `runDiagnostics(doc, fsPath, config, symbolTable)` (`lib/lsp/diagnostics.ts`)
  and `getCodeActions(...)` (`lib/lsp/codeAction.ts`)
- cache eviction — `evictParseCache(absPath)` — `lib/parseCache.ts`

### Repo test wiring to mirror

`vitest.integration.config.ts` + the `test:integration` script are the precedent
for a separate vitest run (its own config, own include). `vitest.config.ts`
excludes `tests/`; we add a `*.perf.test.ts` exclude. CI (`.github/workflows/test.yml`)
fans jobs out (`build` on a 22.x/23.x matrix, `integration`, `agent-tests`); the
perf job joins them on a single node version.

## File structure

New:
- `lib/perf/harness.ts` — `measureMs`, `growthFactor` (interleaved, order-alternated,
  normalized), `expectPerf`, the results recorder, named constants (`GROWTH_BOUND`,
  `WARMUP`, `RUNS`), and `cacheFreePath` (the single home for parse-cache
  neutralization — see Task 8).
- `lib/perf/fixtures.ts` — synthesized generators.
- `lib/perf/*.perf.test.ts` — one file per command area.
- `vitest.perf.config.ts`.

Modified:
- `vitest.config.ts` (exclude `**/*.perf.test.ts`), `package.json` (`test:perf`),
  `.github/workflows/test.yml` (the informational `perf` job).

---

# PR 1 — the harness, fixtures, CI wiring, and one real command

Branch: `git checkout -b adit/perf-tests-1 origin/main` (fetch first).

This PR builds the whole apparatus and proves it end-to-end on the one command
that motivated the effort (lint), including the canary that proves the harness can
actually detect a quadratic. Nothing here gates.

## Task 1: the measurement harness

**Files:** create `lib/perf/harness.ts` (+ `harness.test.ts`)

**Interfaces produced:**
- `measureMs(fn: () => void, opts?: { warmup?: number; runs?: number }): number`
  — median elapsed ms over `runs` timed calls after `warmup` untimed ones. Used
  by the Layer-2 absolute smoke checks (single closure, no ratio). **Not** used
  inside `scalingRatio` — see below.
- `growthFactor(build: (n: number) => () => void, small: number, large: number, opts?: { rounds?: number }): number`
  — the **normalized** growth number: 1.0 means perfectly linear, `large/small`
  (the step) means quadratic. It runs an interleaved, order-alternated schedule
  (below), computes the median of the per-round raw ratios `t(large)/t(small)`,
  then divides by the step `large/small`. Returning normalized is the fix for the
  bound-vs-step bug: the test asserts `growthFactor < GROWTH_BOUND` with
  `GROWTH_BOUND` a small number (e.g. 2.0) regardless of the step, instead of a
  bound that has to be re-derived from the step every time and is off-by-a-factor
  the moment someone changes the step.
- `expectPerf(label: string, actual: number, bound: number): void` — records the
  measurement, then: if `process.env.PERF_ENFORCE` is set, assert `actual < bound`;
  otherwise log a PASS/BREACH line and **return without throwing**.
- A recorder that appends one JSON object per measurement to a results file
  (path from `PERF_RESULTS_FILE` env, default `./perf-results.jsonl`) and, when
  `GITHUB_STEP_SUMMARY` is set, a markdown table row.

**The `growthFactor` schedule (own all the "how" here):**
- **Warm up both sizes up front**, before any timed round — otherwise round 1
  times cold-JIT code for whichever size runs first.
- Each round takes **one raw timing per size** (not a nested `measureMs` 7-run
  median — nesting makes the runs of one size contiguous again and defeats the
  interleave). `growthFactor` owns all the medianing, across rounds.
- **Alternate the within-round order:** even rounds time small→large, odd rounds
  large→small. Plain interleaving cancels random second-to-second noise, but if
  the runner drifts busier over the job, always-small-first biases every round the
  same way and the median keeps the bias. Alternating makes drift hit both sizes
  symmetrically so it cancels.

- [ ] **Step 1: write `harness.test.ts` first (the meta-tests)**
  - `measureMs` returns a positive number, stable within tolerance across two
    calls on a trivial linear closure.
  - **Canary:** a deliberately O(n²) closure (`for i<n for j<n`) through
    `growthFactor(build, N, 8N)` returns **well above** `GROWTH_BOUND` (normalized
    ~8 for a quadratic; proves the harness detects super-linear growth).
  - **Self-consistency:** a linear closure (sum an array of length n) returns
    **below** `GROWTH_BOUND` (normalized ~1.0). *This is the test the old
    `RATIO_BOUND=8` design would have failed on correct code — normalization is
    what makes it pass.*
  - **Schedule test (guards the interleave itself):** pass a `build` whose
    closures record `(round, size)` into a log; assert the recorded sequence is
    actually interleaved *and order-alternated across rounds*, and that both sizes
    were warmed before the first timed entry. Without this, a silent regression to
    "measure all-small then all-large" passes every other test (a quadratic is
    quadratic under either schedule) — the one correction this plan fights hardest
    for would be untested.
  - **Recorder test:** after an `expectPerf` call, the results file has exactly one
    more parseable JSON line carrying the expected label and value. The whole
    informational period depends on the recorder; a silent no-op means zero
    calibration data and, because nothing gates, no failing test.
  - `expectPerf` with `PERF_ENFORCE` unset does not throw on a breach; with it set,
    throws. (Set/restore the env in the test.)

- [ ] **Step 2: implement `harness.ts`**
  - `GROWTH_BOUND = 2.0` (normalized: 1.0 = perfectly linear; calibrate from data,
    start loose). Named constant, not a magic number.
  - `growthFactor` per the schedule above: warmup-both-upfront,
    single-timing-per-round, order-alternated, median of per-round ratios,
    normalized by step. This is the load-bearing correctness code.
  - `expectPerf` routes through `PERF_ENFORCE`; recorder writes JSONL + step
    summary. No silent catch anywhere. Note in the module doc comment that vitest's
    `bench` (tinybench) was considered and rejected: mean-based, comparison-shaped,
    with no clean seam for a normalized-ratio assertion or the `PERF_ENFORCE` gate.

- [ ] **Step 3: run** `pnpm vitest run lib/perf/harness.test.ts 2>&1 | tee /tmp/perf-t1.txt` — expect PASS, canary + schedule + recorder tests included.

- [ ] **Step 4: commit** (`git add lib/perf/harness.ts lib/perf/harness.test.ts`).

## Task 2: the fixture generators

**Files:** create `lib/perf/fixtures.ts` (+ `fixtures.test.ts`)

Each generator returns Agency source of controlled size. Every generator's output
**must parse** — verify with `parseAgency` in the test (a generator that emits
invalid source silently makes `lintSource`/compile return `[]`/error and the perf
number becomes meaningless, the same failure mode as the earlier bogus benchmark).

- [ ] **Step 1: write `fixtures.test.ts`** — for every generator, at a small n,
  assert `parseAgency(gen(n), {}, false).success === true`, and assert size scales
  with n. Use the correct-syntax examples from `docs/site/guide/basic-syntax.md`
  (functions with docstrings, `map(...) { x -> ... }` block calls verified to
  parse — do NOT use `() => x` or positional lambdas; the lint spec review found
  those do not parse).

- [ ] **Step 2: implement generators:**
  - `manyFunctions(n)` — n exported functions, small bodies. A `withMissingDocstrings`
    variant (no docstring + n unused imports) for the lint findings-dense case.
  - `manyImports(n)` — n import statements from distinct modules.
  - `deepNesting(n)` — one function, n-deep nested `if`/blocks.
  - `wideUnion(n)` — an n-arm union type used across several bindings (typecheck
    stressor).
  - `oneHugeFunction(n)` — one function with n statements (paired with
    `manyFunctions` for the same total size, different shape).
  - `multiFileProject(n)` — **materializes a temp directory** of n interdependent
    `.agency` files and returns its **path**, not a string. Bundle and the build
    manifest read files from disk, so this generator is a different shape from the
    string generators — its test asserts the directory exists with n files rather
    than that a string parses.

- [ ] **Step 3: run** fixtures test, save output, **commit.**

## Task 3: lint perf tests (the motivating case), per rule

**Files:** create `lib/perf/lint.perf.test.ts`

- [ ] **Step 1:** for each rule (`unusedImportsRule`, `missingDocstringRule`,
  `redundantPreludeImportRule`), a `growthFactor` test over
  `manyFunctions.withMissingDocstrings` at `(1000, 8000)`, asserting via
  `expectPerf(`lint:${rule}`, factor, GROWTH_BOUND)`. Test **per rule** — an
  all-rules average would bury a single-rule regression (the exact reason the
  AL0002 bug hid). **Work-happened assertion:** before/outside the timed loop,
  assert the rule returned ~n findings on the 8000-size input (a fixture that
  parsed to `[]` would otherwise measure nothing and pass forever). Confirm in a
  comment that `lintSource`/`rule.run` on a string is cache-free.
- [ ] **Step 2:** a Layer-2 absolute smoke: lint the whole `stdlib/**` under a
  deliberately loose ceiling via `expectPerf`, using a generous bound derived from
  a quick local run (record it in the PR).
- [ ] **Step 3: validation** — temporarily revert the linter's indexed lookup
  (make `nameRange`/`missingDocstring` ignore the `lineIndex`, restoring the O(n²)
  scan), run with `PERF_ENFORCE=1`, and confirm the `lint:missingDocstring` ratio
  test goes **red**. Restore. Paste the before/after ratio in the PR — this is the
  direct evidence the suite catches the regression that motivated it. (Reference
  `lib/linter/rules/util.test.ts`, which already pins the indexed path against the
  scan for correctness.)
- [ ] **Step 4:** run, save output, **commit.**

## Task 4: CI wiring, informational

**Files:** create `vitest.perf.config.ts`; modify `vitest.config.ts`,
`package.json`, `.github/workflows/test.yml`

- [ ] **Step 1:** `vitest.perf.config.ts` mirroring `vitest.integration.config.ts`:
  `include: ['**/*.perf.test.ts']`, the `@`→`lib` alias, the parser setup file.
- [ ] **Step 2:** add `'**/*.perf.test.ts'` to `vitest.config.ts`'s `exclude`
  (so perf never runs in the default/watch suite), and add
  `"test:perf": "vitest run -c vitest.perf.config.ts"` to `package.json`.
- [ ] **Step 3:** add a `perf` job to `.github/workflows/test.yml` alongside
  `build`/`integration`:
  - single node **22.x** (not the matrix — one machine class, less noise).
  - steps: checkout (no persisted creds, matching the other jobs), pnpm setup,
    `pnpm install`, `pnpm test:perf`. **`make` is only needed once PR 3's
    dist-dependent tests exist** (the CLI cold-start smoke and the file-based
    incremental build); add it to the job in PR 3, not here — PR 1/2 tests all run
    from source through the `@`→`lib` alias and a full build would just tax the job.
  - **Wall-clock budget:** each `growthFactor` call is ~`WARMUP` + `2 × rounds`
    executions of the largest fixture; keep the whole `test:perf` run under ~5
    minutes. If it creeps past that, cut `rounds` or the number of fixtures per
    command before cutting sizes (size is the signal). State the observed total in
    the PR.
  - `PERF_ENFORCE` **unset**; `continue-on-error: true`.
  - upload `perf-results.jsonl` as a **stable-named artifact** every run (the
    review's correction: step-summary alone can't aggregate a cross-run p95, which
    calibration needs).
  - the concurrency `cancel-in-progress` already in the workflow may kill a perf
    run mid-measurement — acceptable while informational; note it in a comment so a
    truncated artifact isn't misread.
- [ ] **Step 4:** open PR 1. Body includes: the canary result, the Task-3
  validation before/after ratios, the local stdlib smoke number, and a statement
  that the job is informational (`continue-on-error`, `PERF_ENFORCE` unset).

---

# PR 2 — the remaining primitive commands + per-stage compile

Branch (after PR 1 merges): `adit/perf-tests-2`.

## Task 5: parse, typecheck, fmt scaling tests

**Files:** `lib/perf/parse.perf.test.ts`, `typecheck.perf.test.ts`,
`fmt.perf.test.ts`

- [ ] **parse** — `parseAgency` over `manyFunctions` and `deepNesting` at
  `[N, 8N]`. Isolate it first: parse dominated every measurement in the lint work,
  so a parser regression must not hide inside "compile."
- [ ] **typecheck** — `buildCompilationUnit`+`typeCheck` over `wideUnion` and
  `deepNesting` (union/narrowing is the classic quadratic risk).
- [ ] **fmt** — `formatSource` over `manyFunctions` and `deepNesting`.
- [ ] Each: use `growthFactor` at `(N, 8N)` via `expectPerf`; add a
  **work-happened assertion** (parse produced n functions; typecheck visited the
  union / produced scopes; fmt produced non-empty output); confirm-in-comment the
  path is cache-free (string primitives); a Layer-2 stdlib smoke where sensible;
  **commit** per command.

## Task 6: per-stage compile (on in-memory strings — no cache dance)

**Files:** `lib/perf/compile.perf.test.ts`

The lesson of the motivating bug is that per-stage isolation surfaces what an
end-to-end average buries — so isolate the pipeline stages. And **run them on
in-memory strings**, which sidesteps the parse cache entirely: `parseAgency(source,
…)` and the downstream stages do not touch `parseAgencyFileCached` (that cache
only serves the *file-based* entry, `buildSession`/`compileClosure`, which read
from disk). So the whole cache-neutralization problem does not exist for this
task — it lives only in Task 8's genuinely file-based incremental-build test.

- [ ] **Step 1:** helpers to run each stage on a size-n **string**:
  `parseAgency → SymbolTable.build → buildCompilationUnit → TypescriptPreprocessor
  → TypeScriptBuilder.build → printTs`. Each stage helper takes the previous
  stage's output; `build(n)` produces the source and runs the untimed prefix, the
  returned closure runs only the stage under test.
- [ ] **Step 2:** `growthFactor` per stage + one end-to-end string compile, at
  `(N, 8N)`, via `expectPerf(`compile:${stage}`, …)`. **Work-happened assertion**
  per stage: the parse produced n functions, the builder produced non-empty TS,
  etc. — outside the timed loop.
- [ ] **Step 3 (optional):** one **file-based** end-to-end compile measurement
  through the real disk entry, if we want to include disk I/O + cache behavior.
  That single case — and only it — uses `cacheFreePath` (Task 8) for
  neutralization. Skip it if the string end-to-end is deemed sufficient; do not
  scatter eviction across the per-stage tests.
- [ ] **Commit.**

---

# PR 3 — LSP, and the other commands

Branch (after PR 2 merges): `adit/perf-tests-3`.

## Task 7: LSP hot paths

**Files:** `lib/perf/lsp.perf.test.ts`

- [ ] **runDiagnostics** — the debounced-keystroke path; `growthFactor` over a
  large `manyFunctions` document vs document size. Build the `TextDocument` +
  `SymbolTable` the way `lib/lsp/diagnostics.test.ts` does (reuse its
  `makeDoc`/`emptySymbolTable` pattern). Work-happened assertion: it returned
  diagnostics for the document.
- [ ] **getCodeActions** — timing on a document with many fixable findings; assert
  it returned actions.
- [ ] **re-diagnose scaling** (replaces the vague "incremental" case) —
  `runDiagnostics` re-parses the whole document every call today (there is no
  incremental fast-path; `diagnostics.ts` calls `parseAgency` on full source), so
  "re-run vs first run" has no failure condition and must not be written that way.
  Instead: `growthFactor` on **re-diagnosis time vs document size** — diagnose,
  apply a one-line edit, re-diagnose, and assert re-diagnosis stays linear in doc
  size. That *would* catch a future super-linear edit/re-parse path; the pairwise
  "re-run ≈ first run" comparison would not.
- [ ] **Commit.**

## Task 8: the other commands

**Files:** `lib/perf/doc.perf.test.ts`, `lib/perf/misc.perf.test.ts`,
`lib/perf/incrementalBuild.perf.test.ts`

- [ ] **doc** — walks every def; `scalingRatio` over `manyFunctions` with
  docstrings.
- [ ] **lsp sub-paths** — completion, hover, semantic tokens over a large document
  (each a per-keystroke interactive path).
- [ ] **bundle** — `multiFileProject` scaling.
- [ ] **CLI cold-start smoke** — the one deliberate shell-out: time `node
  dist/scripts/agency.js --version` once, loose absolute ceiling via `expectPerf`.
  **Guard it to skip when `dist/` is absent** (with a clear skip message) so
  `pnpm test:perf` still works from source locally; in CI the job's `make` provides
  `dist/`.
- [ ] **incremental build** — its **own file with own setup/teardown**: a temp
  working dir, a **cold** build, then a **warm** build, asserting warm is a small
  fraction of cold (a ratio that also guards against the cache silently going
  cold). All parse-cache neutralization goes through **one helper**,
  `cacheFreePath(source)` in the harness (write `source` to a fresh unique temp
  path each call — the cache key is the **path**, `${t|r}:${absPath}`, so a new
  path guarantees a miss; hold **content fixed**, vary only the path, since varying
  content would vary the workload the ratio is trying to hold constant). Do not
  re-implement eviction per test — that leaks `parseAgencyFileCached`'s internals
  into every test body (a leaky abstraction). **Assert the cold leg actually missed
  the cache** (via `parseCache`'s exported `_internal`/`stats`, e.g. misses
  incremented) rather than assuming isolation — a prior test's warm entry leaking
  in makes cold≈warm and the ratio false-fails. This is the operationally hardest
  test; budget for it.
- [ ] **Commit**, open PR 3.

---

# Milestone (operational, not code): calibrate, then flip to gating

Not a task in this plan — a follow-up after PR 3 has been on `main` long enough to
gather data. Recorded here so it is not forgotten:

0. **Assign an owner and cadence for reading the informational data.** With
   `PERF_ENFORCE` unset and `continue-on-error`, a real O(n²) regression merges
   **green** during this window — the only thing catching it is a human reading the
   artifacts. Name who checks the `perf-results.jsonl` artifacts and how often
   (e.g. weekly), or accept that the window has zero automated regression
   protection with eyes open. This is the honest answer to "will the test fail if
   the code breaks?" during informational: not until the flip.
1. Collect ~30 informational runs across `push` and PR events from the uploaded
   `perf-results.jsonl` artifacts.
2. For each test, take the worst observed normalized `growthFactor` (p95) and set
   `GROWTH_BOUND` (and the Layer-2 ceilings) at a comfortable margin above it.
   **Watch for a command whose baseline factor sits suspiciously close to the
   bound** — that means its fixture N is too small to separate its plausible
   regressions from noise (a small-coefficient quadratic can read as linear until N
   is large enough), so grow that command's N rather than loosening the bound. Keep
   sizes in a sane memory regime — a linear pass whose 8× input blows cache can
   read as super-linear, so do not push N so high that memory bandwidth dominates.
   Note that **only lint is end-to-end validated** (Task 3's revert-to-O(n²)
   proof); the other commands lean on the canary + work-happened assertions as a
   weaker substitute, so treat their baselines with a bit more suspicion.
3. **The flip:** set `PERF_ENFORCE=1` in the `perf` job and remove
   `continue-on-error`. Tests are unchanged. The flip is reversible in one line if
   a new runner class starts tripping bounds — say so in the PR that flips it, to
   lower the stakes of turning it on.

## Self-review notes

- **Spec + all three review passes folded:** interleaved, **order-alternated**
  sampling with single-timing-per-round and a **normalized** growth factor
  (Task 1 — `growthFactor` returns 1.0 for linear regardless of step, which fixes
  the `RATIO_BOUND=8`-vs-8×-step bug that would have failed correct code);
  cache-free per-stage compile on strings, neutralization confined to the one
  file-based path via a single `cacheFreePath` helper (Tasks 6, 8); `formatSource`
  not `format` (Task 5); artifact upload for calibration (Task 4); node 22.x single
  version (Task 4); `bench`/tinybench considered and rejected — noted in the
  harness doc comment; `multiFileProject` returns a temp-dir path, not a string
  (Task 2).
- **Tests that would otherwise pass regardless of the code — now guarded:** a
  **work-happened assertion** on every perf test (global constraint) so a bogus
  fixture can't measure nothing and pass forever; a **schedule test** that fails if
  the interleave/alternation isn't implemented (Task 1); a **recorder test** so the
  informational data can't silently be empty (Task 1); the LSP "incremental" case
  **redefined** as re-diagnosis-vs-doc-size scaling because there is no incremental
  fast-path today (Task 7).
- **Honest about coverage:** only lint is end-to-end validated by injecting a known
  regression (Task 3); the others rely on the canary + work-happened assertions,
  and the informational window has no automated protection until a human reads the
  data (Milestone step 0) or the flip happens.
- **Deliberately deferred:** automated cross-commit baseline gating (Layer 3 stays
  human-read), profiling on regression, perf tests for LLM-bound commands.
