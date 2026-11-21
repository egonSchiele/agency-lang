# safeBash: check each command just before it runs (ADI-358)

Status: draft for review. Nothing here is built.

## The problem

`safeBash` plans a whole line at once. It resolves every path against the
disk, raises every question, and then hands the whole line to one `bash
-c`. So every question describes the disk as it was before the first
command ran. A command early in the line can make a later question false.

```
git checkout evil; cat README.md
```

Before #1523, this asked `std::git::checkout` and `std::read` for
`<cwd>/README.md`. On the `evil` branch, `README.md` was a link to a file
outside the repository, and `cat` printed that file. The stdlib's symlink
checks run when a stdlib tool opens a file. They do not run for a command
bash runs.

#1523 closed this with a rule that predicts what each command can do to
the disk (`DiskState`: known, changed, or replaced). After a command that
can replace a path, no later command may name one, and the line asks the
broad `std::bash` question. The rule works, and it has two costs:

- **It is a guess.** Every effect has to be placed in a list by hand. A
  wrong placement is a hole. Five holes of this kind were found in two
  days.
- **It costs prompts.** `git checkout main && cat package.json` is a
  common, harmless line. It used to ask two narrow questions and now asks
  `std::bash`.

## The idea in one paragraph

Keep asking every question up front, exactly as today. Then run the line
one command at a time. Just before each command runs, plan that one
command again against the disk as it is now, and compare the result with
what was approved. If they match, run it. If they differ, stop the line.
safeBash never asks a question in the middle of a line.

## What the person sees

Nothing changes for a line whose commands do what the plan said.

```
git checkout main && cat package.json
```

1. Up front: `std::git::checkout`, and `std::read` for
   `<cwd>/package.json`. This line is narrow again.
2. `git checkout main` runs.
3. safeBash plans `cat package.json` again. It still resolves to
   `<cwd>/package.json`, the path that was approved. `cat` runs.

For the attack line:

```
git checkout evil; cat README.md
```

1. Up front: `std::git::checkout`, and `std::read` for `<cwd>/README.md`.
2. `git checkout evil` runs.
3. safeBash plans `cat README.md` again. It now resolves to
   `/outside/secret`. That is not what was approved, so the line stops.

The tool returns a failure that says what happened, with the output so
far:

```
Stopped before `cat README.md`: it was approved to read
<cwd>/README.md, and that path now leads to /outside/secret.
`git checkout evil` already ran. Run the rest as a new command
if you still want it.
```

If the model runs `cat README.md` as a new command, it is planned fresh
and asks `std::read` for `/outside/secret`. The person sees the true
question and can say no.

## Why splitting a line is safe

Splitting a line into separate `bash -c` calls would be wrong if commands
shared shell state: a variable set by one and read by the next, a
function, a `trap`, `set -e`. They do not, because of rules safeBash
already has:

- A line is split only when its plan is narrow. A broad line runs whole
  under `std::bash`, as today. Its question is "run this text", which no
  earlier command can make false.
- A narrow line should carry no shell state. A variable in a recognized
  position makes the command unrecognized. A builtin that changes the
  shell (`export`, `set`, `source`, `trap`, `alias`) must have no narrow
  rule either. I have not checked every name in `BUILTIN_VERBS` against
  the rules, so the first pull request does that, with a test that fails
  when a builtin that changes the shell gains a narrow rule.

Two pieces of state remain, and the runner carries both itself:

| State | Example | How the runner carries it |
|---|---|---|
| The working directory | `cd lib && ls` | safeBash already resolves a `cd` to an absolute folder. The runner keeps the folder and starts each later command in it. A `cd` spawns no shell. |
| The last exit status | `pnpm test; echo "exit=$?"` | The runner knows the status of the command it just ran. A command that reads `$?` runs as `(exit 3); echo "exit=$?"`. |

## What one step is

The runner walks the same tree the classifier walked.

- A simple command is one step.
- `;`, `&&`, and `||` are run by the runner, with the rule `runChain`
  already uses: `;` runs the next step always, `&&` only after a success,
  `||` only after a failure.
- A pipeline is one step. Its stages run at the same time, so it cannot
  be split.
- A group in parentheses runs its inner commands as steps, with its own
  copy of the working directory, which is dropped at the closing
  parenthesis.

A step that translates to a stdlib tool (`cat one.txt`, a `grep` that
translates, an `echo`) runs in process, as it does today when it is alone
or in a chain of such commands. Every other step runs through `bash -c`.
So `tryShellFreeChain` stops being a separate all-or-nothing path. It
becomes the case where every step happens to run in process.

## What "the same as approved" means

For each step, safeBash keeps the effects the up-front plan gave it: each
effect's name and payload. Before the step runs, it plans the step again,
alone, in the runner's current folder. The step runs when the two lists
are equal, ignoring `timeout`.

The up-front plan still has to describe files and folders that do not
exist yet, so that it can ask narrow questions:

```
mkdir -p out && ls out
```

Up front, `out` is not on the disk. `LineState.made` lets the plan ask
`std::ls` for `<cwd>/out` anyway. When `ls out` is about to run, `out`
exists, the fresh plan gives `std::ls` for `<cwd>/out`, and the two
match.

So `LineState.written` and `LineState.made` stay. What changes is what
they are trusted for. Today a wrong prediction is a hole. After this
change a wrong prediction is a line that stops.

## What is deleted

- `DiskState`, `diskAfter`, `worseDisk`, `refuseStalePath`, `namesPath`,
  and the lists `SEE_THROUGH_EFFECTS`, `NAMED_CHANGE_EFFECTS`, and
  `CHANGING_EFFECTS`.
- The `disk` checks in `missingPath` and `cdTarget`.

One small rule replaces them, for the one place the runner cannot step: a
pipeline in which one stage can replace a path and another stage names a
path asks `std::bash`. An example is `git checkout x | cat README.md`.
No such line is in the logs.

`resolveBashPath` (the `..` after a symlink) stays. That gap is inside one
word, and checking later does not close it.

## Lines that get their narrow questions back

The "After" column is what the design predicts. No code has run these.

| Line | Today | After |
|---|---|---|
| `git checkout main && cat package.json` | `std::bash` | checkout, read |
| `git stash pop && ls` | `std::bash` | stash pop, ls |
| `git checkout -b new && ls` | `std::bash` | checkout, ls |
| `git switch main; grep -rn TODO src` | `std::bash` | switch, grep |

## Background jobs

`startJob` raises what `safeBash` raises and then launches the line as a
job. A job's line runs in the job's own process, where this runner is not
present. Teaching the job runner to step is a larger change than this
design.

The rule for a job: the line may be one step, or a `cd` followed by one
step.

```
startJob("cd app && pnpm dev")
```

The `cd` is resolved and checked at launch, and the job starts `pnpm dev`
in that folder. Any other line with more than one step asks `std::bash`
as a job. In the foreground the same line keeps its narrow questions.

**This is the one decision in this design that changes a prompt for the
worse.** A job such as `startJob("pnpm build && pnpm start")` asks two
`std::exec` questions today and would ask one `std::bash`.

## What this does not close

There is still a short gap between the fresh plan of a step and the
moment its program opens the file. Today the gap is the whole line, and
the line's own commands can use it. After this change the gap is a few
milliseconds, and only a process that is already running beside the line
can use it. A step that runs in process has no gap, because the stdlib
tool checks the path when it opens it.

## Interrupts, handlers, and checkpoints

- Every raise still happens in `approvedPlan`, before anything runs. The
  runner raises nothing. Handlers and policies see the same interrupts
  they see today, in the same order.
- The runner never pauses for an answer, so it adds no new point at which
  a checkpoint is taken. A run paused from outside in the middle of a
  line resumes after the last step that finished, as `runChain` does
  today.
- A checkpoint is a file a person can edit. The approved effects for each
  step are held in the plan, which is a local variable. Editing them in a
  checkpoint can only make the fresh plan disagree, which stops the line,
  or agree with a plan the handlers never saw. The second case is the
  same exposure `safeBash` has today, where the text to run is also a
  local variable.

## Differences from bash that a person could notice

- **Output order.** Each step's stdout and stderr are collected and
  joined in step order. Within one step nothing changes.
- **The time limit** covers the whole line. Each step runs with the time
  that is left.
- **One more failure.** The stop described above.
- **Cost.** One extra plan per step, which reads a few paths, and one
  `bash` start per step instead of one per line.

## How it would be built

Three pull requests, each of which leaves main working.

1. **The runner, with no checks.** A narrow line runs step by step and
   must print what the whole line prints under one `bash -c`. Parity
   tests compare the two for output, exit status, `$?`, `cd`, groups,
   and the joins. No prompt changes.
2. **The check before each step, and the stop.** The attack lines from
   #1523's tests stop instead of running. Still no prompt changes.
3. **Delete the prediction rule.** The lines in the table above become
   narrow, the pipeline rule and the job rule go in, and
   `noPathAfterACommandThatReplacesPaths` is rewritten to pin the stop.

Rough size: five to seven days.

## What this leaves for other tickets

- **ADI-261** (run a pipeline's stages in process) is unchanged. A
  pipeline is one step here.
- **A read of a file the line has not made yet**, such as `pnpm build &&
  cat dist/out.txt` with `out.txt` missing, asks `std::bash` today. With
  the check in place it could ask `std::read` for the path as written,
  and stop if the file turns out to be a link. That would remove more
  prompts, and it is a separate change.

## Decisions (owner, 2026-11-20)

1. **The job rule.** A job line with more than one step asks
   `std::bash`, apart from a leading `cd`. The prediction rule is not
   kept alive for jobs.
2. **Stop.** The whole line stops at the first step that does not match.
   It does not skip that step and carry on.
3. **The lines that become narrow again.** All four lines in the table
   ask their narrow questions up front and rely on the check.
