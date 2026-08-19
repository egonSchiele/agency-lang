# Eval grading: the run directory is the interface

Running an agent and grading it are separate concepts, joined by exactly one
thing: the run directory on disk (`docs/dev/run-directory.md`). This page
exists so the seam survives future readers; every rule here was decided
deliberately (2026-07-30, re-based on the run directory 2026-08-18).

## The rules

**`eval run` never grades.** `agency eval run` loads the suite, runs it, and
writes one run directory per test at `<out>/<testId>/`: the test's trace in
`statelog.jsonl` (empty when the test died before its first event, so the
directory is still a run directory), its workdir flat under `workdir/` with a
`workdir.json` sidecar, the agent's code flat under `code/`, and one `run`
annotation (`{ test, suite, ended, flags, error? }`). No
`goal` is needed to run: `--input <text>` runs one inline test with that
input and no goal (`inlineInput`; the suite identity is `inline:--input`).
Grading is `agency eval grade <dir>`, whenever you like, as many times as you
like. `eval run` takes the agent file as its positional argument (or
`--agent-cmd`), plus `--suite`/`--input`, `--out <dir>` and `-n`. `--out`
names the GROUP directory; each test's run directory is written at
`<out>/<testId>/` (`input-1` for `--input`), assembled in `<out>/.staging/`
and renamed into place so a child appears whole or not at all. A child that
already exists is an error result for that test (nothing overwritten; the
others still run). Default `<eval.runsDir or runs>/<timestamp>-<random suffix>`.
`eval grade <path…>` takes run directories and groups, grades each run found
with its own pass, and prints the mean over them (`findRunDirectories`,
`docs/dev/run-directory.md`); a run named twice, or through a symlink alias,
is graded once (`fs.realpathSync.native` identity, first appearance wins). There is deliberately no `--goal` (grading's business), no
stop-on-error (`--continue-on-error` is gone: an errored test is a `run` row
that grades 0, and stopping the suite half-way only leaves holes), and no
agent-config flags (`--strict`, `--max-tool-call-rounds`,
`--max-tool-result-chars` are gone: they belong in `agency.json` beside the
agent, and never applied to command agents anyway). Grading is always
concurrent across traces (`Promise.all` in `gradeSnapshot`), so `-n` is a
run-only knob.

**Input is optional, and the agent's shape must match.** A test may omit
`input` (a suite test without the field, or `eval run <agent>` with neither
`--suite` nor `--input`), for agents that take no argument. Within one
suite the tests must agree — all with an input or none —
and `assertTargetMatchesInputs` (`lib/agentTarget.ts`, called from
`runSuite` and the optimizer's `buildTarget`) checks the agent against
that once, up front: with inputs the entry node takes exactly one
parameter / the command contains `{input}`; without, the node takes none /
the command has no placeholder. Each mismatch names the fix in both
directions ("pass --input" or "make the node take no parameter"). A test
with no input reaches the child as a run instruction without `input`,
which `resolveNodeCallArgs` already treats as a bare call.

**The goal is a grading-time input.** `eval grade --goal <text>` is the goal
for the built-in judge, applied to every trace whose test recorded no goal
of its own (`withDefaultGoal` in `gradeRun.ts`, threaded as
`GradingContext.defaultGoal` / `gradeSuite`'s `defaultGoal` option). A
test's own goal always wins, so a suite with goals is unaffected. `--goal`
and `--graders` are exclusive (`validateGradeTarget`): a grading module
carries its own criteria, and `LlmJudge({ goal })` is the place to put one
there. For the same reason `--goal` sets aside a configured `eval.graders`
module: `gradersFor` in `lib/cli/eval/grade.ts` returns the bundled goal
judge whenever `--goal` is given, so the flag always means "judge against
this text" (per-test graders still apply, as fallback mode always allows).
Because the goal no longer has to live in the run row, every judge score
records the goal it scored against (`ScorePayload.goal`, set in
`scoreDrafts` for annotators of kind `judge`): two passes over the same run
with `--goal A` and `--goal B` are tellable apart in `annotations.jsonl`.
The same preflight refuses a target with no `statelog.jsonl` — a
statelog copied into a folder is not a run directory; the error names
`agency runs add` and `agency run --capture-workdir` as the two ways to make
one — instead of quietly grading zero traces to `objective 0.000`.

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
the run directory's stored snapshot > test's own recorded path (directories
from before snapshots) > config > goal judge. Live modules load once per path
per pass (`makeGraderModuleCache`). Trust note: graders are code the harness
executes.

**The run directory stores the graders it ran with.** `eval run` decides
each test's module up front (its own, else `eval.graders`), bundles it with
esbuild (`snapshotGradingModule`: one self-contained `.mjs`, everything
inlined except `agency-lang`), loads it once so a broken module fails before
any agent runs, and collects the files its graders read by path
(`BaseGrader.externalFiles()`, which `LlmJudge` implements for a custom
`agencyFile`). The bundle and those files land in `<runDir>/graders/` by
content hash, and the run row records `graders: { source, bundleFile,
judgeFiles }`. `eval grade` loads that copy (`loadGradingSnapshot`, which
rebinds each judge file to its stored copy via `rebindExternalFile`), so a
copied run directory grades the same anywhere, and an edited `graders.ts`
does not silently change what an old run scores; `--graders <file>` is the
way to grade with a live module. The bundle is imported from a temp file
next to the snapshot so its `agency-lang` import resolves from there; when
that fails (a directory copied outside any project) it retries from this
package's own root, where the name resolves to the package itself. A module's
revision is `<source>@<sha256 of the bundle>` in both paths, so snapshot and
unchanged-live grading agree on the annotator.

**A run that did not end cleanly scores zero, always.** The harness's `run`
row is authoritative when present — only it knows about a wall-clock or
cost-cap kill (`ended: "timeout" | "cost-cap" | "killed" | "error"`); without
one, the trace's own ending decides (`traceEnding`). Such a trace is never
shown to graders: a run that almost finished must not earn points from a judge
that cannot tell it crashed. `gradeRun.test.ts` pins this with a spy grader.

**A test that never produced a trace still counts.** When an agent dies
before its first event (a compile failure, a kill before start), the harness
records a `run` row with no trace behind it. `gradeSnapshot` enumerates those
rows too (`gradableEntries`), scoring each zero with the row's reason.
Otherwise a suite where half the tests never started would score as if only
the other half existed, and one where none started would pass gates
vacuously.

**A successful run with no recorded output still grades, with `output:
null`.** Command agents emit no output event, and for terminal-bench-style
tests the deliverable is the FILESYSTEM — graders read the workdir. Graders
that need the output fail on their own terms.

**Every grading pass is recorded as annotations.** `gradeSuite` reads one
snapshot, grades it, converts each grade to a `ScoreDraft`, and calls
`recordGradingPass` once: one `score` row per grader per trace, all sharing a
fresh `passId` and stamped with the `passSize`. The fold counts only complete
passes, so a crash mid-pass never moves effective state, and a re-grade sits
beside the earlier passes rather than over them (the latest pass is the
effective score per grader lineage, any revision; the pass count is shown so
a re-grade is never silent). Graders are named by
revision — a module grader is `<path>@<sha256 of file>` (set by
`loadGradingModule`), the bundled goal judge `goal-judge@<GOAL_JUDGE_VERSION>`
(bump the constant in `goalJudgeFile.ts` when you edit the prompt; a test pins
the version to the file's hash), a custom judge file `<path>@<sha256 of file>` —
so editing `graders.ts` in place is a new annotator. `EvalRunGrading` (the
objective, gates, per-test breakdown) is computed for printing and `-o`; it is
not stored.

## What is gone

`config.json`, `summary.json`, per-input `input.json`, `eval-record.json` on
disk, `verifier-N/grading.json`, `error.txt`, and `--no-grade`. Old run
directories on disk are still readable by the runs explorer's legacy loader
(`lib/runsExplorer/readRunSummary.ts`) and the label loader
(`lib/eval/readRun.ts`) until those move to the run directory.
