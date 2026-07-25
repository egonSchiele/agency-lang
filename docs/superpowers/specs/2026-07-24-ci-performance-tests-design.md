# Design: performance regression tests in CI

Date: 2026-07-24
Status: Draft for review
Location note: paths in this doc are relative to `packages/agency-lang` unless
they start with `.github/`, which is repo-root.

## Summary

We have been making a run of changes where performance matters — the most recent
being a fix to the linter that turned an accidental O(n²) pass back into a linear
one (a 433 KB file went from ~1235 ms to ~13 ms). That bug shipped and sat latent
because **nothing in CI watches for performance regressions**. This document
designs a set of tests that do.

The hard part is not measuring time — it is measuring time *on a CI runner
without the test becoming flaky*. Shared GitHub runners have variable CPU
contention, so a test that asserts "compile finishes in under 500 ms" will
false-fail on a busy runner and silently stop protecting anything as machines get
faster. The design below leads with that problem and builds around it.

The core idea: **assert on how work grows with input size, not on absolute
milliseconds.** A linear algorithm run on a 4×-larger input should take roughly
4× as long; if it takes 15× as long, something went quadratic. That ratio is
measured on the same machine in the same process, so the machine's absolute speed
cancels out and the test stays meaningful whether the runner is fast, slow, or
busy. This "scaling ratio" check is the primary defense, and — this is the point
— it is exactly the shape of check that would have caught the linter bug.

We will run these **informational-only at first**: the perf job executes,
records its measurements, and reports, but does **not** block merges. That lets
us calibrate the thresholds against real observed runner noise for a few weeks
before flipping the job to gating. Turning on enforcement too early trains
everyone to ignore a flaky red check; turning it on with calibrated thresholds
makes it trustworthy.

Commands covered: **parse, compile, typecheck, fmt, lint, lsp**, plus a short
list of others argued for at the end (**doc**, incremental build, and a couple of
LSP sub-paths).

## Background

### Why absolute-time assertions fail on CI

A test like `expect(compileMs).toBeLessThan(500)` has three failure modes on a
shared runner, all bad:

1. **False failures.** A noisy-neighbor VM steals CPU, the run takes 700 ms, the
   PR goes red for a reason unrelated to the change. People learn to re-run until
   green, which is the same as having no test.
2. **Silent rot.** Runners get faster over time. A budget set at 500 ms when the
   real time was 300 ms will still pass at 480 ms even after a regression doubled
   the real work — the test passes while the thing it guards degrades.
3. **Un-portable thresholds.** The number that is right on a maintainer's laptop
   is wrong on the runner and wrong again on the next runner generation.

The fix is to stop asserting absolute numbers wherever possible and assert
*relative* ones instead (Layer 1 below). Absolute budgets still have a place, but
only as coarse "did something catastrophic happen" smoke checks with deliberately
loose ceilings (Layer 2).

### How this repo runs tests today

- The unit suite is plain **vitest** (`vitest.config.ts`), run in CI via
  `pnpm test:run` on an `ubuntu-latest` matrix of node 22.x and 23.x
  (`.github/workflows/test.yml`). Jobs fan out — `build`, `integration`,
  `agent-tests` — so slow suites run concurrently rather than serializing.
- There is already a **precedent for a separate, differently-configured vitest
  run**: `vitest.integration.config.ts` + the `test:integration` script drive the
  gated integration suite apart from the default unit run. The perf suite will
  follow that exact pattern with its own config and script.
- `vitest.config.ts` includes `**/*.test.ts` and excludes `tests/`, `dist/`,
  `runs/`, `.worktrees/`. A perf file named `*.perf.test.ts` would be picked up by
  the default run unless we exclude it — we will, so perf never runs in watch mode
  or in the normal unit job.

### The commands are callable as library functions

Every command we care about has a programmatic entry point, so the tests call the
algorithm directly instead of shelling out to the CLI:

- **parse** → `parseAgency(source, config, applyTemplate)` (`lib/parser.ts`)
- **compile** → the full pipeline (`parse → SymbolTable.build →
  buildCompilationUnit → TypescriptPreprocessor → TypeScriptBuilder.build →
  printTs`), reachable through the same compile entry the CLI uses
  (`lib/cli/commands.ts` / `lib/compiler/`).
- **typecheck** → `buildCompilationUnit(...)` then `typeCheck(program, config,
  info)` (`lib/typeChecker/index.ts`).
- **fmt** → `format(source, config)` (`lib/cli/commands.ts`).
- **lint** → `lintSource(source, filePath, config)` (`lib/linter/registry.ts`),
  and each rule's `run(ctx)` directly for per-rule isolation.
- **lsp** → `runDiagnostics(doc, fsPath, config, symbolTable)`
  (`lib/lsp/diagnostics.ts`) — this single call *is* the debounced-keystroke hot
  path — plus `getCodeActions(...)` (`lib/lsp/codeAction.ts`).

Calling these directly matters for accuracy: shelling out to `node
dist/scripts/agency.js` adds ~150–300 ms of process startup and module-load per
invocation, which both swamps the signal and adds its own variance. We measure
the algorithm, not node's boot time. (A single deliberate cold-start smoke test is
the one exception — see "Other commands".)

## Goals and non-goals

**Goals**

- Catch algorithmic regressions — an accidental O(n²), a newly-quadratic
  typechecker path — before they merge.
- Stay non-flaky on shared CI runners.
- Require no dedicated hardware or stored cross-run baseline to function (the
  primary layer is self-contained per run).
- Be cheap to read: a maintainer should see *which* command regressed and *by how
  much* without decoding a benchmark harness.

**Non-goals**

- Micro-benchmarking or chasing single-digit-percent drift. Runner noise is
  larger than that; pretending otherwise is how you get a flaky suite.
- Measuring LLM-bound execution (`run`, `optimize`, `eval`) — those are dominated
  by network and model latency, not our code, and are nondeterministic.
- Being a profiler. These tests say "something got slower"; they do not say where.

## Design

### The three layers

**Layer 1 — scaling ratio tests (primary, gating-eligible).**
Run a command at input sizes N, 2N, 4N in the same process and assert the growth
ratio stays near-linear. For a linear algorithm, `time(4N) / time(N)` is about 4;
we assert it is below a generous bound (say 6) so the check trips only on genuine
super-linear behavior and tolerates ordinary noise. Because it is a ratio of two
measurements on the same machine in the same run, the machine's absolute speed
divides out — this is what makes it CI-robust without a baseline.

Concretely, this is the check that catches our motivating bug. The linter's AL0002
rule measured, before the fix:

```
1000 functions →   79 ms
4000 functions → 1235 ms       ratio 4000/1000 = 15.6×   (4× input, 15× time)
```

A `ratio < 6` assertion fails hard on 15.6×. After the fix it was 3.1 ms → 13 ms,
ratio ~4.2, comfortably under 6. That is the whole thesis in one example.

**Layer 2 — coarse absolute smoke budgets (gating-eligible, loose).**
A handful of "did the pipeline catch fire" checks with deliberately generous
ceilings — e.g. "compile the entire stdlib in under 10 s" where the real time is
~1–2 s. These catch gross regressions, infinite loops, and accidental
re-computation that a ratio test could miss (e.g. a constant-factor 5× slowdown
that scales linearly). The ceilings are set at ~5–10× observed time so runner
noise never trips them; they are a floor of protection, not a precision
instrument.

**Layer 3 — trend recording (informational, never gating).**
Each run appends its measurements to the GitHub Actions **step summary** (and
optionally an artifact) so we can eyeball drift across commits. This is not an
assertion; it is the data we use during the informational period to set Layer 1's
ratio bounds and Layer 2's ceilings from *observed* variance rather than guessing.
Long-term it stays as a human-readable record; we deliberately do not build
automated cross-commit baseline comparison in v1 (too flaky to gate, and the ratio
tests already cover the regressions that matter).

### The measurement harness

One small helper, home `lib/perf/harness.ts` (new), keeps every perf test honest
and identical:

```ts
/** Run `fn` `runs` times after `warmup` untimed runs; return the MEDIAN
 *  elapsed ms. Median (not mean) discards the occasional runner hiccup;
 *  warmup lets the JIT settle so we time steady-state, not first-call
 *  compilation. */
export function measureMs(fn: () => void, { warmup = 2, runs = 7 } = {}): number;

/** median(times(4N)) / median(times(N)); the CI-robust growth number. */
export function scalingRatio(
  build: (n: number) => () => void,   // build the work closure for size n
  small: number,
  large: number,
): number;
```

Rules the harness enforces:

- **Warm up before timing** (JIT steady-state), **median of an odd K** (default 7)
  to shrug off single hiccups, `performance.now()` for the clock.
- **Library-level only** — the closures call `parseAgency` / `typeCheck` /
  `lintSource` / `runDiagnostics` / `format`, never spawn a process.
- **No shared mutable state between sizes** — each size builds its own source and
  its own closure, so N's run cannot warm caches that flatter 4N (which would hide
  a regression).

### Fixtures: synthesized generators plus the real stdlib

Two fixture sources, each with a job:

- **Synthesized generators** (in `lib/perf/fixtures.ts`, new) produce
  controlled-size inputs so scaling tests can pick exact N and 2N and 4N and grow
  arbitrarily large. Each generator targets a shape that stresses a particular
  algorithm:
  - `manyFunctions(n)` — n exported functions with small bodies. General
    parse/compile/typecheck/fmt/lint load; also the *findings-dense* case for lint
    (n exported functions with no docstring, n unused imports).
  - `manyImports(n)` — n import statements. Stresses import resolution and the
    unused-import walk.
  - `deepNesting(n)` — one function whose body is n-deep nested `if`/blocks.
    Stresses recursive descent in the parser, generator, and type checker.
  - `wideUnion(n)` — a type that is an n-arm union, used across many bindings.
    Type checkers commonly go quadratic on union handling and narrowing, so this is
    the typecheck-specific stressor.
  - `oneHugeFunction(n)` vs `manyFunctions(n)` — same total size, different shape;
    catches per-function-overhead regressions.
- **The real stdlib** (`stdlib/**/*.agency`) is the fixed representative corpus for
  the Layer 2 absolute smoke budgets. It is realistic and always present. Its one
  drawback — it changes over time, which shifts absolute numbers — is exactly why
  it feeds the *loose* absolute layer and not the ratio layer.

### Informational-first, and how the flip works

The suite starts informational and becomes gating with a one-line change, via an
environment gate rather than by rewriting tests:

- Every Layer 1/2 assertion goes through a harness function
  `expectPerf(actual, bound, label)` that, when `PERF_ENFORCE` is unset (the
  default, and the informational period's setting), **records** the
  measurement-and-verdict to the step summary and **always passes**; when
  `PERF_ENFORCE=1`, it **fails** on a breach like a normal assertion.
- The perf CI job runs with `PERF_ENFORCE` unset during calibration. It is also
  marked `continue-on-error: true` as a belt-and-suspenders so even an unexpected
  throw cannot block a merge while we are learning the noise profile.
- **The flip** is: set `PERF_ENFORCE=1` in the job and drop `continue-on-error`.
  Nothing about the tests changes.
- **What we do during the informational weeks:** read the recorded ratios and
  absolute times across many runs (different runners, different loads), take the
  worst observed ratio for each test, and set each bound at a comfortable margin
  above it (e.g. observed p95 ratio 4.6 → bound 6). Then flip.

## Per-command test matrix

Each command gets a scaling-ratio test (Layer 1) and, where a fixed corpus makes
sense, a stdlib smoke budget (Layer 2). Entry points and the stressing fixture:

| Command | Entry point | Scaling fixture | Notes |
|---|---|---|---|
| **parse** | `parseAgency` | `manyFunctions`, `deepNesting` | Isolate it first — parse dominated every measurement in the lint work, so a parser regression must not hide inside "compile." |
| **compile** | full pipeline | `manyFunctions`, `oneHugeFunction` | End-to-end. Run both shapes; they exercise different hot paths. |
| **typecheck** | `buildCompilationUnit`+`typeCheck` | `wideUnion`, `deepNesting` | Union/narrowing is the classic quadratic risk, more than function count. |
| **fmt** | `format` | `manyFunctions`, `deepNesting` | AgencyGenerator recursion. |
| **lint** | each rule's `run`, and `lintSource` | findings-dense `manyFunctions` | **Per rule.** The AL0002 O(n²) only showed when measured per rule; an all-rules average would have buried it. |
| **lsp** | `runDiagnostics` | `manyFunctions` | This one call is the per-keystroke path (parse+resolve+typecheck+lint+semantic index). Add a `getCodeActions` timing, and an **incremental** case: diagnose, edit one line, re-diagnose — that is what an editor actually does. |

For lint specifically, the per-rule tests double as a permanent guard on the exact
class of bug we just fixed: a rule that emits one finding per declaration must
scale linearly in file size, and `scalingRatio` on findings-dense input asserts it.

## Other commands worth covering

Beyond the six asked for:

- **`doc`** (`agency doc`) — walks every definition and is string-heavy; regresses
  on large corpora. Worth a scaling test on `manyFunctions` with docstrings.
- **Incremental build / manifest** — the build cache is where "performance over
  time" bites hardest as the stdlib grows. Measure **cold** build vs **warm**
  (cache-hit) build time, and assert the warm build is a small fraction of cold
  (a ratio check that also guards cache *correctness*-adjacent behavior: a warm
  build that stopped hitting the cache would show up as warm≈cold).
- **LSP sub-paths** — completion, hover, and semantic tokens are each
  per-keystroke interactive paths a user feels directly; a scaling test on each
  (large document) is cheap insurance beyond diagnostics.
- **`bundle`** — multi-file assembly; scaling test on a synthesized multi-file
  project.
- **CLI cold-start smoke** — the one deliberate shell-out: time `node
  dist/scripts/agency.js --version` once, with a loose absolute ceiling. Every
  invocation pays module-load, so this catches a dependency that bloats startup.
  Kept separate and loose because it is inherently the noisiest measurement.

**Explicitly skipped:** `run` / `test` execution and `optimize` / `eval`
(LLM-bound, nondeterministic), and `explain` (trivial constant-time lookup).

## CI wiring

- **`vitest.perf.config.ts`** (new) — mirrors `vitest.integration.config.ts`:
  includes only `**/*.perf.test.ts`, inherits the `@`→`lib` alias and the parser
  setup file.
- **`vitest.config.ts`** — add `**/*.perf.test.ts` to `exclude` so perf tests
  never run in the default unit suite or in watch mode.
- **`package.json`** — a `test:perf` script (`vitest run -c
  vitest.perf.config.ts`).
- **`.github/workflows/test.yml`** — a new `perf` job alongside `build` /
  `integration` / `agent-tests`, running `pnpm install && make && pnpm test:perf`.
  During the informational period: no `PERF_ENFORCE`, and `continue-on-error:
  true`. Run on a **single** node version (not the 22/23 matrix — perf numbers do
  not need matrixing and a single job halves the noise sources) and pin the runner
  label so measurements come from one machine class.
- Results go to the job's **step summary** as a small table (command, size,
  median ms, ratio, verdict), so the numbers are visible on every run without
  digging into logs.

## File structure

New:

- `lib/perf/harness.ts` — `measureMs`, `scalingRatio`, `expectPerf`, the
  step-summary recorder.
- `lib/perf/fixtures.ts` — the generators (`manyFunctions`, `manyImports`,
  `deepNesting`, `wideUnion`, `oneHugeFunction`, a multi-file project builder).
- `lib/perf/*.perf.test.ts` — one file per command area (`parse.perf.test.ts`,
  `compile.perf.test.ts`, `typecheck.perf.test.ts`, `fmt.perf.test.ts`,
  `lint.perf.test.ts`, `lsp.perf.test.ts`, and the "other" ones).
- `vitest.perf.config.ts`.

Modified: `vitest.config.ts` (exclude), `package.json` (script),
`.github/workflows/test.yml` (job).

## Validating the tests themselves

A perf test that never fails is worse than none. Two meta-checks:

- **A known-quadratic canary.** Include one test that runs a deliberately O(n²)
  synthetic function through `scalingRatio` and asserts the ratio is *above* the
  bound — proving the ratio machinery actually detects super-linear growth. If this
  canary ever passes-as-linear, the harness is broken.
- **Self-consistency.** A trivial linear closure (e.g. summing an array) run
  through `scalingRatio` must land near its input ratio within tolerance across
  local runs before we trust the harness on real commands.

During review of the eventual PR, we also confirm the AL0002-shaped lint test
would have failed on the pre-fix code (temporarily revert `locFromOffsets` to the
scanning version behind the test and watch the ratio test go red), as direct
evidence the suite catches the very regression that motivated it.

## Open questions for review

1. **Ratio bound.** Proposed `< 6` for a 4× input step (linear ≈ 4). Calibrate
   from the informational data, but is 6 a sane starting point, or start looser
   (8) and tighten?
2. **How long informational.** Two weeks of runs, or a fixed number of runs (say
   30) across enough runners to see the variance, before flipping `PERF_ENFORCE`?
3. **Node version for the perf job.** Single version to reduce noise — 22.x (LTS)
   or the newer 23.x? I lean 22.x as the stable reference.
4. **Trend recording destination.** Step summary only (simple, ephemeral), or also
   push to a small committed/artifacted history so drift is graphable over months?
   I lean step-summary-only for v1 and revisit if we want graphs.

## Out of scope

- Automated cross-commit baseline comparison and % -regression gating (Layer 3
  stays human-read for now).
- Profiling/flame-graph capture on regression (these tests detect, they do not
  diagnose).
- Perf tests for LLM-bound commands.
- Dedicated bare-metal perf hardware. The whole design is built to be robust on
  the shared runners we already have; if we later want single-digit-percent
  precision, dedicated hardware is the follow-up, not a prerequisite.
