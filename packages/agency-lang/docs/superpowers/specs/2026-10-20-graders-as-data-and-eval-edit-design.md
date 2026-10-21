# Graders as data, and a form that edits them

Linear project: "Improving the DX for evals".

This design has three parts, built in this order:

1. `graders.json`, a file that holds a test's graders as data.
2. A graders section in the `agency eval new` form. Each grader is added
   through a short set of questions.
3. `agency eval edit <test-dir>`, which opens an existing test in the same
   form.

It ends with three smaller fixes that came out of the same discussion.

## Why

Evals are hard to write and hard to check. Today every grader is
TypeScript. To find out what a test checks, you read a `graders.ts`. To
write one, you need to know the helper names and the shape the module must
export.

Most of that TypeScript is data. Here is a typical grader from the agent
suite, in `evals/agency-agent/packaging-decision/graders.ts`:

```ts
grader(
  ({ judges }) =>
    judges.goal({
      goal: "actually helps the maintainer decide: recommends a direction, ...",
    }),
  { name: "takes-a-position", mustPass: true },
),
```

Everything that matters is the goal text, the name, and the must-pass flag.
The rest is boilerplate. If graders are data, you can read a test at a
glance, write one in a form, and edit it later in the same form.

## Goals

- A test's graders can be written in `graders.json`, one object per grader,
  in five kinds.
- Grading a `graders.json` gives the same scores as the equivalent
  `graders.ts`, with one exception described under "must pass".
- The `eval new` form can add graders of every kind. You never see JSON.
- `eval edit <test-dir>` opens an existing test in the form and saves it
  back.

## Non-goals

- Replacing `graders.ts`. It stays as the escape hatch for anything the
  five kinds cannot say. Existing suites are not converted.
- Compile and export checks for Agency-coding tests. The set-aside design
  at `docs/superpowers/specs/2026-10-19-graders-json-checklist-design.md`
  describes them. They could become a sixth kind later.
- Showing judge verdicts in the logs viewer.
- Running Pi or OpenCode through the suites as baselines.

## Part 1: the five grader kinds

Each kind answers one question about a run.

### Goal: did the agent do what was asked?

```json
{
  "kind": "goal",
  "name": "takes-a-position",
  "goal": "recommends a direction, or lays out the viable directions and says what would settle the choice",
  "mustPass": true,
  "passingScore": 0.5
}
```

An LLM reads the reply and scores it from 0 to 1 against the goal. This is
the bundled goal judge, the same one a test with a `goal` in `test.json`
and no graders uses today.

### Checklist: does the reply meet each point on a list?

```json
{
  "kind": "checklist",
  "name": "grounded-in-repo",
  "points": [
    "reflects that waypoint-lang is a single package with one bin",
    "builds on the harness/brains split in src/agent/",
    "says what kind of change drives agent releases"
  ],
  "context": "graderFiles/notes.md"
}
```

An LLM answers every point with yes, no, or cannot tell, and quotes the
words from the reply that decided it. The score is the share of points that
passed. "Cannot tell" counts as a fail. Points count equally. If you want
one point to count double, write it twice.

`context` is optional. It names a file under the test's `graderFiles/`
folder that the judge reads as background, such as the source text a
summary was made from. `graderFiles/` is already the folder for files the
graders alone can see, and every run stores a copy of it, so the judge
reads the stored copy and a stored run grades the same later.

This replaces the rubric judge for new tests. The rubric judge takes one
paragraph and returns one number. The checklist judge returns an answer per
point, so you can see which point fails across runs without reading every
verdict.

The judge is a new bundled program, `checklistJudge.agency`, beside
`rubricJudge.agency`. It returns one answer per input point, in order. A
reply with a different number of answers is a grader failure, not a score.

### Number: is a number from the run within a limit?

```json
{ "kind": "number", "name": "llm-calls", "measure": "llmCalls", "full": 0, "zero": 30, "weight": 0.1 }
```

```json
{ "kind": "number", "name": "under-five-minutes", "measure": "agentSeconds", "max": 300, "mustPass": true }
```

No LLM is involved. `measure` is one of `llmCalls`, `costUsd`,
`agentSeconds`, `tokensIn`, `tokensOut`.

There are two ways to score. With `full` and `zero`, the score is 1 at
`full`, 0 at `zero`, and in between for values in between. With `max`, the
grader passes when the value is at most `max` and fails otherwise. A grader
has one or the other.

`agentSeconds` is the time the agent spent working. Time spent waiting for a
person at an approval prompt is left out. In an eval run nobody is at a
prompt, so it equals the run's wall time. See "Log the wait at a prompt"
below for how the two are told apart in an interactive run.

The feedback is the value with its unit, so the scorecard shows "14 LLM
calls" beside the score.

### Count: how many rows of a kind are in the trace?

```json
{
  "kind": "count",
  "name": "no-repeated-fetches",
  "count": "toolCalls",
  "tool": "fetchMarkdown",
  "repeated": true,
  "max": 0
}
```

```json
{ "kind": "count", "name": "no-bad-arguments", "count": "errors", "messageStartsWith": "Unknown named argument", "max": 0 }
```

No LLM is involved. `count` is one of `toolCalls`, `errors`, `llmCalls`.
The optional fields narrow which rows count. `tool` is a tool name.
`repeated: true` keeps only a call whose tool and arguments match an earlier
call. `messageStartsWith` keeps only errors whose message starts with that
text. The grader passes when the count is at most `max`.

This is the kind that catches what went wrong in the research session the
owner pointed at, trace wX5GvrUq: twenty fetches of the same few pages, and
six errors the agent caused by misusing its own tools.

### Command: does a command pass when run over the agent's files?

```json
{
  "kind": "command",
  "name": "roundtrip",
  "command": "python3 -m pytest graderFiles/test_outputs.py::test_roundtrip",
  "mustPass": true
}
```

The command runs with the agent's working directory as its current
directory. Exit code 0 is a pass. Anything else is a fail. Whatever the
command printed is the feedback. One command is one grader.

The agent suite's pytest checks, which `evals/agency-agent/lib/checks.ts`
runs today, become commands of this kind. Nothing about this kind is
specific to Python.

### Fields every grader has

- `name`: the score row's key. Names must be unique within the file, as
  they must be in a `graders.ts` today.
- `weight`: default 1.
- `mustPass`: default false. A must-pass grader that fails stops grading,
  as today.

### Must pass

A must-pass grader has to be able to fail. Today a must-pass judge in
TypeScript passes any score, even 0, because the pass threshold defaults to
0. The JSON kinds close that hole:

- A must-pass goal grader requires `passingScore`. The form fills it in as
  0.5.
- A must-pass checklist grader passes only when every point passed.
- A must-pass number grader uses `max`.
- Count and command graders already pass or fail.

The same hole in the TypeScript graders is a separate ticket.

### Points on the score row

A checklist grader's score row carries its per-point answers:

```json
{
  "kind": "score",
  "name": "grounded-in-repo",
  "score": { "kind": "scalar", "value": 0.667 },
  "points": [
    { "point": "reflects that waypoint-lang is a single package with one bin", "pass": true, "evidence": "one package, one `waypoint` bin" },
    { "point": "builds on the harness/brains split in src/agent/", "pass": true, "evidence": "the brains behind AgentBrain are where the churn is" },
    { "point": "says what kind of change drives agent releases", "pass": false, "evidence": "" }
  ],
  "feedback": "Two of three. The reply never says what drives releases."
}
```

The score is still a score, so every reader of score rows keeps working.
`eval grade` prints the points under the grader:

```text
packaging-decision  score 0.81
  takes-a-position   0.80
  grounded-in-repo   0.667
      Two of three. The reply never says what drives releases.
      ✓ reflects that waypoint-lang is a single package with one bin
      ✓ builds on the harness/brains split in src/agent/
      ✗ says what kind of change drives agent releases
  llm-calls          0.53   14 LLM calls
```

### Loading

`loadTestDir` in `lib/eval/loadInputs.ts` already discovers `graders.ts`
beside `test.json`. It discovers `graders.json` the same way. A folder with
both files is a load error that names the folder. A `graders.json` that is
not a list, has an unknown kind, is missing a required field, or has two
graders with one name is a load error that names the file, the index, and
the field.

A test with a `graders.json` needs no `goal` in `test.json`, just as a test
with a `graders.ts` does not. A test with both a `goal` and a
`graders.json` uses both, as a test with a `goal` and a `graders.ts` does
today.

### What a run records

A run directory records which graders graded it, so `eval grade` of an old
run gives the same answer later. For `graders.ts`, the run row's
`GradersIdentity` in `lib/runDirectory/annotations.ts` names a bundle under
`graders/`. For `graders.json`, the file itself is stored under `graders/`
by content hash, and the identity names it in a new optional field,
`jsonFile`. Exactly one of `bundleFile` and `jsonFile` is set. No bundle is
generated from the JSON, so the loader is the only code that turns a kind
into a grader. The bundled judge files and `graderFiles/` are stored as
they are today.

### `agency eval check <suite>`

For each test that has a reference solution under `graderFiles/`, this
command runs the test's graders over the reference and reports any grader
the reference fails. A test whose own reference fails its graders is a
broken test, and this is where you find out, before a paid run. Judges are
LLM calls, so the command prints what it will spend first, and `--no-judge`
runs only the free graders.

## Part 2: graders in the `eval new` form

Below the five fields there is a section headed "graders". When a test has
none, it shows one line: "no graders: the goal above is judged by the
bundled goal judge".

Adding a grader asks a short series of questions on the same screen. Each
answer makes the next row appear below it. Here is the count kind:

```text
graders
  1. what to check    count things in the trace
     count            tool calls
     which tool       fetchMarkdown
     only repeats     yes
     at most          0
     name             no-repeated-fetches
     must pass        yes
```

The first row is a choice from the five kinds. Each kind then asks its own
questions, in order, and ends with name, must pass, and weight. Choices are
picked from a list. Text is typed into the row, as in the rest of the form.

If you go back and change an earlier answer, the rows below it change to
match. Every answer you have typed is kept, so changing "tool calls" to
"errors" hides the tool rows, and changing it back shows them again with
the old values. Only the rows that apply are written to the file.

A key on the grader's first row removes the grader, after a y/n question
like the ones that guard save and quit.

Validation runs on save, with the same problem list the form uses now. A
missing name or a non-number limit puts the cursor on the row. Save writes
`test.json` and, when there is at least one grader, `graders.json`, both in
the staged folder that is renamed into place. A test may have graders and
an empty goal.

## Part 3: `agency eval edit <test-dir>`

The same form, loaded from `test.json` and `graders.json`. Two rows cannot
be changed:

- The folder name. Renaming a test is moving a folder.
- The files row. It reads "files/ (12 files)" or "none". Replacing a
  test's seeded files would mean deleting the old copy, which this form
  does not do.

Save writes `test.json` and `graders.json` back in place, through the
staged folder, and leaves everything else in the folder alone. If you
removed every grader, `graders.json` is deleted rather than written as an
empty list.

Keys in `test.json` that the form does not show are kept. Those include
`tags`, `timeoutSec`, `expected`, `metadata`, `harnessMaxCost` and
`harnessMustPass`. The form keeps the parsed object and writes its fields
over it on save. Opening a hand-written test in the form never loses a key.

A test that has `graders.ts` opens with the graders section showing one
line, "graders.ts: edit the file", and no grader rows. The rest of the
form works.

## Related fixes

These are separate tickets in the same Linear project.

### Must-pass judges in TypeScript

A must-pass grader that returns a score and has no threshold passes
anything. Twenty-four graders across the suites are marked must-pass, and
thirteen grader files set no threshold at all. The fix: when a must-pass
grader returns a score and has no threshold, grading stops with an error
that names the grader. Then each suite gets its thresholds added.

### Log the wait at a prompt

In the research session above, 35 of the 56 minutes were the owner at an
approval prompt. The log cannot show that today. The agent's prompt runs
inside its policy handler, so the log records "approved by handler", the
same as a policy rule matching. Only the `agency run --interactive` prompt,
which runs after every handler has passed, is recorded as answered by a
person.

The fix is one event, logged by the two TypeScript functions that read the
keyboard: the choice builtin in `lib/stdlib/ui.ts`, which the agent's
`askUser` reaches, and `terminalPrompt` in `lib/runtime/interruptPrompts.ts`.
The event carries the interrupt id, when the prompt opened, when it closed,
and the answer. The logging client in `lib/statelogClient.ts` defines it.
Nothing in `lib/runtime/interrupts.ts`, in the agent, or in `policy.agency`
changes. The viewer's pause rows, built by `runPauses` in
`lib/logsViewer/problems.ts`, read the new event. The `agentSeconds` measure
subtracts the waits.

### A timeout on fetches

An HTTP fetch takes the run's abort signal and nothing else. The only
`requestTimeoutMs` in config is for statelog uploads. Fetches get a
timeout, with a default, that the caller can raise.

## Decided by the owner

- Each kind is added through its own questions. You never see JSON in the
  form.
- Rows appear as you answer, on one screen. No one-question-per-screen
  wizard.
- A grader written from one run applies to that test only.
- `graders.ts` stays as the escape hatch.
- The fifth kind is "run a command", not "run pytest".
- The rubric judge is replaced for new tests by the checklist judge from
  the set-aside design, with points on the score row.
- The paper-marking view prototyped earlier is not built.

## Calls made by the author, for the owner to check

- The names of the kinds and their fields.
- `repeated` compares tool name and arguments as the record keeps them. The
  record keeps a 200-character preview of arguments today, in
  `argsPreview` in `lib/eval/extract.ts`. The builder may keep the full
  arguments for this comparison.
- The agent suite's tests keep their `graders.ts` files for now, and the
  pytest runner in `evals/agency-agent/lib/checks.ts` is left alone until
  those tests are converted to command graders.
- `eval edit` refuses a test whose folder name differs from its `id` in
  `test.json`, with a message.
- `eval check` is in scope but last. It only applies to tests that carry a
  reference solution, which none do yet.

## Left to the builder

- The key bindings for add, remove, and picking from a list, within the
  form's rule that no letter is bound.
- How the section scrolls once a test has several graders and the form no
  longer fits the terminal.
- The checklist judge's prompt.
- The dev doc, `docs/dev/evals/graders-json.md`, and the update to
  `docs/dev/evals/eval-new.md` for the section and for `eval edit`.
