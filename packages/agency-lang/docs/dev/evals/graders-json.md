# `graders.json`: a test's graders as data

A test folder may hold `graders.json` beside `test.json` instead of a
`graders.ts`. The file is a list of graders in five kinds. Grading it gives
the same scores as the equivalent module, through the same `BaseGrader`
pipeline, so nothing downstream of loading learns a new type. This page is
the map of the code, with the rules in it that are easy to break.

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

Each kind answers one question about a run. The example first, then what it
does.

```json
[
  { "kind": "goal", "name": "takes-a-position", "goal": "recommends a direction", "mustPass": true, "passingScore": 0.5 },
  { "kind": "checklist", "name": "grounded", "points": ["names the one bin", "builds on the brains seam"], "context": "notes.md" },
  { "kind": "number", "name": "llm-calls", "measure": "llmCalls", "full": 0, "zero": 30, "weight": 0.1 },
  { "kind": "count", "name": "no-repeated-fetches", "count": "toolCalls", "tool": "fetchMarkdown", "repeated": true, "max": 0 },
  { "kind": "command", "name": "roundtrip", "command": "python3 -m pytest graderFiles/test_outputs.py", "mustPass": true }
]
```

- **goal**: the bundled goal judge scores the reply from 0 to 1 against the
  goal. It is `new LlmJudge({ goal })`, the same grader a test with a `goal`
  in `test.json` and no graders gets today.
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
  passes. What it printed is the feedback.

Every kind has `name`, `weight` (default 1), and `mustPass` (default false).
`buildGraders` passes the three through one helper, `optionsOf`, into the
grader's options.

## Must pass, per kind

A must-pass grader has to be able to fail. `BaseGrader.passes()` throws for
a must-pass grader that returns a score and has no threshold (see "Gates" in
`eval-grading.md`), so each kind that returns a score says how it clears
that bar:

- A must-pass **goal** grader requires `passingScore`. The parser refuses
  the file without it, and the builder maps it to `threshold`.
- A must-pass **checklist** passes only when every point passed.
  `ChecklistJudge.passes()` reads `grade.points` and never calls the base
  method, because the base method would throw and a checklist has no
  threshold by design.
- A must-pass **number** grader uses `max`, which is pass or fail. A
  `full`/`zero` grader can be must-pass too, but it can only fail at a score
  of 0, so use `max`.
- **count** and **command** are pass or fail already.

## Parsing: two tables, one lookup

`schema.ts` keeps the rules in two tables so a sixth kind or a new rule is
one row:

- `KIND_SCHEMAS` maps each `kind` to a strict zod object. `parseGradersJson`
  reads `kind` off every element by hand and looks the schema up. It is not
  a zod discriminated union, because that reports an unknown kind as
  "Invalid discriminator value" with no index and no kind, and the message
  here is `grader 0: unknown kind "rubric"`.
- `RULES` holds the cross-field rules: a must-pass goal needs
  `passingScore`; a number grader has `full` and `zero` or `max`, not both
  and not neither; `tool` and `repeated` only with `count: "toolCalls"`;
  `messageStartsWith` only with `count: "errors"`. The first rule that
  applies is the error, with the index and the name in front.

Names are unique within a file, as they are within a module: score rows are
keyed by grader name.

## Building: the "what" in a table, the "how" in one function

`build.ts` keeps each kind's data apart from its scoring. `MEASURES` says
what each number measure reads from the record and how to describe the
value (`"14 LLM calls"`, `"$0.42"`, `"83s"`, `"12k tokens in"`), and
`numberGrader` reads the table and scores. `COUNTS` says which record rows
each count selects, and `countGrader` filters and counts them. There is no
`switch` on a measure or a count anywhere.

Four facts a reader needs that are easy to miss:

- `agentSeconds` is `record.durationMs / 1000`, the run's wall time. Once
  ADI-32 logs the time a person spends at an approval prompt, it will
  subtract that; today nothing is subtracted, and in an eval run nobody is
  at a prompt.
- `repeated` compares `tool` and `argsPreview`, the 200-character preview
  of the arguments. No row in the record carries the full arguments, so two
  calls that differ only after the preview count as one. A test pins this.
- A command grader runs inside the run directory's stored workdir, the same
  place the agent suite's pytest runner runs today. Whatever it writes
  (`__pycache__`, `.pytest_cache`) lands there, so a command must not depend
  on a clean workdir. stdin is closed, so a command that reads it sees end
  of file. A command that outlives `timeoutSec` (default 600) fails with
  "timed out after Ns". Output is kept to 2000 characters of feedback.
- A must-pass goal grader needs `passingScore` because a scalar gate with
  no threshold cannot fail.
- A `context` must stay inside `graderFiles/`: the parser refuses an
  absolute path or one with `..`, and the judge checks again at grade time
  with `isStrictDescendant` before reading. A `full` equal to `zero` is
  refused too, since the line between them would divide by zero.

## The checklist judge

`lib/agents/eval/checklistJudge.agency` takes `(points, work, context)` and
returns `{ points: [{ name, pass, evidence }], note }`, one answer per
point, in order. `pass` is `true`, `false`, or `null` for cannot tell. The
file is versioned by a pinned hash in `checklistJudgeFile.ts`, like the goal
and rubric judges; bump `CHECKLIST_JUDGE_VERSION` when you edit the prompt.

`ChecklistJudge` sends the points as the test wrote them, the output as
judge text, and the context. It refuses a verdict whose answer count differs
from the point count, with a message, rather than scoring it. The points on
the grade carry the input point's text by index, not the short `name` the
judge invents.

`context` is a path under the test's `graderFiles/` folder, read at grade
time from the run's stored copy as `path.join(input.graderFiles, context)`.
That is why no JSON grader has external files: the run directory already
stores `graderFiles/` on every run (`graderFilesSnapshot.ts`), so a stored
run finds its context after the test folder is gone, and the snapshot needs
no `judgeFiles` entry and no rebind. A missing context file fails the
grader with "context file notes.md is not in graderFiles/".

A checklist cannot be sampled. `aggregateGrades` keeps only `score` and
`feedback`, so the per-point answers would be lost; the constructor refuses
`samples > 1`. For the same reason `BaseGrader.run` returns a single trial
as it is instead of aggregating it.

## Points on the score row

`Grade` has an optional `points: Point[]`, and so do `ScoreDraft`, the
`score` row's payload and schema, and `GradeRow`. The field is copied at
each hop the way `feedback` is. It lives on `Grade`, not only on the row,
because `passes()` reads it from the grade in the gate loop. `eval grade`
prints the points under the grader's feedback, one line each with a check
or a cross.

## Loading, storing, and loading back

A test's `graders` field holds the path to either file. `loadTestDir`
discovers `graders.json` beside `test.json` the way it discovers
`graders.ts`, and a folder with both is a load error naming the folder. A
test with either file needs no `goal`.

Each source does three things: load live, store in a run directory, and
load back from the store. `graderSources.ts` puts the two sources behind
one table, `GRADER_SOURCES`, and the three call sites look the source up:

- `makeGraderModuleCache` in `gradeRun.ts` calls
  `graderSourceForPath(path).load(path)`.
- `snapshotGraders` in `runSuite.ts` calls
  `graderSourceForPath(path).snapshot(path)`.
- `snapshotModuleGraders` in `gradeRun.ts` calls
  `graderSourceForRecord(row).loadSnapshot(gradersDir, row)`.

None of the three mentions an extension or a stored file's name. For the
JSON source, the stored file is the `graders.json` itself under its content
hash, and the run row's `graders` identity names it as `jsonFile`. A module
row names `bundleFile`. Exactly one of the two is set; the row schema
refuses both and neither, so an old row with only `bundleFile` loads
unchanged. The revision on every JSON grader is `<source path>@<sha256 of
the text>`, live and from the snapshot alike, so the two agree.

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
