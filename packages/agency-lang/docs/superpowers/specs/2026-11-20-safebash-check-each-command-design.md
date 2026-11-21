# safeBash: check each command just before it runs (ADI-358)

Status: second draft, revised after the review in
`2026-11-20-safebash-check-each-command-design-review.md`. Nothing here
is built.

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
- **It blocks the direction below.** safeBash should run an Agency
  function for every command it can, and an Agency function cannot run
  in the middle of one `bash -c`.

The rule also makes a harmless line such as `git checkout main && cat
package.json` ask `std::bash`. That is not a reason to do this work. Of
the 130 lines in `tests/agency/safeBash-corpus.json`, that line is the
only one the rule makes broad, and #1523 added it as an example.

## The idea in one paragraph

Keep asking every question up front, exactly as today. Then run the line
one step at a time. Just before each step runs, plan that one step again
against the disk as it is now, and compare the result with what was
approved. If they match, run it. If they differ, stop the line. safeBash
never asks a question in the middle of a line.

## The cheaper design that was set aside

safeBash could keep one `bash -c` and write a guard in front of each
command, as it already does for `cd` and `git diff`:

```
git checkout evil; [ "$(realpath README.md)" = /abs/repo/README.md ] || exit 97; cat README.md
```

That is about two days of work against six to eight, and a background
job would run as it does today. It was set aside for two reasons
(owner, 2026-11-21):

- Bash would resolve the path with one piece of code and safeBash with
  another, and the two would have to agree. A disagreement is a false
  stop or a hole.
- Bash stays in charge of the whole line, so no command in it could
  ever be handed to an Agency function.

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

## What one step is

The runner walks the same tree the classifier walked.

- A simple command is one step.
- A `cd` is one step. It starts no shell.
- `;`, `&&`, and `||` are run by the runner, with the rule `runChain`
  already uses: `;` runs the next step always, `&&` only after a success,
  `||` only after a failure.
- A pipeline is one step. Its stages run at the same time, so it cannot
  be split.
- A group in parentheses runs its inner commands as steps, with its own
  copy of the working directory, which is dropped at the closing
  parenthesis.

A step is a command of the model's text, not of the text that runs. The
plan rewrites some commands: `git diff` becomes `(git rev-parse
--show-toplevel >/dev/null && git diff ...)`, and a `gh` command gains
`GH_HOST`. The rewritten text is still one step.

## One function plans a step: `planStep`

Today a command gets its effects in three ways, and they disagree:

| Step | Effects inside a line | Effects from `planFor` on the step alone |
|---|---|---|
| `grep -rn TODO src` | `std::grep` with the raw pattern, `flags: ""`, `maxResults: 0` | `std::grep` with the translated regex, `flags: "u"`, `maxResults: 1000` |
| `pwd` | none | `std::bash::readonly` |
| `echo "exit=$?"` | none | `std::bash::readonly` |

So the check cannot call `planFor` on a step's text. A harmless `grep`
would stop every time.

The design adds one function, `planStep(command, line, form)`. It
returns three things:

- the step's effects,
- how the step runs: in process through a stdlib tool, or the text to
  give `bash -c`,
- the `LineState` after the step.

Both sides of the check call it:

- **Up front,** the plan calls `planStep` for each step in order, with
  the `LineState` built so far. `planStep` decides the form. A step runs
  in process when its in-process planner accepts it against the disk as
  it is now, and through bash otherwise. The questions asked are the ones
  for that form. A `grep` that will run in process asks the in-process
  payload, so a policy rule saved for a lone `grep -rn` matches it.
- **Before the step runs,** the runner calls `planStep` again on the same
  command, with a fresh `LineState` whose folder is the runner's folder,
  and with the form the up-front plan chose. If the step can no longer be
  planned in that form, the line stops.

The step runs when the two effect lists are equal, ignoring `timeout`.
The runner runs what the fresh call returned, so the text that runs
always comes from the disk as it is now.

A step with no effects, such as `pwd` or `echo hi`, has an empty list
both times, and the lists match. `std::bash::readonly` stays a question
about the whole line, which `planLine` asks.

For a `gh` step, the fresh call is given the repository the up-front
plan looked up. Looking it up again would be a second call to GitHub,
and `git checkout` does not change the remotes.

The plan needs a new execution kind for this, `{ kind: "steps" }`. Each
step in it holds the source command, the join before it, the form, and
the approved effects. `tryShellFreeChain` stops being a separate
all-or-nothing path: it becomes the case where every step is in process.

## The folder is checked too

A `git` or `std::exec` payload names its folder as a plain string, and
nothing resolves that string again. That leaves this line open:

```
git checkout evil && cd sub && git status
```

Up front, `sub` is a real folder and the question is `std::git::status`
in `<cwd>/sub`. On the `evil` branch, `sub` is a link to another
repository. A fresh plan of `git status` in `<cwd>/sub` gives the same
payload, so the effect check passes, and git prints the status of the
other repository.

So the runner has a second rule. Before each step, it resolves its own
folder again with `realDir`, and stops the line if the result differs
from the folder the up-front plan used for that step. A `cd` is checked
the same way: the runner resolves its target again before moving, and
stops if the target changed. A `cd` that fails stops the line, which is
what `cd '/abs' || exit 1` does today.

## Why splitting a line is safe

Splitting a line into separate `bash -c` calls would be wrong if
commands shared shell state. A narrow line shares almost none:

- **A broad line is not split.** It runs whole under `std::bash`, as
  today. Its question is "run this text", which no earlier command can
  make false.
- **No narrow rule changes the shell, apart from `cd`.** The builtins
  with a narrow rule today are `cd`, `echo`, `pwd`, `true`, `false`,
  `:`, `printf`, `type`, and `command -v`. `printf -v` is refused. Every
  other builtin has no rule, and so does a line made only of
  assignments. `&`, `!`, and a redirect on a group do not parse, so such
  a line asks `std::bash`. The review checked this against the code. A
  test will fail when a builtin that changes the shell gains a narrow
  rule.
- **`echo` and `printf` may print a variable** (ADI-356 is about that).
  An environment variable is the same in every `bash -c`, so it does not
  matter here.

Three pieces of state remain:

| State | Example | What the design does |
|---|---|---|
| The working directory | `cd lib && ls` | The runner keeps the folder and starts each later step in it. |
| The last exit status | `pnpm test; echo "exit=$?"` | The runner knows the status of the step it just ran. A step that reads `$?` runs as `(exit 3); echo "exit=$?"`. |
| The last argument, `$_` | `ls src; echo $_` | A word that holds `$_` makes its command unrecognized, so the line asks `std::bash` and runs whole. |

## Steps that run in process

**This section is not built by ADI-358. It is ADI-360.** In ADI-358 a
step runs in process only when every step of its line does, which is
what a chain does today. The text below is the starting point for
ADI-360's design.

A step that runs in process behaves as the same command does today when
it is alone. That differs from the real program in two known ways: the
in-process `grep` skips what `.gitignore` ignores and stops at 1000
matches. Today that shows only for a lone command or a chain of
in-process commands. After this change it shows in any narrow line with
such a step, for example the `grep` in `git switch main; grep -rn TODO
src`. That is accepted, because a lone `grep -rn` already behaves this
way.

Two rules keep the rest exact:

- **The exit status.** An in-process step that fails reports status 1,
  where real `grep` reports 2 for an error. So a step runs through bash
  when the step after it reads `$?`.
- **Writes.** `runChain` runs an in-process write inside `destructive {
  }`. A later failure in the same call then removes safeBash from the
  conversation, and a stop is a failure. So a write step runs in process
  only when every step in the line does, as today. In any other line it
  runs through bash, which is also what happens today.

## Pipelines

A pipeline is one step, so the check cannot run between its stages. One
rule covers it, and it needs no list of effects:

**In a pipeline, at most one stage may raise an effect other than
`std::exec`. Otherwise the line asks `std::bash`.**

`std::exec` is the one effect whose approval already lets the program
read and change any file. Any other effect, including one added later,
counts against the limit, so a mistake asks a broad question and never
opens a hole.

| Pipeline | Effects other than exec, by stage | Result |
|---|---|---|
| `git checkout x \| cat README.md` | checkout, read | `std::bash` |
| `git checkout main \| tee log.txt` | checkout, write | `std::bash` |
| `cat package.json \| grep version` | read, none | narrow |
| `pnpm test 2>&1 \| tee out.log \| tail -30` | none, write, none | narrow |
| `git log --oneline \| head > out.txt` | log, write | `std::bash` |

The last row is a line that is narrow today and would become broad. None
of the 26 pipelines in `tests/agency/safeBash-corpus.json` has two such
stages, so the rule costs nothing in the logged lines. It can be widened
later if such lines show up.

A stage may name a path that is not on the disk yet only when no other
stage raises anything except `std::exec`. The rule above already says
so.

## What is deleted

- `DiskState`, `diskAfter`, `worseDisk`, `refuseStalePath`, `namesPath`,
  and the lists `SEE_THROUGH_EFFECTS`, `NAMED_CHANGE_EFFECTS`, and
  `CHANGING_EFFECTS`.
- The `disk` checks in `missingPath` and `cdTarget`.

`LineState.written` and `LineState.made` stay, so the up-front plan can
ask a narrow question about a file or folder the line has not made yet:

```
mkdir -p out && ls out
```

Up front, `out` is not on the disk, and `made` lets the plan ask
`std::ls` for `<cwd>/out`. When `ls out` is about to run, `out` exists,
and the fresh plan gives the same payload. What changes is what these
two lists are trusted for. Today a wrong prediction is a hole. After
this change a wrong prediction is a line that stops.

`resolveBashPath` (the `..` after a symlink) stays. That gap is inside
one word, and checking later does not close it.

## Lines that get their narrow questions back

The "After" column is what the design predicts. No code has run these.

| Line | Today | After |
|---|---|---|
| `git checkout main && cat package.json` | `std::bash` | checkout, read |
| `git stash pop && ls` | `std::bash` | stash pop, ls |
| `git checkout -b new && ls` | `std::bash` | checkout, ls |
| `git switch main; grep -rn TODO src` | `std::bash` | switch, grep |
| `pnpm build && cat dist/out.txt` (`out.txt` not there yet) | `std::bash` | exec, read |

The last row follows from deleting the `disk` check in `missingPath`.
The plan asks `std::read` for `<cwd>/dist/out.txt` as written. If the
build makes `out.txt` a link to another file, the fresh plan resolves
the link, and the line stops.

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

The logs hold seven distinct `startJob` lines. Four are a `cd` followed
by one `node -e` command, and one is a lone `ls`; those five are
unchanged. One uses `$(...)` and asks `std::bash` already. One would get
worse:

```
git status --short && git branch --show-current && ls docs/superpowers/plans
```

It is a line that finishes at once and did not need to be a job.

## What this does not close

There is still a short gap between the fresh plan of a step and the
moment its program opens the file. Today the gap is the whole line, and
the line's own commands can use it. After this change the gap is a few
milliseconds. Two things can use it: a process already running beside
the line, and a child process that an earlier step left running. Only a
`std::exec` step can leave one, and its approval already lets it read
any file. A step that runs in process has no gap, because the stdlib
tool checks the path when it opens it.

## Interrupts, handlers, and checkpoints

- Every raise still happens in `approvedPlan`, before anything runs. The
  runner raises nothing. Handlers and policies see the same interrupts
  they see today, in the same order.
- The runner is Agency code, as `runChain` is. Its folder, the last exit
  status, and the output so far are local variables, so a checkpoint
  saves them. A run paused between two steps resumes at the next step.
  That step is planned again before it runs, so a change to the disk
  during the pause is caught too.
- A pause that arrives while a step's `bash -c` is running raises a
  question this design does not answer: can that step run a second time
  on resume? Today the same question exists for the whole line. The plan
  must find the answer before the runner is written.
- A checkpoint is a file a person can edit. The approved effects for
  each step are held in the plan, which is a local variable. Editing
  them can make the fresh plan disagree, which stops the line, or agree
  with a plan the handlers never saw. The second case is the exposure
  `safeBash` has today, where the text to run is also a local variable.

## Differences from bash that a person could notice

- **The time limit** covers the whole line. Each step runs with the time
  that is left.
- **One more failure.** The stop described above.
- **In-process steps** in more lines, as described above.
- **Cost.** One extra plan per step, which reads a few paths, and one
  `bash` start per step instead of one per line.

Output is not a difference. Each step's stdout is joined to the stdout
so far, and its stderr to the stderr so far, which is what one `bash -c`
gives.

One thing gets better: the check for a `gh` login failure can read the
exit status of the `gh` step. Today it only has the status of the whole
line.

## How it would be built

Three pull requests, each of which leaves main working.

1. **`planStep`, the `steps` execution kind, and the runner, with no
   checks.** Parity tests compare a line run step by step with the same
   line under one `bash -c`, for output, exit status, `$?`, `cd`,
   groups, and the joins. These tests cover steps that run through bash.
   A separate test pins the exit status that `$?` and the joins see
   after an in-process step. The runner prepares saved-output copies
   (`_prepareSpillFiles`) before the first step that reads one. The
   builtin test goes here. No prompt changes.
2. **The two checks and the stop.** The effect check, the folder check,
   and the stop message. Each check and each stop is logged with
   `_debug`, so stops can be counted from the logs. The attack lines
   from #1523's tests stop, and so does `git checkout evil && cd sub &&
   git status`. No prompt changes.
3. **Delete the prediction rule.** The five lines in the table become
   narrow, the pipeline rule and the job rule go in, and
   `noPathAfterACommandThatReplacesPaths` is rewritten to pin the stop.

Rough size: six to eight days. The first pull request is the largest.

## Where this is heading (owner, 2026-11-21)

safeBash should run an Agency function for every command it can. This
design is the first part of that: after it, a line is a list of steps,
and each step is either an Agency function or a real program.

- A step that is an Agency function needs no knowledge about the other
  commands in the line, because the stdlib checks the path when it opens
  it. Moving a command in process removes rules; it adds none.
- Some commands will always be real programs: `pnpm`, `make`, `node`,
  and any tool safeBash has never heard of, such as a person's own
  scripts. For those, safeBash keeps the analysis it has, and where a
  prediction is hard it asks the broad question instead. A person may
  answer more interrupts for such lines. That is accepted.
- There is one tool. No second "agencyBash" is built beside safeBash.

Commands move in process one at a time after this design ships, picked
from the logs.

## What this leaves for other tickets

- **ADI-261** (run a pipeline's stages in process) is unchanged. A
  pipeline is one step here. It is the first of the moves described
  above.

## Decisions (owner, 2026-11-20)

1. **The job rule.** A job line with more than one step asks
   `std::bash`, apart from a leading `cd`. The prediction rule is not
   kept alive for jobs.
2. **Stop.** The whole line stops at the first step that does not match.
3. **The lines that become narrow again.** The first four lines in the
   table ask their narrow questions up front and rely on the check.

## Decisions still open after the review

1. **The fifth line, `pnpm build && cat dist/out.txt`.** The first draft
   left it for another ticket while also deleting the check that keeps
   it broad. The review pointed out it has to be one or the other. This
   draft makes it narrow.
2. **The pipeline rule.** It makes `git log --oneline | head > out.txt`
   ask `std::bash`, where it is narrow today.
3. **`$_`.** A word that holds `$_` makes its command unrecognized.
