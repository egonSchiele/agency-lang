# `graders.json`: a test's graders as data

A test folder may hold `graders.json` beside `test.json` instead of a
`graders.ts`. The file is a list of graders in five kinds. Grading it gives
the same scores as the equivalent module, through the same `BaseGrader`
pipeline, so nothing downstream of loading learns a new type.

## The files

```text
lib/eval/gradersJson/schema.ts        the five kinds as zod schemas, the cross-field rules, parseGradersJson
lib/eval/gradersJson/build.ts         buildGraders: one builder per kind over the existing helpers
lib/eval/gradersJson/load.ts          loadGradersJson, snapshotGradersJson, loadGradersJsonSnapshot
lib/eval/grading/graderSources.ts     the two grader sources (module, JSON) as one table
lib/eval/grading/graders/checklistJudge.ts   ChecklistJudge
lib/eval/grading/checklistJudgeFile.ts       the judge's path, version pin, and verdict schema
lib/agents/eval/checklistJudge.agency        the judge program
lib/eval/gradersJson/fixtures/packaging-decision/   a converted test, used by endToEnd.test.ts
```

## The five kinds

Each kind answers one question about a run.

```json
[
  { "kind": "goal", "name": "takes-a-position", "goal": "recommends a direction", "mustPass": true, "passingScore": 0.5 },
  { "kind": "checklist", "name": "grounded", "points": ["names the one bin", "builds on the brains seam"], "context": "notes.md" },
  { "kind": "number", "name": "llm-calls", "measure": "llmCalls", "full": 0, "zero": 30, "weight": 0.1 },
  { "kind": "count", "name": "no-repeated-fetches", "count": "toolCalls", "tool": "fetchMarkdown", "repeated": true, "max": 0 },
  { "kind": "command", "name": "roundtrip", "command": "python3 -m pytest \"$AGENCY_GRADER_FILES/test_outputs.py\"", "mustPass": true }
]
```

- **goal**: the bundled goal judge scores the reply from 0 to 1 against the
  goal. It is `new LlmJudge({ goal })`, the same grader a test with a `goal`
  in `test.json` and no graders gets.
- **checklist**: the checklist judge answers every point with yes, no, or
  cannot tell, quoting the words that decided it. The score is the share of
  points that passed; cannot tell counts as a fail. Points count equally. To
  make one count double, write it twice.
- **number**: a number from the record against a limit, with no LLM.
  `measure` is `llmCalls`, `costUsd`, `agentSeconds`, `tokensIn`, or
  `tokensOut`. With `full` and `zero`, the score is 1 at `full`, 0 at
  `zero`, a straight line between, clamped outside. With `max`, it passes
  when the value is at most `max`. One or the other, never both.
- **count**: how many rows of a kind are in the trace, with no LLM. `count`
  is `toolCalls`, `errors`, or `llmCalls`. `tool` and `repeated` narrow tool
  calls; `messageStartsWith` narrows errors. Passes when the count is at most
  `max`.
- **command**: a shell command run in the agent's working directory. Exit 0
  passes. What it printed is the feedback. The test's grader-only files are
  stored apart from the workdir, so the command reaches them through
  `$AGENCY_GRADER_FILES`, empty when the test has none.

Every kind has `name`, `weight` (default 1), and `mustPass` (default
false). Names are unique within a file, because score rows are keyed by
grader name.

## Must pass, per kind

A must-pass grader has to be able to fail. `BaseGrader.passes()` throws for
a must-pass grader that returns a score and has no threshold (see "Gates" in
`eval-grading.md`), so the parser refuses a file whose gate could not clear
that bar:

- A must-pass **goal** grader requires `passingScore`, which becomes the
  grader's `threshold`.
- A must-pass **checklist** passes only when every point passed.
- A must-pass **number** grader requires `max`. A `full`/`zero` grader
  returns a score with no threshold, so it cannot be a gate.
- **count** and **command** are pass or fail already.

## Rules the parser enforces

The per-kind field rules are the zod schemas in `schema.ts`, one per kind
and strict, so an unknown field names itself. The rules that span fields
are the `RULES` table in the same file:

- A must-pass goal grader needs `passingScore`; a must-pass number grader
  needs `max`.
- A number grader has `full` and `zero`, or `max`, never a mix. `full` and
  `zero` differ, since the line between them would divide by zero.
- `tool` and `repeated` only apply to `count: "toolCalls"`;
  `messageStartsWith` only to `count: "errors"`.
- A checklist `context` is relative and never climbs out with `..`.

Every error names the file, the grader's index, and where it has one, the
grader's name.

## Facts that are easy to miss

- `agentSeconds` is `record.durationMs / 1000`, the run's wall time. Once
  ADI-32 logs the time a person spends at an approval prompt, it will
  subtract that; today nothing is subtracted, and in an eval run nobody is
  at a prompt.
- `repeated` compares `tool` and `argsPreview`, the 200-character preview
  of the arguments. No row in the record carries the full arguments, so two
  calls that differ only after the preview count as one.
- A command grader runs inside the run directory's stored workdir, the same
  place the agent suite's pytest runner runs. Whatever it writes
  (`__pycache__`, `.pytest_cache`) lands there, so a command must not depend
  on a clean workdir. stdin is closed, so a command that reads it sees end
  of file. A command that outlives `timeoutSec` (default 600) is killed with
  SIGKILL and fails with "timed out after Ns"; a process the command started
  that still holds its output pipe can keep the grader waiting past that.
  Output is kept to 2000 characters of feedback.

## The checklist judge

`lib/agents/eval/checklistJudge.agency` takes `(points, work, context)` and
returns `{ points: [{ name, pass, evidence }], note }`, one answer per
point, in order. `pass` is `true`, `false`, or `null` for cannot tell. The
file is versioned by a pinned hash in `checklistJudgeFile.ts`, like the goal
and rubric judges; bump `CHECKLIST_JUDGE_VERSION` when you edit the prompt.

`ChecklistJudge` sends the points as the test wrote them, the output as
judge text, and the context. A verdict whose answer count differs from the
point count fails the grader with a message. The points on the grade carry
the input point's text by index, not the short `name` the judge invents.

`context` is a path under the test's `graderFiles/` folder, read at grade
time from the run's stored copy. The run directory stores `graderFiles/` on
every run (`graderFilesSnapshot.ts`), so a stored run finds its context
after the test folder is gone, and no JSON grader has external files to
rebind. Before reading, the judge checks that the resolved path is inside
the folder and that no step from the folder down is a symlink, the same
refusal the snapshot applies when it stores the folder. Under
`eval grade --suite` the live folder is handed over without a snapshot, so
the check at read time is the one that holds there. A missing or refused
file fails the grader with "context file notes.md is not in graderFiles/".

A checklist cannot be sampled: `aggregateGrades` keeps only `score` and
`feedback`, so the constructor refuses `samples > 1`.

## Points on the score row

`Grade` has an optional `points: Point[]`, and so do `ScoreDraft`, the
`score` row's payload and schema, and `GradeRow`. A function grader that
returns a full grade keeps its `points` too. `eval grade` prints the points
under the grader's feedback, one line each with a check or a cross.

A must-pass checklist's row stores its scalar share, as a must-pass goal
grader's row stores its score. The gate verdict is not on the row; it lives
in the grading pass, as it does for every scalar gate, and the run listing
reports gates as unknown for a scalar gate for that reason
(`lib/runDirectory/list.ts`, `gatesPassed`).

## Loading, storing, and loading back

A test's `graders` field holds the path to either file. `loadTestDir`
discovers `graders.json` beside `test.json` the way it discovers
`graders.ts`, and a folder with both is a load error naming the folder. A
test with either file needs no `goal`.

Each source does three things: load live, store in a run directory, and
load back from the store. `graderSources.ts` puts the two sources behind
one table, `GRADER_SOURCES`, and the three call sites look the source up
by path or by the run row:

- `makeGraderModuleCache` in `gradeRun.ts` (live loading).
- `snapshotGraders` in `runSuite.ts` (storing on `eval run`).
- `snapshotModuleGraders` in `gradeRun.ts` (loading from the store).

For the JSON source, the stored file is the `graders.json` itself under its
content hash, and the run row's `graders` identity names it as `jsonFile`.
A module row names `bundleFile`. Exactly one of the two is set; the row
schema refuses both and neither, so an old row with only `bundleFile`
loads unchanged. The revision on every JSON grader is
`<source path>@<sha256 of the text>`, live and from the snapshot alike.

## What is deliberately not in the file

- Weights per point. Write a point twice to count it double.
- A rubric kind. The checklist replaces the rubric judge for new tests;
  the rubric returns one number where the checklist returns an answer per
  point.
- `samples`. See the checklist judge above.
- Compile and export checks for Agency-coding tests. They could become a
  sixth kind; the set-aside design is in
  `docs/superpowers/specs/2026-10-19-graders-json-checklist-design.md`.
- `agency eval check`, which runs a test's graders over its reference
  solution. That is ADI-34.
