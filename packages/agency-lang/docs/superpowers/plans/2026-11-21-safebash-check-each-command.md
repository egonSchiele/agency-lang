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
- Pull requests 1 and 2 change no question. Every effect list and every outcome pinned in `tests/agency/safeBash.test.json` and `tests/agency/safeBash-corpus.test.json` must be unchanged after each of them. Rows that pin the execution kind do change in Task 2, in the two ways that task lists.
- Pull request 1 changes how a line is split and never what runs. Each step runs the text the up-front plan rebuilt for it. Only pull request 2, which compares before it runs, may run a text planned later.
- Never mark a bash step destructive (`safe-bash.md`, "Why a bash call is never destructive").
- Do not add code that supports symlinks. Where a path turns out to be a link that was not approved, stop the line.
- Change files with the Edit and Write tools. Run `make` after a change to a `.agency` stdlib file and search the log for `error`, because `make` exits 0 on a stdlib type error. Run agency tests with `--check-capabilities` after the path, and save the output to a file.
- Fill a new test's expected value by putting a placeholder in the `.test.json`, running the test once, and copying the actual value from the saved log.
- The repo rules apply: types and not interfaces, arrays and not sets, objects and not maps, no dynamic imports.

## How the work is delivered

Three pull requests, stacked: pull request 2's branch starts from pull request 1's, and pull request 3's from pull request 2's. Each targets the branch below it, and pull request 1 targets `main`. To bring a lower branch's new commits into a higher one, merge. Never rebase a pushed branch, and never force push. The owner merges the pull requests. A separate review of each one follows, and its fixes go on that pull request's own branch.

This plan was revised after two reviews, both beside it: `...-architecture-review.md` and `...-review.md`.

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
  /** The folder as the plan had it, which is what the payloads name. */
  cwd: string;
  /** `cwd` with every link followed, for the folder check. */
  realCwd: string;
  /** The text the up-front plan rebuilt for this step. */
  text: string;
  effects: Effect[];
  readsStatus: boolean;
  /** Null when the step goes through bash. Otherwise the in-process
    execution, which is the existing `StepExec`. */
  inProcess: StepExec | null
}

/** A `cd`. `dir` is the real folder the plan resolved. `guarded` is true
  for a `cd` that is a whole command of the top-level list, which runs
  today as `cd '/abs' || exit 1`: when it fails, the line ends. */
export type CdStep = { kind: "cd"; join: Join; source: SimpleCommand; cwd: string; dir: string; guarded: boolean }

/** A parenthesized group. Its folder changes end at the closing parenthesis. */
export type GroupStep = { kind: "group"; join: Join; steps: LineStep[] }
```

- Produces, in `safeBash.agency`: `Classified` and `ClassifiedAll` each gain `steps: LineStep[]`.
- `Join` is the existing type that `ChainLink` uses (`"seq" | "and" | "or"`). If it is defined in `safeBash.agency`, move it to `actions.agency` so both files can name it.

This task has no test of its own, because nothing outside the classifier can read the steps until Task 2 puts them in the plan. Task 2's first step adds the test below. Do not export a helper to read the steps: every exported stdlib function is a tool and gets a page in the generated docs.

- [ ] **Step 1: (in Task 2) the test this task must satisfy.** The node `stepsOfALine` in `tests/agency/safeBash.agency` reads `planFor(line, FILES_FIXTURE).execution.steps`. It returns, for each line below, a summary of each step: its `kind`, its `join`, the verb of its source, and its effect names.

```
pnpm build && cat one.txt
cd sub && ls
pnpm build && cd sub && ls
(cd sub && ls); ls
cat one.txt | head -2 && ls
git status && git log --oneline -3 || echo none
pnpm test; echo "exit=$?"
timeout 5 pnpm test
```

Expected shapes to check by eye once the actual value is in: the second line is `[cd seq, run and]`; the fourth is `[group seq [cd seq, run and], run seq]`; the fifth has a pipeline as one `run` step; the seventh has `readsStatus: true` on the `echo`. Every line here raises at least one effect. A line that raises none, such as `false; echo after`, is a readonly plan of kind `bash` and has no steps.

- [ ] **Step 2: Implement.** Each classifier function returns the steps for its node:

- `classifySimple` and `classifyPipeline`: one `RunStep` with `source` set to the command it was given (not the rewritten one), `cwd: line.cwd`, `join: "seq"`, and `inProcess: null`.
  - `text` is `rebuild([classified.command])`, the rewritten command as text. A rebuild that fails makes the classify fail, as it makes the whole line broad today.
  - `realCwd` is `_realFolder(line.cwd)`. Add `_realFolder` in this task: `export async function _realFolder(dir: string): Promise<string>` in `lib/stdlib/safeBashRemove.ts`, returning `currentHost().files.realDir(dir)`, with a unit test that a link to a folder resolves to the folder. `line.cwd` is not always a real path: before the first `cd` it is whatever `resolveCwd` returned, which can be `"."`, a relative path, or a path through a link such as `/tmp` on macOS. The payloads keep `cwd` as it is, because changing it would change questions. `readsStatus` is true when any word of the command holds the variable named `?`. `knownOrExitStatus` already finds that variable; reuse its test.
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

- [ ] **Step 4: `make`, check the log, run `safeBash.agency`, `safeBash-corpus.agency`, `safeBashSavedOutput.agency`, `safeBashAccesses.agency`, and `jobs.agency`.** Many rows in `tests/agency/safeBash.test.json` pin the execution kind (through `planSummary`, `planKind`, and others): about 51 hold `"bash"` and 7 hold `"chain"`. Those rows change, and each change must be one of two:

- `bash` to `steps`, for a line whose outcome is `narrow`.
- `chain` to `steps`, for a line whose outcome is `shellFree`.

Any other change is a bug. No effect list and no outcome may change. Read the diff of the `.test.json` row by row before committing.

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

- [ ] **Step 0: Prove the test technique before anything else.** The tests in Tasks 5 and 6 change the disk between the plan and the run, from inside a handler. That is not verified. Write a five-line node: a handler around `safeBash("pnpm --version; ls", cwd: FIXTURE)` whose body writes a marker file and returns `approve()`, and check the `ls` output holds the marker. A handler body that calls a stdlib file function raises that function's own interrupt, which may not be allowed inside a handler. If it is not, use an agency-js test (`tests/agency-js/`): TypeScript receives the interrupt, changes the disk with `fs`, and then responds. Pick one technique here and use it for every such test in this plan.

- [ ] **Step 1: Write the tests.** The new test file has a fixture folder made the way `makeFilesFixture` makes one (copy that helper's approach; do not import a private one), with a folder `sub` that holds one file.

The node `steppedLinesPrintWhatOneBashPrinted` runs each line below with `safeBash(line, cwd: FIXTURE) with approve` and returns, for each, `[line, kind, ok, text]`: the plan's execution kind, whether the call succeeded, and its output or failure text.

```
ls sub && printf 'a\n' && printf 'b\n'
ls sub; false; printf 'after\n'
ls sub; false && printf 'skipped\n'; printf 'ran\n'
ls sub; false || printf 'rescued\n'
ls sub; true || printf 'skipped\n'
ls sub; false; printf 'exit=%s\n' "$?"
cd sub && ls
(cd sub && ls); ls
(cd nope-xyz && ls); ls sub
ls | head -1 && printf 'done\n'
ls sub; printf 'x\n' >&2; false
```

Every line holds a command that raises an effect (`ls sub`), because a line that raises none is a readonly plan of kind `bash` and would never reach the runner. The node first checks that `kind` is `steps` for every line and returns the line as a failure when it is not, so the test fails if a later change sends a line back to one `bash -c`. Every command runs through bash; no step here is in process.

The expected values are not a comparison with the `bash` tool. `bash()` returns an `ExecResult`, and `safeBash` returns a `Result` whose failure text ends in `Command exited with code N`, so the two texts differ for every failing line. The expected values are what `safeBash` returns in Step 2, while the `steps` arm still hands the whole line to `runBash`. The runner must then reproduce them exactly.

A second node, `stepsShareOneTimeLimit`, runs `ls sub; sleep 1; sleep 1; sleep 1` with `timeout: 2` and returns whether the failure text holds "stopped at the time limit of 2 seconds" and whether the call took under 3 seconds. A third, `noTimeLeftRunsNothing`, runs `ls sub; sleep 2; printf 'late\n' > late.txt` with `timeout: 2` and returns whether `late.txt` exists afterwards. Expected: it does not.

Do not export an executor to make any test easier: an exported executor runs a command with no approval (`safe-bash.md`, "Why the executors call `_bash`, `_write`, `_grep`, and `_read`").

- [ ] **Step 2: Run the tests while the `steps` arm still calls `runBash`, and record the actual values as the expected values.** This is the baseline. Read them once: the second line must print `after`, the sixth must print `exit=1`, and the ninth must print the listing of `sub` after the group fails.

- [ ] **Step 3: Implement `runSteps`.**

- Prepare saved-output copies once, first, exactly as `runBash` does with `_prepareSpillFiles(plan.savedPaths)`.
- Start with `{ cwd: dir, status: 0, stdout: "", stderr: "", leftMs: timeout * 1000, stopped: "", timedOut: false }` and call `runStepList`.
- `runStepList` loops over the steps. A step is skipped by `skipsStep(step.join, state.status == 0)`. The loop ends early when `state.stopped != ""` or `state.timedOut`.
  - **Before starting any step, when `state.leftMs <= 0`, set `timedOut` and run nothing.** The host sets a time limit only when the limit is above zero (`buildSpawnOptions`, `lib/stdlib/shell.ts`), so a step started with zero or less would run with no limit at all.
  - `RunStep`: `runOneStep`.
  - `CdStep`: set `cwd` to `step.dir` and `status` to 0. In this pull request the runner does not look at the folder. A folder that is gone shows up when the next step's `_bash` throws.
  - `GroupStep`: call `runStepList` on its steps with a copy of the state, then keep everything from the result except `cwd`. A `stopped` set inside a group ends the group only when it came from a top-level rule; see the next point.
- **A missing folder.** `_bash` throws when its folder does not exist (`resolveSpawnCwd`). `runOneStep` wraps the call in `try`, as `runBash` does. Today a top-level `cd` runs as `cd '/abs' || exit 1`, which ends the whole script, while a `cd` joined by `&&` only gives status 1, and bash carries on after a group: `(cd nope-xyz && ls); ls sub` still prints the listing of `sub`. So `CdStep` gains a field, `guarded: boolean`, true for a `cd` that is a whole command of the top-level list (the branch in `classifyAll` that calls `cdOrExit`). When a step's `_bash` throws for a missing folder, the runner sets `status` to 1, and sets `stopped` to "`<label>` was not run: <why>" only when the `cd` that led there was guarded. The ninth line of the test pins the group case.
- `runOneStep` handles both forms. A step with `inProcess` set runs `printStep(step.inProcess)`, inside `destructive { }` when it is a write, exactly as `runChain` does today. A failure there sets `status` to 1. `runChain` keeps only the message of the last step that failed (`lastError`), so the runner does the same for in-process steps: keep the last failure message and put it in `stderr` at the end, not one per failed step. The existing chain tests pin this text. Then delete `runChain`.
- For a step that goes through bash, `runOneStep` runs `step.text`, the text the up-front plan rebuilt. It does not classify the step again in this pull request. Task 5 adds that, with the comparison. If the step reads the status (`step.readsStatus`), the text is `(exit ${state.status}); ${step.text}`.
- It runs `_bash(text, state.cwd, state.leftMs, "", {})`, measures the time the call took with `now()` from `std::date`, and returns the state with stdout and stderr appended, `status` set to the exit code, `leftMs` reduced, and `timedOut` copied.
- Back in `runSteps`: a `timedOut` state returns `timeoutFailure(label, timeout, stdout, stderr)`; a `stopped` state or a non-zero `status` returns `exitFailure(status, stdout, stderr, label, note)` with the gh login note when `isGhLoginFailure` says so; otherwise `success(keepOutput(stdout, 0, label))`. `label` is the model's text, as in `runBash`.
- Point the `steps` arm of `runPlanned` at `runSteps`.

Do not wrap a bash step in `destructive { }`.

- [ ] **Step 4: `make`, check the log, run the new test file and the five files from Task 2.** All must pass with no expected value changed.

- [ ] **Step 5: Write the doc section.** Mechanism and rule only: what a step is, how the runner carries the folder and the exit status, that a group gets a copy of the folder, that the time limit covers the line, and that a pause lands between steps and never inside one.

- [ ] **Step 6: Commit, then open pull request 1.**

### Task 4: No narrow rule changes the shell

**Files:**
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

- [ ] **Step 1: Write the test.** The node `noNarrowRuleChangesTheShell` plans each line below followed by `; ls sub`, so the line has a step, and returns the lines whose outcome is not `broad`. Expected: an empty list.

```
export FOO=1
set -e
shopt -s globstar
alias ll=ls
umask 077
hash -p /bin/ls ls
FOO=1
printf -v x hi
read x
trap 'echo' EXIT
pushd sub
source x
eval ls
exec ls
unset PATH
declare x=1
enable -n echo
builtin cd sub
command cd sub
```

Each line is a real way to change the shell, so the test fails when someone adds a rule for one of them. If a line is not `broad` today, stop and report it: the runner is not safe for that line.

- [ ] **Step 2: Variables that depend on the commands before.** `echo` and `printf` accept any word, so a narrow line can print a shell variable, and splitting the line changes some of them. In `simpleCommandRule`, a command with a word that holds one of these variables fails with "`$NAME` depends on the commands before it": `_`, `OLDPWD`, `PIPESTATUS`, `BASH_COMMAND`, `LINENO`, and `!`. Keep the names in one static list. Add these rows to the node that pins `echo` lines, each expected `broad`:

```
ls sub; echo $_
pnpm --version && cd sub && echo $OLDPWD
false | true; echo $PIPESTATUS
```

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

- [ ] **Step 1: Write the failing tests** in a node `aChangedPlanStopsTheLine`. Each case changes the disk while the first question is being answered, with the technique Step 0 of Task 3 chose, and then approves everything.

| Line | What changes the disk | Expected |
|---|---|---|
| `pnpm --version; cat one.txt` | `one.txt` becomes a link to a file outside the fixture | fails; text holds "Stopped before `cat one.txt`"; the outside file's content is not in the output |
| `pnpm --version; ls sub` | `sub` becomes a link to a folder outside | fails with the stop |
| `pnpm --version; cat one.txt` | nothing | succeeds (a `timeout` field alone must not stop a line) |

A second node, `harmlessLinesDoNotStop`, pins the lines the spec says keep working. The check plans each step with a fresh line, which knows nothing of what earlier steps wrote or made, while the up-front plan used `written` and `made`. Each line below must succeed:

```
mkdir -p out && ls out
mkdir -p build && cd build && pnpm --version
pnpm --version > v.txt && cat v.txt
pnpm --version > v.txt; pnpm --version >> v.txt
gh pr view 1 --json title; ls sub
```

The fourth line matters because a write payload may say whether the file existed: it does not exist up front and does exist when the second step runs. If the two payloads differ there, `sameEffects` must ignore that one field, and the commit message must say which field and why. The fifth line pins a pending `gh` lookup: its fixture is a git repository with an `origin` remote, which `_ghResolveRepo` reads with `git remote get-url` and no network. That line may fail for want of a login; the test checks only that its failure text does not hold "Stopped before".

- [ ] **Step 2: Run and confirm the first two rows of the first node fail** (the outside content is printed).

- [ ] **Step 3: Implement.** In `runOneStep`, before a bash step runs, classify it again: `classify(step.source, freshLine(state.cwd), origin, false)`, with `origin` taken from the execution so a `gh` step is not looked up twice.

- If the fresh `classify` is a failure, stop: the step has no rule any more.
- If `!sameEffects(step.effects, fresh.effects)`, stop.
- Otherwise run the text rebuilt from the fresh classify, not `step.text`. The two can differ while the effects match, and the fresh one describes the disk as it is. From this pull request on, `step.text` is used only by a job.
- The refuse wall is not run again. `removeRefusal` reads the disk, but a changed `rm` target changes the `std::remove` payload, so the effect check stops the line. Say this in the doc section, so that nobody adds a second wall to the runner.
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

**Interfaces:**
- Consumes: `_realFolder` and `RunStep.realCwd` from Task 1.
- Do not use `_realPathIn` for this. It ends in `files.realPath`, which does not follow a link in the last step of a path, and a folder that became a link is a link in the last step. `files.realDir` follows it. The first version of `isSymlink` in #1523 made this mistake.
- The check compares a real path with a real path: `_realFolder(state.cwd)` with `step.realCwd`. It must not compare with `step.cwd`, which can be `"."`, a relative path, or a path through a link.

- [ ] **Step 1: Write the failing tests** in the same node style, with the technique Step 0 of Task 3 chose:

| Line | Run from | What changes the disk | Expected |
|---|---|---|---|
| `git status; cd sub && git status` | the fixture | `sub` becomes a link to a second git repository outside the fixture | fails with a stop before the `cd`; the other repository's status is not in the output |
| `cd sub && pnpm --version` | the fixture | `sub` becomes a link to a folder outside | fails with a stop |
| `cd sub && ls` | the fixture | nothing | succeeds |
| `git status; git log --oneline -1` | `<fixture>/sub` | `sub` becomes a link to a second git repository | fails with "Stopped before `git status`"; no output from either command |
| `pnpm --version; ls` | `"."` | nothing | succeeds |
| `pnpm --version; ls` | the fixture, spelled through a link to it | nothing | succeeds |
| `pnpm --version; ls` | a relative path to the fixture | nothing | succeeds |

In the fourth row every question is raised before any step runs, so `sub` is already a link when the first step starts, and the folder check stops the line before `git status`. That row is the only one that reaches the folder check without going through a `cd`. It must fail when the check uses `_realPathIn` and pass with `_realFolder`. The last three rows fail if the check compares with `step.cwd`.

The fixture for the first row needs `git init` in the fixture folder and in the outside folder. `tests/agency/safeBash.agency` has git fixtures; follow how they set one up.

- [ ] **Step 2: Run and confirm the first two rows fail.**

- [ ] **Step 3: Implement.**

- `CdStep`: before moving, resolve the `cd`'s target again from the runner's folder with `cdTarget(step.source, freshLine(state.cwd))`. Stop when it fails or when the result is not `step.dir`. This stops the line for every `cd`, guarded or not: a `cd` target that changed or vanished after approval is not the folder that was approved.
- `RunStep`: before the effect check, stop when `_realFolder(state.cwd)` is not `step.realCwd`.
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
