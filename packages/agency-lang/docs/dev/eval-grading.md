# Eval grading: the run directory is the interface

Running an agent and grading it are separate concepts, joined by exactly one
thing: the run directory on disk (`docs/dev/run-directory.md`). This page
exists so the seam survives future readers; every rule here was decided
deliberately (2026-07-30, re-based on the run directory 2026-08-18).

## The rules

**`eval run` never grades.** `agency eval run` loads the suite, runs it, and
writes one run directory: every test's trace in `statelog.jsonl`, its workdir
under `workdir/<traceId>/`, the agent's code under `code/<closureHash>/`, and
one `run` annotation per test (`{ test, suite, ended, flags, error? }`). No
`goal` is needed to run. Grading is `agency eval grade <dir>`, whenever you
like, as many times as you like.

**Each test runs in staging, then is folded in.** `runSuite` mints the trace
id up front (`nanoid`) and hands it to the child — the fork runner via
`identity.runId` on the run instruction, the spawn runner via
`AGENCY_TRACE_ID`, which `resolveInvocation` honors for a fresh root run —
runs the agent in `<runsDir>/.staging/<runId>/<testId>/`, and calls
`recordCompletedRun` once with the staged statelog, workdir, seeded agent
entry and the `run` row. A test that never wrote a statelog still gets its
`run` row (so the failure is recorded), but no workdir. Code is attached only
when the trace itself recorded that closure hash. Staging is removed through
`safeDeleteDirectoryWithin` in `finally`.

**Grading's only input is a run directory.** `gradeRun(dir, ctx)` /
`gradeSnapshot(snapshot, ctx)` (`lib/eval/grading/gradeRun.ts`) read the
directory: for each trace, the test comes from its `run` row (an ad-hoc trace
with no row is a test named by its trace id), the record is
`evalRecordFor(trace)`, the workdir is `workdir/<traceId>` when present, and
the output is the last recorded eval output. There is no in-memory handoff, so
grading right after a run reads the same directory `eval grade` reads days
later.

**Tests grade themselves; the suite level is override or fallback.** A test
may carry its own grading module (`graders` in its spec; auto-discovered as
`graders.ts` beside `test.json`), recorded on its `run` row as an absolute
path. The suite-level set is `SuiteGraders`: `override` (an explicit
`--graders` flag) replaces every test's own graders — the experiment knob —
while `fallback` (the `eval.graders` config module, else the bundled goal
judge) applies only to tests that carry none. Precedence, one line: flag >
test's own > config > goal judge. Grader modules load once per path per pass
(`makeGraderModuleCache`). Trust note: graders are code the harness executes.

**A run that did not end cleanly scores zero, always.** The harness's `run`
row is authoritative when present — only it knows about a wall-clock or
cost-cap kill (`ended: "timeout" | "cost-cap" | "killed" | "error"`); without
one, the trace's own ending decides (`traceEnding`). Such a trace is never
shown to graders: a run that almost finished must not earn points from a judge
that cannot tell it crashed. `gradeRun.test.ts` pins this with a spy grader.

**A successful run with no recorded output still grades, with `output:
null`.** Command agents emit no output event, and for terminal-bench-style
tests the deliverable is the FILESYSTEM — graders read the workdir. Graders
that need the output fail on their own terms.

**Every grading pass is recorded as annotations.** `gradeSuite` reads one
snapshot, grades it, converts each grade to a `ScoreDraft`, and calls
`recordGradingPass` once: one `score` row per grader per trace, all sharing a
fresh `passId`, the last marked `completesPass`. The fold counts only complete
passes, so a crash mid-pass never moves effective state, and a re-grade sits
beside the earlier passes rather than over them. Graders are named by
revision — a module grader is `<path>@<sha256 of file>` (set by
`loadGradingModule`), the goal judge `goal-judge@<hash of its prompt file>` —
so editing `graders.ts` in place is a new annotator. `EvalRunGrading` (the
objective, gates, per-test breakdown) is computed for printing and `-o`; it is
not stored.

## What is gone

`config.json`, `summary.json`, per-input `input.json`, `eval-record.json` on
disk, `verifier-N/grading.json`, `error.txt`, and `--no-grade`. Old run
directories on disk are still readable by the runs explorer's legacy loader
(`lib/runsExplorer/readRunSummary.ts`) and the label loader
(`lib/eval/readRun.ts`) until those move to the run directory.
