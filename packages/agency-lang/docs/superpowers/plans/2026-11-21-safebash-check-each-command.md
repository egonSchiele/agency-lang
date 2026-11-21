# safeBash checks each command just before it runs: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A narrow `safeBash` line runs one step at a time, and each step is planned again against the disk just before it runs, so a question that was approved is still true when its command starts.

**Architecture:** The classifier already walks the command tree and returns effects per node. It gains one more output: a list of steps, each with the model's command, the folder it was planned in, and its approved effects. One runner, written in Agency, runs the steps with bash's rules for `;`, `&&`, and `||`. Before each step that goes through bash, it resolves its folder again, classifies the step again, and stops the line when either differs from what was approved. Today's in-process chain becomes a step list in which every step runs in process, so the plan ends with one step type, one runner, and one execution kind for a line of steps. `ChainStep`, `ChainExec`, the `chain` kind, and `runChain` are deleted.

This plan was revised after `2026-11-21-safebash-check-each-command-architecture-review.md`, which sits beside it.

**Tech Stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), TypeScript host helpers (`lib/stdlib/`), Agency tests (`tests/agency/safeBash*.agency`).

**Spec:** `docs/superpowers/specs/2026-11-20-safebash-check-each-command-design.md`. The review that shaped it is `docs/superpowers/specs/2026-11-20-safebash-check-each-command-design-review.md`. Read both before starting.

## Background a new reader needs

Read `docs/dev/stdlib/safe-bash.md` first, at least these sections: "Decide, then act", "The rules", "Outcomes", "Chains in process", "What a command may have done to the disk", and "`startJob` shares the approval".

The facts this plan leans on:

- `planFor(source, cwd, origin)` returns a `Plan`: `effects` to raise, and an `execution` that says what to run. `approvedPlan` raises every effect with `raiseAll`. Only then does `runPlanned` run the execution. Nothing in this plan adds a raise anywhere else.
- For a line that is not all in process, `planLine` calls `classifyAll(commands, cwd, origin)`. That walks the tree through `classify`, which returns a `Classified`: `{ effects, line, command }`. `command` is the command as bash will run it, which can differ from what the model wrote (a `cd` names its resolved folder, a git command is rebuilt).
- `classify(command, line, origin, readsStdin)` is already "plan one command in this folder". The spec calls that function `planStep`. This plan does not add a second function with that name. The check calls `classify` on one step, which is the same code the up-front plan ran for it. That is what makes the two effect lists comparable.
- Today the whole rebuilt text runs under one `bash -c` in `runBash`.
- `runChain` already runs a list of in-process steps with `skipsStep(join, ok)`. The new runner follows its shape.
- A pause from outside lands only at a statement boundary, and a call in flight keeps going (`docs/dev/runtime/pause.md`, "How a pause happens"). So a step's `bash -c` is never cut by a pause and never runs twice. A pause also waits while the runner is inside a tool call, which is where `safeBash` usually runs. This answers the question the spec left for the plan.

## Global Constraints

- Every question is still raised in `approvedPlan`, before anything runs. The runner raises nothing.
- All or nothing stays: one unrecognized command sends the whole line to `std::bash`, and a broad line runs whole under one `bash -c`, as today.
- Pull requests 1 and 2 change no question. Every expected value in `tests/agency/safeBash.test.json` and `tests/agency/safeBash-corpus.test.json` that pins effects must be unchanged after each of them.
- Never mark a bash step destructive (`safe-bash.md`, "Why a bash call is never destructive").
- Do not add code that supports symlinks. Where a path turns out to be a link that was not approved, stop the line.
- Change files with the Edit and Write tools. Run `make` after a change to a `.agency` stdlib file and search the log for `error`, because `make` exits 0 on a stdlib type error. Run agency tests with `--check-capabilities` after the path, and save the output to a file.
- Fill a new test's expected value by putting a placeholder in the `.test.json`, running the test once, and copying the actual value from the saved log.
- The repo rules apply: types and not interfaces, arrays and not sets, objects and not maps, no dynamic imports.

## Review Focus

1. **A line that worked before prints something different.** `pnpm test; echo "exit=$?"` must print the real exit status, and `cd lib && ls` must list `lib`. Pinned by the parity test in Task 3.
2. **A failing command in the middle of a `;` list.** `false; echo after` must still print `after`, and the line's status is the last step's. Pinned in Task 3.
3. **A harmless line stops.** A step whose fresh effects differ from the approved ones only in `timeout`, or only because a `gh` lookup is pending, must not stop. Pinned in Task 5.
4. **The time limit.** A line of three steps with a 2 second limit must stop at 2 seconds in total, not 2 seconds per step. Pinned in Task 3.
5. **A group.** `(cd sub && ls); ls` must list `sub` and then the starting folder. Pinned in Task 3.

---

## Pull request 1: the step list and the runner, with no checks

### Task 1: The classifier returns steps

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (the `Execution` union, near `kind: "chain"` at line 681)
- Modify: `stdlib/safeBash.agency` (`Classified`, `ClassifiedAll`, `classifyAll`, `classifySimple`, `classifyPipeline`, `classifyAnd`, `classifyOr`, `classifyGroup`, `andSide`, `cdStep`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Produces, in `actions.agency`:

```
export type LineStep = RunStep | CdStep | GroupStep

/** One simple command or one pipeline, as the model wrote it. */
export type RunStep = {
  kind: "run";
  join: Join;
  source: Command;
  cwd: string;
  effects: Effect[];
  readsStatus: boolean;
  /** Null when the step goes through bash. Otherwise the in-process
    execution, which is the existing `StepExec`. */
  inProcess: StepExec | null
}

/** A `cd`. `dir` is the real folder the plan resolved. */
export type CdStep = { kind: "cd"; join: Join; source: SimpleCommand; cwd: string; dir: string }

/** A parenthesized group. Its folder changes end at the closing parenthesis. */
export type GroupStep = { kind: "group"; join: Join; steps: LineStep[] }
```

- Produces, in `safeBash.agency`: `Classified` and `ClassifiedAll` each gain `steps: LineStep[]`.
- `Join` is the existing type that `ChainLink` uses (`"seq" | "and" | "or"`). If it is defined in `safeBash.agency`, move it to `actions.agency` so both files can name it.

This task has no test of its own, because nothing outside the classifier can read the steps until Task 2 puts them in the plan. Task 2's first step adds the test below. Do not export a helper to read the steps: every exported stdlib function is a tool and gets a page in the generated docs.

- [ ] **Step 1: (in Task 2) the test this task must satisfy.** The node `stepsOfALine` in `tests/agency/safeBash.agency` reads `planFor(line, FILES_FIXTURE).execution.steps`. It returns, for each line below, a summary of each step: its `kind`, its `join`, the verb of its source, and its effect names.

```
pnpm build && cat one.txt
false; echo after
cd sub && ls
pnpm build && cd sub && ls
(cd sub && ls); ls
cat one.txt | head -2 && ls
git status && git log --oneline -3 || echo none
pnpm test; echo "exit=$?"
timeout 5 pnpm test
```

Expected shapes to check by eye once the actual value is in: the third line is `[cd seq, run and]`; the fifth is `[group seq [cd seq, run and], run seq]`; the sixth has a pipeline as one `run` step; the eighth has `readsStatus: true` on the `echo`.

- [ ] **Step 2: Implement.** Each classifier function returns the steps for its node:

- `classifySimple` and `classifyPipeline`: one `RunStep` with `source` set to the command it was given (not the rewritten one), `cwd: line.cwd`, `join: "seq"`, and `inProcess: null`. `readsStatus` is true when any word of the command holds the variable named `?`. `knownOrExitStatus` already finds that variable; reuse its test.
- `cdStep`, and the `cd` branch of `classifyAll`: one `CdStep` with `dir` set to the folder `cdTarget` returned.
- `classifyAnd` and `classifyOr`: the left side's steps, then the right side's steps with the `join` of the first right step set to `"and"` or `"or"`. Write one helper for this: `def joined(steps: LineStep[], join: Join): LineStep[]`.
- `classifyGroup`: one `GroupStep` holding the inner steps.
- `classifyAll`: the concatenation, each top-level command's first step keeping `"seq"`.

The parser is left-associative, so a flat list with a join per step runs in bash's order. `linksOf` has a comment that explains why; point to it.

- [ ] **Step 3: Run `make` and check the log for `error`.**

Run the tests like this, and save the output: `node ./dist/scripts/agency.js test tests/agency/safeBash.agency --check-capabilities > <log> 2>&1`

- [ ] **Step 4: Run the whole `safeBash.agency` and `safeBash-corpus.agency` test files.** Every expected value must be unchanged, because no effect and no rewritten command changed.

- [ ] **Step 5: Commit.**

### Task 2: The `steps` execution kind

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`Execution`)
- Modify: `stdlib/safeBash.agency` (`planLine`, `bashPlan`, `outcomeOf`, `stepExecOf`, `planRecord`, `approvedPlan`, `runPlanned`, and the match near line 6185 that reads `{ kind: "bash", command as text }`)

**Interfaces:**
- Consumes: `LineStep` from Task 1.
- Produces, in `actions.agency`, one more member of `Execution`:

```
{
  kind: "steps";
  /** The whole rebuilt line, which a background job still runs as one text. */
  command: string;
  steps: LineStep[];
  /** The repository a `gh` step was planned with, for planning it again. */
  origin: GhRepo | null
}
```

- Produces: `def stepsPlan(command: string, steps: LineStep[], effects: Effect[], verbs: string[], origin: GhRepo | null): Plan`.

- [ ] **Step 1: Write the failing tests.** Add the node `stepsOfALine` described in Task 1. Add rows to the node that pins `outcomeOf` (search `tests/agency/safeBash.agency` for `planOutcome(`): `pnpm build && cat one.txt` is `narrow`, a lone `pnpm test` is `narrow`, `pwd` is `narrow`, `ls $X` is `broad`, and `echo a; cat one.txt` is `shellFree`. Add a node `narrowLinesPlanAsSteps` that returns `planFor(line, FILES_FIXTURE).execution.kind` for the same five lines. Expected: `steps`, `steps`, `bash`, `bash`, `steps`.

- [ ] **Step 2: Run it and confirm the new node fails.**

- [ ] **Step 3: Implement.**

- In `planLine`, the last line, `return bashPlan(rebuilt.value, narrow, verbs, null)`, becomes `return stepsPlan(rebuilt.value, classified.value.steps, narrow, verbs, origin)`. The readonly branch above it and every `broadPlan` stay as they are, so a `bash` execution now means "broad or readonly".
- `tryShellFreeChain` keeps its walk (`chainLinks`, `linksOf`) and its rule that every command must plan through `tryShellFreeStep`. It now returns a `stepsPlan` whose steps each have `inProcess` set to the step's `StepExec`, `cwd` set to the folder, and the step's own effects. This is the only place in this plan where `inProcess` is set, so a step runs in process exactly when it does today.
- Delete `ChainStep`, `ChainExec`, and the `chain` member of `Execution`. `ChainLink` stays, as the type `linksOf` returns.
- `outcomeOf`: a `steps` plan is `shellFree` when every step has `inProcess` set, and `narrow` otherwise. Write one helper, `def allInProcess(steps: LineStep[]): boolean`, that looks inside groups.
- `stepExecOf`: replace the `chain` arm with `{ kind: "steps" } => failure("a stepped line is not a step")`.
- `planRecord`: record the rebuilt `command` and the number of steps.
- `approvedPlan`: `asJob` is true for `exec.kind == "bash"`, and for a `steps` plan that is not all in process. A job still launches `exec.command`, the whole text. Follow the match near line 6185 to the launch and make it accept both kinds. An all-in-process line runs in the foreground, as a chain does today.
- `runPlanned`: for now, a `steps` plan that is all in process goes to `runChain`, changed to read `LineStep[]`, and any other goes to `runBash(exec.command, dir, command, timeout, plan.verbs, plan.savedPaths)`. Task 3 replaces both with one runner and deletes `runChain`.

- [ ] **Step 4: `make`, check the log, run `safeBash.agency`, `safeBash-corpus.agency`, `safeBashSavedOutput.agency`, `safeBashAccesses.agency`, and `jobs.agency`.** Only the new node's value and nothing else may differ.

- [ ] **Step 5: Commit.**

### Task 3: The runner

**Files:**
- Modify: `stdlib/safeBash.agency` (new functions beside `runChain`; the `steps` arm of `runPlanned`)
- Modify: `docs/dev/stdlib/safe-bash.md` (new section "A narrow line runs one step at a time")
- Test: `tests/agency/safeBashSteps.agency`, `tests/agency/safeBashSteps.test.json` (new)

**Interfaces:**
- Consumes: the `steps` execution from Task 2; `skipsStep`, `exitFailure`, `timeoutFailure`, `keepOutput`, `isGhLoginFailure`, `_prepareSpillFiles`, `_bash`, `rebuild`, `classify`, `freshLine`.
- Produces:

```
/** What the runner carries from one step to the next. */
type StepsState = {
  cwd: string;
  status: number;
  stdout: string;
  stderr: string;
  /** Milliseconds left of the line's limit. */
  leftMs: number;
  /** Why the line must stop now, or "" to carry on. */
  stopped: string;
  timedOut: boolean
}

def runSteps(exec: StepsExec, dir: string, source: string, timeout: number, plan: Plan): Result<string>
def runStepList(steps: LineStep[], state: StepsState, origin: GhRepo | null): StepsState
def runOneStep(step: RunStep, state: StepsState, origin: GhRepo | null): StepsState
```

`StepsExec` is the name for the `steps` member of `Execution`; define it in `actions.agency` the way `ChainExec` is defined.

- [ ] **Step 0: Prove the test technique before anything else.** The tests in this task and in Tasks 5 and 6 change the disk between the plan and the run, from inside a handler. That is not verified. Write a five-line node: a handler around `safeBash("pnpm --version; ls", cwd: FIXTURE)` whose body writes a marker file and returns `approve()`, and check the `ls` output holds the marker. A handler body that calls a stdlib file function raises that function's own interrupt, which may not be allowed inside a handler. If it is not, use an agency-js test (`tests/agency-js/`): TypeScript receives the interrupt, changes the disk with `fs`, and then responds. Pick one technique here and use it for every such test in this plan.

- [ ] **Step 1: Write the failing tests.** The new test file has a fixture folder made the way `makeFilesFixture` makes one (copy that helper's approach; do not import a private one). One helper runs a line both ways and returns both results:

```
def bothWays(line: string): any
```

It returns `[line, viaSteps, viaOneBash]`, where `viaSteps` is `safeBash(line, cwd: FIXTURE) with approve` and `viaOneBash` is `bash(line, cwd: FIXTURE) with approve`, each reduced to `{ ok, text }`: whether it succeeded, and its output or failure text. The test node `stepsMatchOneBash` returns a list of `viaSteps == viaOneBash` for these lines, expected all `true`:

```
printf 'a\n' && printf 'b\n'
false; printf 'after\n'
false && printf 'skipped\n'; printf 'ran\n'
false || printf 'rescued\n'
true || printf 'skipped\n'
ls nope; printf 'exit=%s\n' "$?"
cd sub && ls
(cd sub && ls); ls
ls | head -1 && printf 'done\n'
printf 'x\n' >&2; false
```

Every command in these lines runs through bash. No in-process step is in this test, because an in-process `grep` is allowed to differ from the real one.

A second node, `stepsShareOneTimeLimit`, runs `sleep 1; sleep 1; sleep 1` with `timeout: 2` and returns whether the failure text holds "stopped at the time limit of 2 seconds" and whether the call took under 3 seconds.

A third node, `aFailedCdStopsTheLine`, runs `ls sub; cd sub && ls` after `sub` is removed between the plan and the run, and expects a failure whose output does not hold a second listing.

A test changes the disk between the plan and the run with a handler. Every question is raised before anything runs, so a handler that answers the first question can change the disk inside its body and then return `approve()`. Here the handler removes `sub` with `remove(...)` from `std::fs`. Tasks 5 and 6 use the same technique for the attack lines. Do not export an executor to make this easier: an exported executor runs a command with no approval (`safe-bash.md`, "Why the executors call `_bash`, `_write`, `_grep`, and `_read`").

- [ ] **Step 2: Run and confirm** that `stepsMatchOneBash` and the time limit node pass already, because the arm still calls `runBash`. That is the baseline: the change must keep them passing. `aFailedCdStopsTheLine` may pass or fail here; record which.

- [ ] **Step 3: Implement `runSteps`.**

- Prepare saved-output copies once, first, exactly as `runBash` does with `_prepareSpillFiles(plan.savedPaths)`.
- Start with `{ cwd: dir, status: 0, stdout: "", stderr: "", leftMs: timeout * 1000, stopped: "", timedOut: false }` and call `runStepList`.
- `runStepList` loops over the steps. A step is skipped by `skipsStep(step.join, state.status == 0)`. The loop ends early when `state.stopped != ""` or `state.timedOut`.
  - `RunStep`: `runOneStep`.
  - `CdStep`: set `cwd` to `step.dir` and `status` to 0. If the folder is not there, set `status` to 1 and `stopped` to "`cd` could not enter the folder", which is what the `cd ... || exit 1` guard does today.
  - `GroupStep`: call `runStepList` on its steps with a copy of the state, then keep everything from the result except `cwd`.
- `runOneStep` handles both forms. A step with `inProcess` set runs `printStep(step.inProcess)`, inside `destructive { }` when it is a write, exactly as `runChain` does today. A failure there sets `status` to 1 and puts the message in `stderr`. Then delete `runChain`.
- For a step that goes through bash, `runOneStep` builds the text from the step's source: `classify(step.source, freshLine(state.cwd), origin, false)`, then `rebuild([classified.command])`. Task 5 adds the comparison at this same point. If the step reads the status (`step.readsStatus`), the text is `(exit ${state.status}); ${text}`.
- The texts of the steps must add up to the line the up-front plan rebuilt. Add a node `stepTextsMatchTheLine` that, for each line of `stepsMatchOneBash`, joins the step texts with their joins and compares the result with `planFor(line, FIXTURE).execution.command`. Without it, this pull request could change what runs and no test would notice. Reading a step's text needs no export: the node can rebuild it from `execution.steps` with `planFor` on the step's own text and compare the `command` fields.
- It runs `_bash(text, state.cwd, state.leftMs, "", {})`, measures the time the call took with the stdlib clock that `timeoutFailure`'s caller uses (find how `runBash`'s callers measure time; if nothing in this file reads a clock, import `now` from `std::date` and check its name there first), and returns the state with stdout and stderr appended, `status` set to the exit code, `leftMs` reduced, and `timedOut` copied.
- Back in `runSteps`: a `timedOut` state returns `timeoutFailure(label, timeout, stdout, stderr)`; a `stopped` state or a non-zero `status` returns `exitFailure(status, stdout, stderr, label, note)` with the gh login note when `isGhLoginFailure` says so; otherwise `success(keepOutput(stdout, 0, label))`. `label` is the model's text, as in `runBash`.
- Point the `steps` arm of `runPlanned` at `runSteps`.

Do not wrap any step in `destructive { }`.

- [ ] **Step 4: `make`, check the log, run the new test file and the five files from Task 2.** All must pass with no expected value changed.

- [ ] **Step 5: Write the doc section.** Mechanism and rule only: what a step is, how the runner carries the folder and the exit status, that a group gets a copy of the folder, that the time limit covers the line, and that a pause lands between steps and never inside one.

- [ ] **Step 6: Commit, then open pull request 1.**

### Task 4: No narrow rule changes the shell

**Files:**
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

- [ ] **Step 1: Write the test.** The node `noNarrowRuleChangesTheShell` holds its own copy of bash's builtin names, copied from `BUILTIN_VERBS`. Bash's builtins do not change, and exporting the list would add a tool and a docs page for one test. The node plans `<verb> x` for every name and returns the names whose outcome is `narrow`. Expected: `["cd", "echo", "pwd", "true", "false", ":", "printf", "type"]` in the list's own order, or whatever subset the run shows; compare it with the list in the spec's section "Why splitting a line is safe" and stop if a name outside that list appears.

- [ ] **Step 2: Add `$_`.** In `simpleCommandRule`, a command with a word that holds the variable named `_` fails with "`$_` reads the command before it". Add rows `ls src; echo $_` (broad) and `echo $_` (broad) to the node that pins `echo` lines.

- [ ] **Step 3: `make`, run, fill, commit.** This task goes in pull request 1.

---

## Pull request 2: the checks and the stop

### Task 5: Check the effects before each step

**Files:**
- Modify: `stdlib/safeBash.agency` (`runOneStep`; new `sameEffects`, `stopMessage`)
- Test: `tests/agency/safeBashSteps.agency`

**Interfaces:**
- Produces:

```
def sameEffects(approved: Effect[], fresh: Effect[]): boolean
def stopMessage(step: RunStep, fresh: Effect[], ranBefore: number): string
```

- The failure a stop returns carries `{ type: "planChanged" }` as its data, beside the text.

- [ ] **Step 1: Write the failing tests** in a node `aChangedPlanStopsTheLine`. Each case uses a handler that changes the disk while answering the first question, then approves everything.

| Line | What the handler does | Expected |
|---|---|---|
| `printf 'x\n'; cat one.txt` | replaces `one.txt` with a link to a file outside the fixture | fails; text holds "Stopped before `cat one.txt`"; the outside file's content is not in the output |
| `printf 'x\n'; cat one.txt` | nothing | succeeds, prints `x` and the file |
| `printf 'x\n'; ls sub` | replaces `sub` with a link to a folder outside | fails with the stop |
| `pnpm --version; cat one.txt` | nothing | succeeds (a `timeout` field alone must not stop a line) |

Use a real program for the first step where the row says so, because `printf` raises nothing and the handler needs a question to answer. Where the first step raises nothing, put the read first and a second read after it.

- [ ] **Step 2: Run and confirm the first and third rows fail** (the outside content is printed).

- [ ] **Step 3: Implement.** In `runOneStep`, after the fresh `classify`:

- If the fresh `classify` is a failure, stop: the step has no rule any more.
- If `!sameEffects(step.effects, fresh.effects)`, stop.
- `sameEffects` compares the two lists in order: same length, same `name`, and the same payload once `timeout` is removed from both. Compare payloads as JSON text. `planRecord` already turns effects into plain data for the log; reuse what it uses.
- A stop sets `state.stopped` to `stopMessage(...)` and `status` to 1, and runs nothing. `runSteps` returns it as `failure(text, { type: "planChanged" })`, with the output so far in the text the way `failedOutput` joins it.
- The message names the step as the model wrote it, the approved effect and path, what the fresh plan found, how many steps already ran, and ends with "Run the rest as a new command if you still want it." Use the spec's example as the model for the wording.
- Log each check with `_debug("safeBash step check", { step, same })` and each stop with `_debug("safeBash step stopped", { ... })`.
- A step with `inProcess` set is not checked. The stdlib tool checks the path when it opens it, which is the check this task adds for bash.
- Look for a deep-equality helper in the stdlib before writing one for `sameEffects`, and name the one used in the commit message.
- **The tool trace.** The agent's trace reads a failed command's last line to find its exit status (see the comment in `exitFailure`, and `safeBashFailure` in `docs/dev/agents/tool-output.md`). A stop has no exit status of its own. Give it its own last line, "[stopped: the plan changed]", the way `timeoutFailure` has one, teach `safeBashFailure` to show it as "stopped" on the tool's line, and add a case to the test that `tool-output.md` names.

- [ ] **Step 4: `make`, run, fill, and rerun the files from Task 2.**

- [ ] **Step 5: Commit.**

### Task 6: Check the folder before each step, and every `cd`

**Files:**
- Modify: `stdlib/safeBash.agency` (`runStepList`, `runOneStep`)
- Test: `tests/agency/safeBashSteps.agency`

**Files, also:**
- Modify: `lib/stdlib/safeBashRemove.ts` and its test (new `_realFolder`)

**Interfaces:**
- Produces, in `lib/stdlib/safeBashRemove.ts`: `export async function _realFolder(dir: string): Promise<string>`, which returns `currentHost().files.realDir(dir)`.
- Do not use `_realPathIn` for this. It ends in `files.realPath`, which does not follow a link in the last step of a path, and a folder that became a link is a link in the last step. `files.realDir` follows it. The first version of `isSymlink` in #1523 made this mistake.

- [ ] **Step 1: Write the failing tests** in the same node style:

| Line | Run from | What changes the disk | Expected |
|---|---|---|---|
| `git status; cd sub && git status` | the fixture | `sub` becomes a link to a second git repository outside the fixture | fails with a stop before the `cd`; the other repository's status is not in the output |
| `cd sub && pnpm --version` | the fixture | `sub` becomes a link to a folder outside | fails with a stop |
| `cd sub && ls` | the fixture | nothing | succeeds |
| `git status; git log --oneline -1` | `<fixture>/sub` | `sub` becomes a link to a second git repository | fails with a stop before the second command |

The last row is the only one that reaches the folder check without going through a `cd`. It must fail when the check uses `_realPathIn` and pass with `_realFolder`. Add a unit test for `_realFolder` beside the others in `lib/stdlib/safeBashRemove.test.ts`: a link to a folder resolves to the folder.

The fixture for the first row needs `git init` in the fixture folder and in the outside folder. `tests/agency/safeBash.agency` has git fixtures; follow how they set one up.

- [ ] **Step 2: Run and confirm the first two rows fail.**

- [ ] **Step 3: Implement.**

- `CdStep`: before moving, resolve the `cd`'s target again from the runner's folder with `cdTarget(step.source, freshLine(state.cwd))`. Stop when it fails or when the result is not `step.dir`.
- `RunStep`: before the effect check, resolve `state.cwd` with `_realFolder(state.cwd)` and stop when the result is not `step.cwd`.
- Both stops use `stopMessage` with a folder wording: "it was approved to run in `<a>`, and that folder now leads to `<b>`".

- [ ] **Step 4: `make`, run, fill, rerun the files from Task 2.**

- [ ] **Step 5: Update the doc section from Task 3** with the two checks, what a stop returns, and what the check does not close (the spec's section of that name).

- [ ] **Step 6: Commit, then open pull request 2.** Its description must say that no question changed, and list the lines that now stop.

---

## Pull request 3: delete the prediction rule

### Task 7: Remove `DiskState`

**Files:**
- Modify: `stdlib/safeBash.agency` (`LineState`, `freshLine`, `afterCommand`, `classifySimple`, `classifyPipeline`, `missingPath`, `cdTarget`, and the deletions below)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`, `tests/agency/safeBash-corpus.json`, `tests/agency/safeBash-corpus.test.json`
- Modify: `docs/dev/stdlib/safe-bash.md` (remove "What a command may have done to the disk"; rewrite "Files the line wrote and folders it made")

- [ ] **Step 1: Change the expected values first.** In `noPathAfterACommandThatReplacesPaths`, every row that is broad only because of the rule becomes narrow. Rename the node to `aLineAfterACheckoutIsNarrow`, and move its attack rows to `safeBashSteps.agency` as stops, with a handler that makes the swap. Add the five rows of the spec's table "Lines that get their narrow questions back".

- [ ] **Step 2: Run and confirm those rows fail.**

- [ ] **Step 3: Delete** `DiskState`, `diskAfter`, `worseDisk`, `refuseStalePath`, `namesPath`, `SEE_THROUGH_EFFECTS`, `NAMED_CHANGE_EFFECTS`, `CHANGING_EFFECTS`, the `disk` field of `LineState`, and the `disk` tests in `missingPath` and `cdTarget`. `written` and `made` stay.

- [ ] **Step 4: `make`, run, and read every changed expected value.** Each change must be a line going from broad to narrow. A line going the other way is a bug in this task.

- [ ] **Step 5: Commit.**

### Task 8: The pipeline rule

**Files:**
- Modify: `stdlib/safeBash.agency` (`classifyPipeline`)
- Test: `tests/agency/safeBash.agency`

- [ ] **Step 1: Write the failing test** `aPipelineHasOneStageThatAsks`, with the five rows of the spec's "Pipelines" table and `pnpm test | cat nope.txt` (narrow: one stage asks).

- [ ] **Step 2: Implement.** In `classifyPipeline`, count the stages whose effects hold any name other than `std::exec`. More than one fails with "two stages of a pipeline each ask a question, and they run at the same time". Remove the `together` line state that set the disk to "changed".

- [ ] **Step 3: `make`, run, fill.** Then run `safeBash-corpus.agency`: no corpus line may change. If one does, stop and report it; the spec's claim that the rule costs nothing in the logged lines would be wrong.

- [ ] **Step 4: Commit.**

### Task 9: The job rule

**Files:**
- Modify: `stdlib/safeBash.agency` (`approvedPlan`, and the launch that reads the plan's text)
- Modify: `docs/dev/stdlib/jobs.md` ("Approvals"), `docs/dev/stdlib/safe-bash.md` ("`startJob` shares the approval")
- Test: `tests/agency/jobs.agency`

**Interfaces:**
- Produces: `def jobShape(steps: LineStep[]): { cwd: string | null; step: RunStep } | null`. It returns the one `RunStep`, with the folder of a leading `CdStep` if there is one, and null for any other list.

- [ ] **Step 1: Write the failing tests:** as a job, `cd sub && sleep 1` asks `std::exec` with `cwd` set to the fixture's `sub`; `sleep 1 && sleep 1` asks one `std::bash`; `sleep 1` asks what it asks today.

- [ ] **Step 2: Implement.** In `approvedPlan`, when `jobMs != null` and the plan is a `steps` plan: if `jobShape` is null, replace the plan with `broadPlan(command, plan.verbs, { kind: "unrecognized", detail: "a job runs its line whole, so only one command, or a `cd` and one command, gets narrow questions" })` before raising. Otherwise raise as planned, and at launch resolve the folder again as Task 6 does, stop if it changed, and launch the one step's text in that folder.

- [ ] **Step 3: `make`, run `jobs.agency`, fill, commit, and open pull request 3.** Its description lists every line whose question changed, from the test diffs, in a before and after table.

---

## Not in this plan: in-process steps in a mixed line

In this plan a step runs in process only when every step of its line does, which is today's behaviour. Running a `grep` or a read in process inside a line that also has bash steps is ADI-360. It changes payloads and needs the exit status of an in-process step to match the real program's, so it gets a design of its own, with ADI-261.

---

## After the last pull request

- Close ADI-358, and link the three pull requests in it.
- Read the `_debug` stop events in `~/.agency-agent/perry-log.jsonl` after a week of use. A stop on a harmless line is a bug in `sameEffects` or in a rule that reads the disk in a way that changes between two plans.
