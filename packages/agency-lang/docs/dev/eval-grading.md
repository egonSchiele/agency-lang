# Eval grading: the run directory is the interface

Running an agent and grading it are separate concepts, joined by exactly one
thing: the run directory on disk. This page exists so the seam survives future
readers; every rule here was decided deliberately (2026-07-30), not inherited.

## The rules

**Grading's only input is a run directory.** `gradeRun(runDir, ctx)`
(`lib/eval/grading/gradeRun.ts`) and `gradeSuite(runDir, graders, config)`
(`lib/eval/grading/gradeSuite.ts`) take a path, never an in-memory result.
There used to be an in-memory handoff (`gradeRun` accepted a three-shape
union); it was deleted on purpose.

**`eval run --grade` re-reads the artifacts it just wrote.** The suite runner
(`evalRunLoadedInputs`) executes agents and writes the run directory; it knows
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
points from a judge that cannot tell it crashed. The diversion lives in
`loadedEntry` (`gradeRun.ts`), with a spy-grader test pinning it.

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
