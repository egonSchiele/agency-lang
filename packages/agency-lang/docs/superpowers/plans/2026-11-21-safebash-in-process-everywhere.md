# safeBash: one rule for what runs in process. Implementation plan

**Goal:** a command safeBash can run itself is run by safeBash wherever
it sits in a line. A pipeline runs in process only when every stage
can.

**Spec:** `docs/superpowers/specs/2026-11-21-safebash-in-process-everywhere-design.md`.
The owner approved its rule on 2026-11-21. Read it first.

**Tickets:** ADI-360 (pull request 1), ADI-261 (pull request 2).

## Background for someone new to this code

`stdlib/safeBash.agency` turns a shell line into a plan. `planFor` parses
the line, and `planLine` decides how it runs. A plan has `effects` (the
questions to ask) and an `execution` (how to run it). `approvedPlan`
raises every effect before anything runs, and `runPlanned` runs the
execution.

Today `planLine` tries three things in order:

1. **A lone command.** `tryShellFreeStep` accepts an `echo`, a `grep`,
   or a `cat`, `head`, or `tail` whose arguments translate exactly to a
   stdlib tool. The plan's execution is one of `echo`, `write`, `grep`,
   or `read`, and `runPlanned` has an arm for each.
2. **A chain of those.** `tryShellFreeChain` walks the tree with
   `linksOf` and calls `tryShellFreeStep` on each command. If every one
   is accepted, the plan is a `steps` execution whose steps each carry
   an `inProcess` execution.
3. **Everything else.** `classifyAll` walks the tree with `classify`,
   which gives each command its effects by the bash rules. Every step it
   builds has `inProcess: null` (`runStepOf`). The plan is a `steps`
   execution, and `runSteps` runs each step under its own shell after
   planning it again (`checkedStep`).

So a command is planned by `tryShellFreeStep` or by `classify`,
depending on its neighbours. This plan makes `classify` the only
planner. The first two paths are deleted.

The runner already handles a line that mixes the two kinds of step:
`runOneStep` runs a step with `inProcess` set through `runInProcess`,
and any other step through `runBashStep`. No line produces such a mix
today.

An in-process step is not planned again before it runs. Its stdlib tool
opens the approved folder with `fixedRoot`, which refuses a link
anywhere in the path (`docs/dev/stdlib/contained-files.md`). That holds
in a mixed line too, where an earlier bash step can swap a folder.

## Constraints that apply to every task

- No effect is raised anywhere but `approvedPlan`. The runner raises
  nothing.
- A rejected question runs nothing.
- Every shell start still raises at least one effect.
- A bash step is never marked destructive.
- No line's list of effect names changes, except the one line the spec
  names (`grep -rn x node_modules | head`, in pull request 2). The
  payload changes are the three the spec lists.
- Change files with the Edit and Write tools. Run `make` once per pull
  request after the stdlib edits, grep its log for `error`, and run only
  the test files named below, each with `--check-capabilities` after
  the path and its output saved to a file.
- Fill in a new expected value by running the test with a placeholder,
  checking the actual value by eye, and copying it in.

## Review focus

These are the cases most likely to go wrong that the spec does not
spell out. Each has a test in the task that owns the code.

1. **A file the line itself writes, then reads.** In
   `pnpm build > out.txt; cat out.txt` with no `out.txt` on disk, the
   `cat` must stay a bash step, because the read tool needs a file that
   exists when the line is planned. (Task 1.)
2. **A folder swapped by an earlier bash step.** The in-process read
   after it must fail with the tool's message and read nothing outside
   the approved folder. (Task 2.)
3. **`$?` after an in-process step.** `cat gone-later.txt; echo $?` and
   `grep nomatch a.txt || echo none` must see the status the in-process
   step set. (Task 2.)
4. **A `cd` before an in-process step.** `cd sub && cat a.txt` must read
   `sub/a.txt`, and its payload must name `sub`. (Task 1.)
5. **A background job.** `startJob("echo hi")` must still be refused as
   a line that starts no shell, and a job whose one step would now be in
   process must not launch a shell for it. (Task 3.)

---

## Pull request 1: one classifier, and each step decides for itself

Branch `adit/safebash-pipeline-in-process`, into `main`.

### Task 1: `classify` marks a command it can run in process

**Files:** `stdlib/safeBash.agency`, `tests/agency/safeBash.agency`,
`tests/agency/safeBash.test.json`.

**What exists:** `tryShellFreeStep(command, cwd): Result<Plan>` returns a
plan whose execution is `echo`, `write`, `grep`, or `read`.
`stepExecOf(exec): Result<StepExec>` narrows an execution to those four.
`classifySimple` builds one `RunStep` through `runStepOf`.

**Change:**

- Add `def inProcessStep(command: SimpleCommand, line: LineState, readsStdin: boolean): Result<Classified>`.
  It returns a failure ("not this path") when `readsStdin` is true, when
  the command is wrapped in `timeout`, or when `tryShellFreeStep`
  refuses. Otherwise it returns the plan's effects, the command
  unchanged, `afterCommand(line, effects)`, and one `RunStep` whose
  `inProcess` is the plan's execution.
- `classifySimple` calls it first and returns its success. On a failure
  it carries on with the bash rule as today.
- `tryShellFreeStep` takes the classifier's folder (`line.cwd`). It
  already builds a strict line from the folder, so a file that is
  missing when the line is planned is refused, including one an earlier
  command of the line will write.
- `runStepOf` gains the in-process execution as a parameter, null for a
  bash step.

**Tests** (new node `eachStepDecidesForItself`, one row per line, each
row the outcome and, for each step, whether it is in process):

- `pnpm -v; cat one.txt` gives `[false, true]`.
- `cat one.txt && pnpm -v` gives `[true, false]`.
- `cd sub && cat a.txt` gives a `cd` step and `[true]`, and the
  `std::read` payload names `sub`.
- `pnpm -v > made.txt; cat made.txt`, with no `made.txt`, gives
  `[false, false]`.
- `timeout 5 cat one.txt` gives `[false]`.
- `(pnpm -v; cat one.txt)` gives a group with `[false, true]`.
- `true && grep -rn hello .` asks `std::grep` with `flags: "u"` and
  `maxResults: 1000`.
- `true; echo hi > out.txt` asks `std::write` with `content: "hi\n"`.

### Task 2: the mixed line runs

**Files:** `stdlib/safeBash.agency`, `tests/agency/safeBashSteps.agency`,
`tests/agency/safeBashSteps.test.json`.

**Change:** none is expected in the runner. `runInProcess` already
carries the folder, the status, and the output. Confirm two things by
reading `runSteps` and fix them if they do not hold:

- The time limit is not charged for an in-process step.
- `state.stderr` after a failed in-process step is printed as the bash
  path prints a failed step's stderr, and the line carries on by the
  join that follows.

**Tests** (each runs the line for real in a scratch fixture):

- `aMixedLineRuns`: `pnpm -v > /dev/null; cat one.txt` prints the file,
  and the debug events show one shell start.
- `anInProcessStepSetsTheStatus`: `grep nomatch one.txt || echo none`
  prints `none`, and `cat one.txt; echo $?` prints the file and `0`.
  (`echo $?` is a bash step, so this also covers a bash step reading an
  in-process step's status.)
- `aSwappedFolderStopsTheRead`: a handler swaps `sub` for a link to
  another folder while it answers the first question, in the way
  `aChangedFolderStopsTheLine` does. `true; cat sub/a.txt` then fails
  and prints nothing from the other folder.
- `aRejectedReadRunsNothingInAMixedLine`:
  `touch made.txt; cat one.txt` with `std::read` rejected leaves no
  `made.txt`.

### Task 3: delete the two extra planners

**Files:** `stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`,
`tests/agency/safeBash.agency` (helpers only), `stdlib/jobs.agency` if
it names a deleted kind.

**Change:**

- In `planLine`, delete the lone-command call to `tryShellFreeStep` and
  the call to `tryShellFreeChain`. `tryAgencyPlan` stays.
- Delete `tryShellFreeChain`, `chainLinks`, `linksOf`, `joinedLinks`,
  `ChainLink`, and `stepExecOf`.
- A lone in-process command is now a `steps` plan with one step. Remove
  `echo`, `write`, `grep`, and `read` from the `Execution` union and
  their arms from `runPlanned` and `outcomeOf`, and delete `runGrep` and
  `runRead` if nothing else calls them. `StepExec` keeps the four kinds.
- The branch of `planLine` for a line with no effects (`narrow.length ==
  0`) must come after a check for `allInProcess`: a lone `echo hi` has
  no effect and starts no shell, so it must not ask
  `std::bash::readonly`.
- `startsShell` already answers false for a line whose steps are all in
  process. A `cd` counts as in process (`allInProcess`), because `runCd`
  starts no shell. So `cd sub && cat a.txt` starts none, and as a job it
  runs in the foreground, as a lone `cat` does. (Changed in the owner's
  review of pull request 1: the first version counted a `cd` as a shell
  and sent that job to the broad question.)

**Tests:**

- The test helpers that read `plan.execution.kind` or an execution's
  content for a lone command read the one step's `inProcess` instead, so
  the expected values in `safeBash.test.json` do not move. The helper at
  `tests/agency/safeBash.agency` near line 2017 already does this for a
  chain.
- Every existing test in `safeBash`, `safeBashSteps`,
  `safeBashSavedOutput`, `safeBash-corpus`, `safeBashAccesses`, and
  `jobs` passes. An expected value that moves must be one of the spec's
  three payload changes, and the pull request description lists each.
- `aJobOfAnInProcessStepStartsNoShell` in `tests/agency/jobs.agency`.

### Task 4: docs

- `docs/dev/stdlib/safe-bash.md`: rewrite "In process when it
  translates" around the rule (the table, each step decides for itself)
  and remove the sentence "A line is in process only when every step
  is". State the rule and the reason. Add no history.
- Module doc comments in `stdlib/safeBash.agency` where they describe
  the lone and chain paths.
- Run `pnpm run lint:structure`.

**Pull request description:** the before-and-after table from the spec,
the payload changes that land here (grep in a mixed line, `echo` to a
file in a mixed line), and the answers to the owner's standing
questions: where each effect is raised, that the runner raises nothing,
and what a rejection runs.

---

## Pull request 2: input from the stage before

Opened after pull request 1 merges.

### Task 5: a table entry accepts stdin

**Files:** `stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`,
`lib/stdlib/grepDialect.ts`, `lib/stdlib/grepDialect.test.ts`.

**Change:**

- `StepExec` gains one kind:

  ```
  export type PipeExec = {
    kind: "pipe";
    first: EchoExec | GrepExec | ReadExec;
    filters: TextFilter[]
  }

  export type TextFilter =
    | { kind: "view"; view: ReadView }
    | { kind: "match"; regex: string; flags: string; invert: boolean }
  ```

- `shellFreeReadOf` and `shellFreeGrepRead` each have an arm for
  `{ kind: "stdin" }` that fails today. Add
  `def stdinFilter(command: SimpleCommand, line: LineState): Result<TextFilter>`,
  which calls the same readers and turns a `stdin` result into a filter:
  `head` and `tail` through `readViewFor`, and `grep` through
  `_grepPatternToRegex` with the flags `-v`, `-i`, `-E`, `-F`, `-w`. Any
  other grep flag fails, so the pipeline runs through bash.
- No second text search. `lib/stdlib/spill.ts` already searches a text
  with a grep query (`searchText`, on `compileGrepQuery` and
  `firstMatchingLines`), and `_grepSaved` is built on it. Export one
  function beside `_grepSaved` that takes a text and a `GrepQuery`, and
  make the `match` filter hold a `GrepQuery` and a `GrepRender`, as a
  `GrepExec` does. (Changed by the architecture review.)
- `classifyPipeline` tries the in-process path first: the first stage
  through `inProcessStep`, each later stage through `stdinFilter`. When
  every stage is accepted, the pipeline is one `RunStep` whose
  `inProcess` is the `pipe` execution and whose effects are the first
  stage's. Otherwise it carries on as today.
- `printStep` gains the `pipe` arm: print `first`, apply each filter in
  order, and append a grep's notes after the last filter. The step's
  status is 1 when the last filter is a `match` that kept no line.

**Tests:**

- Unit tests for `_filterLines`: a match, no match, `invert`, an empty
  text, and a last line with no newline.
- `pipelinesMatchRealTools` in `tests/agency/safeBash.agency`, in the
  style of `shellFreeReadMatchesRealTools`: each row runs the line in
  process and under real bash and compares text and status. Rows:
  `cat one.txt | head -3`, `head -20 one.txt | tail -5`,
  `cat one.txt | grep hello`, `cat one.txt | grep -v hello | head -2`,
  `cat one.txt | grep nomatch`, `grep -n hello one.txt | tail -1`,
  `grep -rn hello . | grep -i HELLO | head`, `echo hi | head`, and each
  grep flag once.
- `aPipelineStartsNoShell`: the debug events for
  `cat one.txt | head -3` show no shell start.
- `pipelinesThatStayInBash`: `git log --oneline | head -5`,
  `cat one.txt | sort`, `cat one.txt | grep -c hello`, and
  `cat one.txt | tee out.txt` each plan with `inProcess: null`.
- `grep -rn hello node_modules | head` asks `std::grep`.
- The corpus test: list every corpus line whose plan changed and check
  each is a pipeline whose effect names did not change.

### Task 6: docs

`docs/dev/stdlib/safe-bash.md`: the pipeline rule (every stage or none,
and why: bash runs the stages at the same time), the filter list, and
where the output differs from bash. Update the ADI-261 ticket to say the
eight filters and the `git log | head` case were dropped, with the
counts.

---

## Pull request 3: output to a file

Opened after pull request 2 merges.

**The architecture review recommends building only the `2>/dev/null`
bullet below and dropping `>` and `>>`:** no logged or corpus line
redirects a table command to a file. This waits for the owner's yes.

### Task 7: a redirect on any in-process step

**Files:** `stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`.

**What exists:** `writePlan` plans `echo hi > out.txt` as a `WriteExec`
whose payload carries the bytes. `tryShellFreeGrep` and
`tryShellFreeRead` refuse any redirect.

**Change:**

- An in-process step may carry one `>` or `>>` redirect to a file. The
  step asks its own effect and `std::write` for the file, with the
  content empty, which is the payload `redirectEffect` gives the bash
  path today. An `echo` keeps the payload with its bytes.
- The step runs its command, then writes the text through `_write` with
  the approved payload's folder and name. It prints nothing.
- `2>/dev/null` on an in-process step is accepted and does nothing. A
  step that fails still reports its message.
- Every other redirect (`<`, `2>file`, `>&`) keeps the step on the bash
  path.

**Tests:** `redirectsMatchRealTools` (the file's bytes after
`grep -n hello one.txt > out.txt`, `cat one.txt | head -2 >> out.txt`,
and `cat one.txt > out.txt` compared with real bash),
`aRejectedWriteWritesNothing`, and
`grep -rn hello . 2>/dev/null | head` runs in process.

### Task 8: docs

`docs/dev/stdlib/safe-bash.md`: where output can go, and the payload of
a write whose bytes are not known when the line is planned.

---

## Not in this plan

New table entries (`ls` and `find` come next), the eight filters the
ADI-261 ticket lists, and the `agency` outcome, which stays a
lone-command rule.
