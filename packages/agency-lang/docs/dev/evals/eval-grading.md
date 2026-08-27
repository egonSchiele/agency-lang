# Eval grading: the run directory is the interface

Running an agent and grading it are separate concepts, joined by exactly one
thing: the run directory on disk (`docs/dev/evals/run-directory.md`). This
page exists so the seam survives future readers. Every rule here was decided
deliberately.

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

**Repeating a suite: `--trials k`.** Each test runs `k` times, trial-major
(`a/1, b/1, a/2, b/2`), each repetition in its own run directory at
`<out>/<testId>/<trial>/` (one trial keeps `<out>/<testId>/`). Every `run`
row records `batch` (the group directory's name plus a unique per-invocation
suffix), `trial` (1-based), and `flags.trials`. `eval grade` then prints per-test `mean ± SE` and the
batch's accuracy over the complete trial grid; `docs/dev/evals/eval-tracking.md`
has the statistics and the upload to statelog.

**Selecting a subset of a suite.** `--test <glob>` (repeatable, any match
selects, picomatch on the test id) and `--tags <a,b>` (repeatable; a test
must carry EVERY listed tag, so `--tags coding,hard` means hard coding
tests) narrow which tests run; tags live on the test (`tags: ["easy"]`).
A tag exists so someone can run a subset, so a test carries only tags a
person would filter on. Every suite uses exactly one of `easy`,
`medium`, `hard`. Do not add tags
that describe the test (`module`, `handlers`): nobody runs the `module`
subset. Both flags go through one function,
`selectTests` (`lib/eval/selectTests.ts`), and `agency eval ls --suite …`
applies the same flags through the same function — so the listing is
exactly what a run would run, by construction. A filter matching nothing is
an error naming the suite's ids and tags, never a silent empty run; filter
flags with `--input` are an error too.
`eval grade <path…>` takes run directories and groups, grades each run found
with its own pass, and prints the mean over them (`findRunDirectories`,
`docs/dev/evals/run-directory.md`). A run named twice, or through a symlink
alias, is graded once: `uniqueRunDirectories` compares
`fs.realpathSync.native` identity and the first appearance wins. `eval run`
has deliberately no `--goal`, because the goal is grading's business. It has
no stop-on-error either (`--continue-on-error` is gone: an errored test is a
`run` row that grades 0, and stopping the suite half-way only leaves holes),
and no
agent-config flags (`--strict`, `--max-tool-call-rounds`,
`--max-tool-result-chars` are gone: they belong in `agency.json` beside the
agent, and never applied to command agents anyway). Within one run directory
grading is always concurrent across traces (`Promise.all` in
`gradeSnapshot`). `eval grade -n <count>` adds a second level, grading that
many run directories at once (`mapInParallel` in `lib/cli/eval/grade.ts`),
which matters for a group of many runs.

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

**The stdlib entry nodes run their worker under `docsOnlyHandler`.** Each
`evalMain` in `stdlib/agents/` wraps its worker in `handle { ... } with
docsOnlyHandler` (`std::agents/lib/shared`), which approves `std::read` of
the docs that ship in the package (`bundledDocsDir()` in `std::skills`)
and rejects every other interrupt.

**The goal is a grading-time input.** `eval grade --goal <text>` is the goal
for the built-in judge, applied to every trace whose test recorded no goal
of its own (`withDefaultGoal` in `gradeRun.ts`, threaded as
`GradingContext.defaultGoal` / `gradeSuite`'s `defaultGoal` option). A
test's own goal always wins, so a suite with goals is unaffected. `--goal`
and `--suite` are exclusive (`validateGradeTarget`): the suite's graders
carry their own criteria, and `LlmJudge({ goal })` is the place to put one
there. A test's own graders always apply under `--goal`; the flag only
decides what the goal judge scores against for tests that have none.
Because the goal no longer has to live in the run row, every judge score
records the goal it scored against (`ScorePayload.goal`, set in
`scoreDrafts` for annotators of kind `judge`): two passes over the same run
with `--goal A` and `--goal B` are tellable apart in `annotations.jsonl`.
The same preflight refuses a target with no `statelog.jsonl`, rather than
quietly grading zero traces to `objective 0.000`. A statelog copied into a
folder is not a run directory. The error names `agency runs add` and
`agency run --capture-workdir` as the two ways to make one.

**Each test runs in staging, then is folded in.** `runSuite` mints the trace
id up front (`nanoid`) and hands it to the child. The fork runner passes it
as `identity.runId` on the run instruction, and the spawn runner passes it
as `AGENCY_TRACE_ID`, which `resolveInvocation` honors for a fresh root run.
`runSuite` then runs the agent in `<runsDir>/.staging/<runId>/<testId>/`, and calls
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

**Graders belong to tests; the only question is which copy.** A test may
carry its own grading module (`graders` in its spec; auto-discovered as
`graders.ts` beside `test.json`), recorded on its `run` row as an absolute
path. There is no suite-wide module and no per-grader input scope: both
existed once (`eval.graders`, `--graders`, `inputScope`) and were removed
because every suite wrote graders per test anyway and the extra paths only
confused the precedence. `GradingContext.graders` is a `GraderSource`:
`snapshot` (the default: the copy the run directory stored), `suite`
(`eval grade --suite`: the test's current graders in a loaded suite, found
by test id; a run whose test is not there is an error), or `override` (one
set for every test: the optimizer's objective, never a CLI option). A test
with no module is scored by the bundled goal judge against its `goal`; a
test's Agency tests (`agencyTests`, the harness pairs) count as its own
graders, so a test that has Agency tests but no module gets no goal judge,
which would demand a goal the test never needed. Under `snapshot`, one
line: the stored snapshot > the test's recorded path (directories from
before snapshots) > Agency tests only > goal judge. Live modules load once
per path per pass (`makeGraderModuleCache`). Trust note: graders are code
the harness executes.

**The run directory stores the graders it ran with.** `eval run` takes
each test's own module up front, bundles it with
esbuild (`snapshotGradingModule`: one self-contained `.mjs`, everything
inlined except `agency-lang`), loads it once so a broken module fails before
any agent runs, and collects the files its graders read by path
(`BaseGrader.externalFiles()`, which `LlmJudge` implements for a custom
`agencyFile`). The bundle and those files land in `<runDir>/graders/` by
content hash, and the run row records `graders: { source, bundleFile,
judgeFiles, origin }`. `origin` is always "test" now; runs written while
the `eval.graders` fallback existed carry "config", and `--goal` sets
those aside the way it set the config module aside. Legacy score rows still carry `completesPass`; the
schema accepts and ignores it. `eval grade` loads the stored copy (`loadGradingSnapshot`, which
rebinds each judge file to its stored copy via `rebindExternalFile`), so a
copied run directory grades the same anywhere, and an edited `graders.ts`
does not silently change what an old run scores; `--suite <dir>` is the
way to grade with the suite's live modules. The bundle is imported from a temp file
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

## Coding tests: grading agent-written Agency with `agency test`

`evals/agency-agent/fib/` is the reference for a coding test whose grader
runs the agent's code. The reason the agent writes **Agency** rather than
TypeScript or Python: it is the one language where running the code locally
is safe without a container, because every effect is an interrupt and an
outer handler's reject wins over the code's own approvals. The two flags
that make that true, and the argument in full, are in
`docs/dev/cli/test-cli-sandbox.md`.

The shape, per test directory:

- `files/<name>.test.json` + `files/<name>.agency`: a harness pair the agent
  sees (seeded into its workdir), so it self-checks with
  `agency test <name>.test.json`.
- `holdout/<name>.test.json` + `holdout/<name>.agency`: a pair the agent
  never sees. Same format.
- `test.json` needs no `goal`; `harnessMaxCost` (dollars per case) is
  optional.

Discovery (`lib/eval/loadInputs.ts`) pairs each json with its sibling;
basenames must be unique across both directories. Before any agent runs,
`snapshotHarness` (`lib/eval/grading/harnessSnapshot.ts`) parses each json
under the eval harness profile (`parseTestFileEvalHarness`: the CLI's full
profile, then refusals for `interruptHandlers`, mocks, clocks, `argv`,
skips, `expectedCompileError`, non-exact criteria, and a `sourceFile` that is
not the sibling) and stores both files of every pair under the run
directory's `graders/` by content hash, recorded on the run row as
`harness: [{ name, visibility, agency, json, sha256, maxCost? }]`.

Grading (`AgencyTestGrader`, `lib/eval/grading/agencyTestGrader.ts`): copy
the workdir snapshot to a scratch dir under `.agency-tmp/` with symlinks
left out, write the framework's copy of the pair over it as
`<name>.agency` / `<name>.test.json`, and spawn

```
agency test run --json --agency-only --reject '*' --max-cost <n> <name>.test.json
```

in the scratch dir. Score = passing fraction of the file's cases (0 when the
file did not run, 1 when it ran with nothing to fail). It is an ordinary
scored grader, so a solution passing three of five cases scores 0.6 and an
optimizer sees the progress. A test that wants all-or-nothing sets
`"harnessMustPass": true` in its `test.json`; the harness then becomes a
gate with `threshold: 1`, and the choice is stored on the run's harness
record so a re-grade keeps it. A judge beside a holdout runs on every
solution, and can say in words why the holdout failed. `eval grade` rebuilds one grader per `harness` record from
the stored files; they are the test's own, so an override and `--goal` leave
them in place, and `--suite` rebuilds them from the suite's current pairs. The grader's revision is `agency-tests/<name>@<sha256>`.

Three rules that are easy to get wrong:

- **Never run the harness from the workdir.** The agent can edit its seeded
  copy; the grader installs the framework's copy over it.
- **Spawn `agency test`; do not call `lib/cli/test.ts`'s `test()`
  in-process.** A compile failure is a grading outcome; in-process it would
  be a process exit.
- **The scratch dir goes under `.agency-tmp/`, not `os.tmpdir()`**: compiled
  Agency resolves `agency-lang` from the directory it runs in.

## Two bundled judges: goal and rubric

A function grader has two LLM judges on its context, `ctx.judges`, and
they ask different questions. `judges.goal({ goal, output, expected })` runs
`lib/agents/eval/goalJudge.agency`, a correctness judge: was the output
the right, direct answer to the goal? Its rules treat any expected text
as authoritative and penalize extra content, which is right for "name
the capital" and wrong for grading review findings against a standard.
`judges.rubric({ standard, output, context })` runs
`lib/agents/eval/rubricJudge.agency`: how well does the output meet the
standard, with `context` (the source text, an editor's notes, a
reference version) read as background and never as an answer to match.
The writing-review suite learned this the expensive way: phrased for the
goal judge, its graders scored findings for "matching the expected
answer" that did not exist. Each judge file is versioned by a pinned
hash (`goalJudgeFile.ts`, `rubricJudgeFile.ts`); bump the version when
you edit a prompt. A new judge (pairwise, say) is a new key on `judges`,
not a new field on the context.

## Grader-only files: `graderFiles/`

A test directory may hold a `graderFiles/` directory beside `test.json`:
reference answers, an editor's notes, a cleaned version of the text, or
anything else the graders read and the agent must never see. `files/` is
the opposite: it is seeded into the agent's workdir. The loader records
the directory on the test as `graderFiles` (absolute; a `test.json` may
also name one explicitly, a local directory only).

`eval run` stores the whole tree in the run directory
(`snapshotGraderFiles`, `lib/eval/grading/graderFilesSnapshot.ts`): under
`graders/<sha256>/` with its relative names kept, where the hash covers
every path and content, and the run row records that name as
`graderFiles`. Symlinks in the tree are refused, as is an empty directory. At grading time a
function grader reads the directory as `ctx.graderFiles` (`""` when the
test has none): the stored copy under `snapshot` and `override`, the
suite's live directory under `--suite`. A recorded copy missing from the
run directory is an error naming the test, never a silent `""`.
`evals/writing-review/` is the reference user: its `harvestedGraders()`
reads `notes.md` and `cleaned.md` from there.

Grading modules load through the built package (`agency-lang/eval`
resolves to `dist/`), so a change to what `ctx` carries needs a build
before a suite sees it.

## What is gone

`config.json`, `summary.json`, per-input `input.json`, `eval-record.json` on
disk, `verifier-N/grading.json`, and `--no-grade`. The legacy loaders that
read those files are gone too: the runs explorer loads through
`readRunDirectory` (`lib/runsExplorer/loader.ts`) and labeling works off the
run directory (`lib/eval/label/`).
