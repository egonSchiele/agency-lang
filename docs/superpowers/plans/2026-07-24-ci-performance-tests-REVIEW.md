# Review: CI performance regression tests — implementation plan

Reviewer: Claude
Date: 2026-07-24
Reviewing: `2026-07-24-ci-performance-tests.md`
Against: the design spec + its `-REVIEW.md`, and the code.

## Verdict

Approve with changes. This is a good plan — it folds in every correction from the
spec review (interleaving, `formatSource`, bound at 8, artifact upload, per-stage
compile, node 22.x, `bench` rejected, canary/validation as first-class steps) and
it caught a real thing both the spec and my first review missed: the process-wide
parse cache. The task breakdown and PR staging are sound.

But two of the plan's own load-bearing corrections are themselves not quite right,
and one is actively harmful as written. Fix these before executing — the plan is
what a worker will follow literally, so a wrong instruction here becomes a wrong
test.

## Verified against the code

- **Every entry point is now correct.** On `origin/main`: `unusedImportsRule`,
  `missingDocstringRule`, `redundantPreludeImportRule` (`registry.ts:9-12`);
  `runDiagnostics(doc, fsPath, config, symbolTable)` (`diagnostics.ts:78`, and it
  calls `parseAgency(source, config, false)` internally — the string path, so it
  is genuinely cache-free as the plan claims); `typeCheck(program, config, info)`
  (`index.ts:519`); `formatSource(...): string | null` (`formatter.ts`);
  `getCodeActions` (`codeAction.ts:57`). The `makeDoc`/`emptySymbolTable` helpers
  Task 7 wants to reuse exist in `diagnostics.test.ts:10,14`. ✅
- **#672 has merged to `origin/main`.** The three lint rules are present there, so
  PR 1 branching from `origin/main` will have `missingDocstringRule` and
  `redundantPreludeImportRule` to test. (This was *not* true when I reviewed the
  lint-fix spec an hour ago — good that the plan branches from `origin/main`, not
  a stale local `main`, which at session start was behind.) ✅
- **The parse cache is real and the plan's description of it is accurate** —
  `evictParseCache(absPath)` (`parseCache.ts:68`), `parseAgencyFileCached`
  (`:73`). Good catch; this genuinely would have corrupted a naive compile ratio.

## Issue 1 (harmful as written): "unique path + content" varies the workload

Task 6 Step 2 says give "each timed run a unique synthesized **path+content** (so
the cache key never repeats)." I read `parseCache.ts`: the key is
`` `${applyTemplate?'t':'r'}:${absPath}` `` validated by `mtimeMs` **and** `size`
(`:88-96`). The key is the **path**. So:

- Varying the **path** per run already guarantees a miss. Correct.
- Varying the **content** per run is not needed for the cache — and it is
  *harmful*, because it changes the work being measured from run to run. The whole
  point of the N-vs-8N ratio is that the work at each size is fixed; varying
  content per run injects exactly the variance the ratio is trying to eliminate.

Fix: **hold content fixed, vary only the path** (write the same synthesized source
to a fresh temp path each timed run), or call `evictParseCache(absPath)` between
runs on one stable path. Drop "content" from the instruction.

## Issue 2 (altitude / simplification): most of Task 6 doesn't need the cache dance at all

Task 6 Step 1 lists per-stage helpers (`parse → SymbolTable.build →
buildCompilationUnit → TypescriptPreprocessor → TypeScriptBuilder.build →
printTs`). If those helpers run on an **in-memory string** — calling
`parseAgency(source, …)` directly, the way the parse/lint/fmt tests already do —
they never touch `parseAgencyFileCached`, and the entire cache-neutralization
problem **disappears** for the per-stage tests. The cache only bites the
**file-based compile entry** (`buildSession`/`compileClosure`, which read from
disk) and the incremental-build test (manifest + disk, Task 8), which is
inherently file-based.

Right now Step 1 (string-shaped stage functions) and Step 2 (file-based cache
neutralization) describe two different lanes as if they were one. Pick:

- **Per-stage isolation on strings** (recommended): cache-free, no temp files, no
  eviction, and it still catches a quadratic in any stage. This is the simpler and
  more faithful "isolate the stages" test.
- **A single end-to-end file-based compile** measurement *in addition*, if you
  want to time the real CLI entry including disk I/O — and *that* one needs Issue-1
  neutralization.

Collapsing Task 6 onto the string lane removes a whole class of fragility from the
plan's hardest-to-get-right PR. Neutralization then lives only where it is truly
unavoidable: Task 8's incremental build.

## Issue 3 (correctness of the core mechanism): the interleave doesn't cancel *drift*

The plan's interleave (Task 1): "one round measures each size once **in order**;
repeat `pairs` rounds; ratio = median over rounds of `t_round(large)/t_round(small)`."

Measuring "in order" means within every round the small size is always timed
*before* the large size. That cancels *random* second-to-second noise (good, and
the reason to interleave), but it does **not** cancel *monotonic drift*: if the
runner gets progressively busier over the job's lifetime, large is systematically
timed later-and-busier than small in every round, biasing the ratio up the same
way each time. Median over rounds does not remove a bias that is present in every
round.

Fix: **alternate the within-round order** (round k even: small, large; round k odd:
large, small), or randomize it. Then drift hits small and large symmetrically
across rounds and cancels in the median. It is a one-line change to the schedule
and it closes the last hole in the "ratio is robust" argument.

Two smaller harness clarifications while you are in there:

- **Where does warmup live?** `measureMs` warms per call, but the interleaved
  schedule in `scalingRatio` needs *both* closures warm before round 1, or round 1
  times cold-JIT code for one size. Specify that warmup runs for every size up
  front, before the timed rounds begin.
- **Two-level averaging is ambiguous.** `measureMs` already takes a 7-run median;
  `scalingRatio` then takes a median over rounds. Is each round one raw timing per
  size, or a full `measureMs` (7 runs) per size? Pin it down — "raw single timing
  per size per round, `scalingRatio` owns all the medianing" is cleanest and makes
  interleaving meaningful (nesting a 7-run median inside each round defeats the
  point of interleaving, because the 7 runs of one size are contiguous again).

## Issue 4: `multiFileProject(n)` can't be a string generator

Task 2 Step 2 lists `multiFileProject(n)` among generators that "return Agency
source." A multi-file project — used by bundle (Task 8) and conceptually by
incremental build — cannot be one source string; bundle and the manifest read
**files from disk**. This generator must materialize a temp directory of files and
return its path, a different shape from the string generators. Call that out so the
worker doesn't try to return a string and then discover bundle needs paths.

## Smaller notes

- **`scalingRatio` returns `number[]`, tests treat it as a scalar.** The canary
  (Task 1 Step 1) and lint tests (Task 3) say "a ratio" and call
  `expectPerf(label, ratio, bound)`. With a 2-element `sizes` array there is one
  pair, so `ratio = result[0]`. Fine, but make the array-indexing explicit in the
  interface note so nobody passes a `number[]` where `expectPerf` wants a `number`.
- **Two-point-wide-step resolves the spec's contradiction — good.** My spec review
  flagged the prose (N,2N,4N) vs the two-point API. The plan resolves it by
  committing to two points with a wide **8×** step everywhere (`[N, 8N]`). That is
  a legitimate resolution (I offered it as one of two options); the 64× quadratic
  signal against a bound of 8 is comfortable. No change needed — just noting it was
  a real choice, not an oversight.
- **The Task 3 validation revert is described correctly now.** "Make
  `nameRange`/`missingDocstring` ignore the `lineIndex`, restoring the O(n²) scan"
  matches `util.ts`, whose indexed helpers fall back to a linear scan when no index
  is supplied — so passing no index *is* the revert. Referencing `util.test.ts`
  (which already pins indexed==scan) is the right touch. ✅
- **`make` in the perf job for PR 1/PR 2.** Kept "harmless now, needed for PR 3."
  True, but it adds a full build to perf jobs that only run string-level tests. Not
  worth blocking on; if the perf job's wall-clock gets tight, gate `make` to PR 3.
- **Job wall-clock still unbudgeted.** The spec review asked for a rough time
  budget and a max N; the plan inherits `[N, 8N]` and `pairs` rounds but never
  estimates the job's total minutes. Worth a sentence in Task 4 so the
  informational job doesn't quietly become a 15-minute tax on every PR.

## Anti-patterns audit (`docs/dev/anti-patterns.md`)

Checked the plan's prescribed interfaces against the catalog, with focus on the
"declarative interface encapsulates complexity, imperative code hidden" rule
(the "Imperative code everywhere" entry).

**Where it's right — the harness is a clean "what vs how" split.** The three
harness interfaces are exactly the pattern the catalog endorses:

- `scalingRatio(build, sizes)` owns the hard "how" (interleaving, median of
  per-pair ratios, drift, warmup ordering); a test declares only *what* — "does
  lint scale under `RATIO_BOUND`." The plan is explicit ("the harness must own
  this schedule").
- `expectPerf(label, actual, bound)` collapses the informational-vs-gating
  decision into one gate. Tests never branch on `PERF_ENFORCE` or write the step
  summary — that "how" lives in one place, which is *why* the flip to gating is a
  one-line change. This is the strongest encapsulation in the plan.
- `measureMs` hides warmup/median/clock behind "median ms of this closure."

It also actively avoids other catalog entries: named constants (`RATIO_BOUND`,
`WARMUP`, `RUNS`) over magic numbers; "No silent catch anywhere" (Task 1 Step 2);
heavy reuse over duplication (`vitest.integration.config.ts`, `diagnostics.test`
helpers, `evictParseCache`, `util.test.ts`, `bench` considered-and-rejected). No
nested ternaries, one-line ifs, order-dependent mutable state, or
catastrophic-failure tests (the canary asserts ratio *above* bound — safe).

**The one real leak — cache neutralization is imperative "how" in the test
bodies.** Task 6 Step 2 / Task 8 prescribe "unique path+content OR
`evictParseCache` before each run" plus a hand-written "two timings within noise"
proof *inside each compile/incremental test*. That leaks the parse cache's
internals (`parseAgencyFileCached`) into the "what" layer — every such test must
know the cache exists and re-implement the workaround. This is both "Imperative
code everywhere" and a "Leaky abstraction." Fix consistently with the rest of the
harness: **one helper** (`measureFreshCompile(source, size)` /
`cacheFreePath(source)`) owns the eviction/unique-path mechanics and the
cache-miss self-check once; tests stay declarative. (Overlaps Issue 2: run the
per-stage tests on in-memory strings and the leak only survives in Task 8's
file-based incremental test, where the single helper is even more clearly right.)

**Smaller gap — the timing boundary is an unstated contract.** `build: (n) => ()
=> void` is the seam that keeps fixture generation *out* of the timed section, but
the plan never says so. A worker who builds the source inside the inner closure
times string concatenation, not the algorithm — the "how" (what's timed) leaks
silently. State it: `build(n)` does untimed setup; the returned closure is
timed-work-only.

## Test efficacy audit — will these tests fail when the code breaks?

For a perf suite this is the whole ballgame: perf tests are the classic "test
that can never fail." I walked each prescribed test asking "if the thing it
guards regressed, does it go red?" Several answer *no* as written. Ranked by how
badly they undercut the suite's purpose.

### A. (Bug) `RATIO_BOUND = 8` with an 8× step makes a *linear* algorithm fail

This is a concrete arithmetic error, not a judgment call. The plan sets the step
to 8× (`sizes [N, 8N]`, `[1000, 8000]`) **and** `RATIO_BOUND = 8`, asserting
`ratio < bound`. A perfectly linear algorithm's ratio at an 8× step is **≈ 8** —
which is *not* `< 8`. So:

- The **self-consistency meta-test** (Task 1: "a linear closure returns a ratio
  **below** `RATIO_BOUND`") is a coin-flip-to-guaranteed **false failure** — a
  linear sum lands at ~8, above or at the bound.
- **Every real linear command test** sits exactly on the failure threshold; the
  first bit of noise pushes it red once enforcing.

The bound must be comfortably **above** the step, not equal to it. With a 4× step
the spec's "bound 6" gave a 1.5× margin; to preserve that with an 8× step the
bound should be **~12–16**. Alternatively, normalize: have `scalingRatio` return
`ratio / step` (so linear ≈ 1.0, quadratic ≈ step) and keep a small bound like
1.5. Either way, fix this before writing any test — right now the canary passes
(64 ≫ 8) but the linear side is broken, so the suite would flag *correct* code.

### B. No test asserts the measured work actually happened — the bogus-benchmark trap

The plan applies "the fixture must parse" lesson to `fixtures.test.ts`, but **not**
to the perf tests themselves. A perf test that calls the wrong entry point, or
measures a fixture that silently parsed to `[]`, or uses a size too small to do
real work, produces a clean ratio (~1) and **passes forever, including after a
regression.** This is precisely the "earlier bogus benchmark" failure the plan
cites — and it's un-guarded at the measurement site.

Every perf test needs a cheap **work-happened assertion** outside the timed loop:
the parse produced N functions; `lintSource` returned N findings; compile produced
non-empty TS; typecheck visited the union. Without it, "measures nothing" and
"measures linear work" are indistinguishable, and only the second is intended.
(This also subsumes note H below — assert finding/output *count* == n, not just
that source length grew.)

### C. The load-bearing interleaving fix has no test that fails if it's not done

The plan's headline correctness change is interleaved sampling with
median-of-per-pair-ratios. But the canary and self-consistency tests **pass
equally well against a naive "median of all-small then all-large"
implementation** — a quadratic is quadratic under either schedule. So nothing
fails if a worker (or a later refactor) implements the naive version. The one
correction the plan fought hardest for is untested.

Add a schedule unit test: have `build` record the order/size of each invocation
and assert the recorded sequence is actually interleaved (and that warmup ran for
both sizes before the first timed round). That's the only thing that will catch a
silent regression to non-interleaved sampling.

### D. During the informational period, *no* perf test can fail — say so plainly

With `PERF_ENFORCE` unset and `continue-on-error: true`, a real O(n²) regression
merges **green** for the entire calibration window. That's the intended trade, but
it means the honest answer to "if the code breaks will the test fail?" is "not
until the flip." The only thing catching a regression during informational is a
human reading the artifact — and nothing in the plan assigns that. Either name an
owner/cadence for reading the informational data, or accept weeks of zero
regression protection with eyes open. This belongs in the Milestone section.

### E. Only lint has end-to-end regression validation; the rest lean on proxies

Task 3 Step 3 (revert the linter to O(n²), confirm the test goes red under
`PERF_ENFORCE=1`) is excellent and is the gold-standard proof for *that* command.
Parse, typecheck, fmt, compile, and lsp have no equivalent "inject a known
regression, confirm red." You can't easily manufacture a regression for each, but
the plan should (a) state that only lint is end-to-end validated, and (b) lean on
the work-happened assertion (B) + the canary (C) as the explicit — and weaker —
substitute for the others, so the coverage gap is acknowledged rather than
implied away.

### F. Fixture size adequacy is unjustified per command

`[1000, 8000]` caught the motivating bug (it showed at 1000→4000). But a quadratic
with a small coefficient can have `ratio < bound` at 8000 and only blow up at
80000 — the test passes through the regression because N was too small. The plan
picks one size pair per command with no argument that the range is large enough
for *that* command's plausible regressions. At minimum, note this as a calibration
task (the informational data shows whether any command's baseline ratio is
suspiciously close to the step, implying N should grow).

### G. The recorder is untested, yet the whole informational period depends on it

Task 1 meta-tests that `expectPerf` throws/doesn't-throw by env, but nothing
asserts it actually **appends a record** to the JSONL. If the recorder silently
no-ops, calibration gets zero data and — because nothing gates — no test fails.
Add a meta-test: after an `expectPerf` call, the results file has one more parseable
line with the expected label/value.

### H. The LSP "incremental" test has no crisp failure condition

`runDiagnostics` re-parses the **whole** document every call (`diagnostics.ts:82`
calls `parseAgency` on full source) — there is no incremental fast-path today. So
"diagnose, edit one line, re-diagnose; assert the re-run is not pathologically
worse than the first" has no defined regression to catch: re-run ≈ first run by
construction, and "not pathologically worse" isn't a bound. Either drop this case,
or redefine it crisply — e.g. a `scalingRatio` on re-diagnosis vs document size,
guarding that re-diagnosis stays linear in doc size (which *would* catch a future
super-linear edit path). As written it's a test that can't meaningfully fail.

### Minor

- **Layer 2 stdlib smoke** only trips on ~5–10× (catastrophic) breakage by
  design — fine, but state that it catches nothing precise; it's a smoke alarm,
  not a regression detector.
- **Incremental-build isolation (Task 8)** must be a real assertion, not a hope:
  if a prior test's warm cache leaks into this test's "cold" leg, cold≈warm and
  the ratio test false-fails (or false-passes the other way). Assert the cold leg
  actually missed the cache (e.g. via `parseCache` stats) rather than assuming
  isolation.

## Bottom line

The plan is close and the staging is right, but the test-efficacy audit turned up
the most important item in this whole review: **`RATIO_BOUND = 8` against an 8×
step flags linear (correct) code as a regression** (efficacy A). That is a
must-fix arithmetic bug — the bound has to sit well above the step (~12–16) or the
ratio must be normalized by the step. It would fail the plan's own
self-consistency meta-test on day one.

The next tier is about tests that pass regardless of the code: add a
**work-happened assertion** to every perf test (B), a **schedule test** that fails
if interleaving isn't implemented (C), and a **recorder** meta-test (G) — without
these, the suite's headline properties are unverified. Redefine or drop the LSP
"incremental" case (H), since it has no failure condition today. And state plainly
that nothing gates during the informational window and only lint is end-to-end
validated (D, E).

From the earlier audits, still standing: fix the "unique content" cache
instruction (Issue 1) and alternate the interleave order (Issue 3) — correctness;
consider string-based per-stage compile to delete the cache dance (Issue 2);
encapsulate cache neutralization in one helper rather than per-test
(anti-patterns); clarify `multiFileProject` (Issue 4) and the scalar/array
handling. None of these change the plan's shape — but efficacy A means a worker
following the plan verbatim would ship a suite that fails on correct code, so it
gates execution.
