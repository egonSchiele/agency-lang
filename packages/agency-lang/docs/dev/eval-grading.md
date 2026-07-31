# Eval grading: the run directory is the interface

Running an agent and grading it are separate concepts, joined by exactly one
thing: the run directory on disk. This page exists so the seam survives future
readers; every rule here was decided deliberately (2026-07-30), not inherited.

## The rules

**Grading's only input is a run directory.** `gradeRun(runDir, ctx)`
(`lib/eval/grading/gradeRun.ts`) and `gradeSuite(runDir, suiteGraders, config)`
(`lib/eval/grading/gradeSuite.ts`) take a path, never an in-memory result.
There used to be an in-memory handoff (`gradeRun` accepted a three-shape
union); it was deleted on purpose.

**Tests grade themselves; the suite level is override or fallback.** An
input may carry its own grading module (`graders` in its spec; auto-
discovered as `graders.ts` beside `test.json`), recorded as an absolute
path in the run directory's `input.json` — so a re-grade days later loads
the same module with no flags. The suite-level set is a tagged union,
`SuiteGraders` (`gradeRun.ts`): `override` (an explicit `--graders` flag)
replaces every test's own graders — the experiment knob — while `fallback`
(the `eval.graders` config module, else the bundled goal judge) applies
only to inputs that carry none. Precedence, one line: flag > test's own >
config > goal judge. Grading modules are loaded once per path per grade
pass (`makeGraderModuleCache`); the run CLI's pre-run validation loads
through the same cache. Trust note: graders are code the harness executes —
pulling a remote suite means trusting it, by decision (2026-07-31).

**`eval run --grade` re-reads the artifacts it just wrote.** The suite runner
(`runSuite`) executes agents and writes the run directory; it knows
nothing about graders. The `evalRun` command then grades that directory —
`resolve graders → validate → run → grade` — the same call `agency eval grade`
makes days later. The re-read looks like waste; it is the point. The cost is
one bounded JSON write plus one read per input, and in exchange the artifacts
(`summary.json`, `input.json`, `eval-record.json`) are proven to round-trip on
every graded run instead of only when someone re-grades an old run. Do not
"optimize" this by passing the in-memory summary through — that reconnects the
two concepts this design separates. (Revisit only if grading ever needs heavy
post-read processing; it currently does one `JSON.parse` and a field lookup.)

**An errored run scores zero, always.** Graders never see an errored run. A
failed run may leave a salvaged `eval-record.json` on disk (a crash after
useful work keeps its evidence); that salvage is for humans and optimizer
reflection, and is never graded — a run that almost finished must not earn
points from a judge that cannot tell it crashed. This includes runs killed
by a timeout, a cost cap, or Ctrl-C: an agent that reached the right disk
state but could not decide it was done is not a success (decided
2026-07-31). The diversion lives in `loadedEntry` (`gradeRun.ts`), with a
spy-grader test pinning it.

**A successful run with no recorded output still grades, with `output:
null`.** Command agents (the agency CLI under `--agent-cmd`) emit no output
event, and for terminal-bench-style tests the deliverable is the
FILESYSTEM — graders read the workdir. Graders that need the output see
`null` and fail on their own terms. The two hard ungraded reasons are
record-missing and record-unreadable only (`lookUpOutput`, `gradeRun.ts`).
A real agent once passed a task and was scored ungraded before this rule.

**`readEvalRun` is the single place grading touches the filesystem** and owns
all tolerance: a corrupt per-input file degrades that one input with a warning
(grading runs after every agent has been paid for; one bad file must not take
the pass down), while a corrupt `summary.json` fails loudly with the file
named, because nothing is loadable without it.

## History

`judgeSuite` was the last holdout: it accepted a loaded-run-or-directory
union and took input specs in memory. It converged on 2026-07-30 — it now
takes two run directories and reads the specs from each run's `input.json`,
the same way grading does.
