# safeBash: one rule for what runs in process (ADI-261, ADI-360)

Status: draft, waiting for the owner's yes. Nothing is built.

The first draft of this spec proposed a rule for pipelines only: a first
stage from one list, later stages from a second list. The owner turned
that down on 2026-11-21, because safeBash collects special cases quickly
and each one makes the next harder. This draft replaces it with one
general rule.

## The problem

safeBash can run five commands itself, with no shell: `echo`, `grep`,
`cat`, `head`, and `tail`. Whether it does depends on where the command
sits in the line, and each position has its own code:

| Line | Runs | Why |
| --- | --- | --- |
| `cat a.txt` | in process | the lone-command planner (`tryShellFreeStep`) |
| `echo ---; cat a.txt` | in process | the chain planner (`tryShellFreeChain`) |
| `pnpm build; cat a.txt` | bash | a line is in process only when every step is |
| `cat a.txt \| head -3` | bash | no planner takes a pipeline |
| `echo hi > out.txt` | in process | a "write", which exists only for `echo` |
| `grep -rn x lib > out.txt` | bash | a redirect is refused for every other command |

So the same `cat a.txt` is planned by two functions (`tryShellFreeStep`
and `classify`), and which one wins depends on its neighbours.

The same command can also ask a different question in each position. I
ran both through `planFor`:

```
grep -rn planFor stdlib           std::grep { flags: "u", maxResults: 1000 }
true && grep -rn planFor stdlib   std::grep { flags: "",  maxResults: 0 }
```

Both payloads are true. The first describes the stdlib search, which
stops at 1000 matches. The second describes real grep. But it is one
more place where position decides.

## The rule

A command is a function. It takes its arguments and some input text, and
it returns output text and an exit status. Three things about it are
separate.

1. **The command.** One table lists the commands safeBash runs itself.
   An entry says which arguments it accepts and how to run them. A
   command whose arguments the entry does not accept runs through bash,
   as it does today.
2. **Where its input comes from.** A file it names, or the stage before
   it in a pipeline. `head -3 a.txt` and `... | head -3` are the same
   entry with a different input.
3. **Where its output goes.** To the model, to the next stage, or to a
   file.

Two rules say where a command may sit. Neither names a command.

- **A pipeline runs in process when every stage is in the table.**
  Otherwise the whole pipeline runs through bash. The reason is that
  bash runs the stages at the same time: in `git log | head -5`, bash
  stops `git` once `head` has five lines. Handing over finished text
  cannot do that, so `yes | head` would never end.
- **Each step of a line decides for itself.** The step runner
  (`runSteps`) already takes a line one step at a time and carries the
  folder and the exit status between steps. A step is one simple
  command, one pipeline, or one group.

The table above then reads:

| Line | Today | After |
| --- | --- | --- |
| `cat a.txt` | in process | in process |
| `echo ---; cat a.txt` | in process | in process |
| `pnpm build; cat a.txt` | bash | `pnpm build` in bash, `cat` in process |
| `cat a.txt \| head -3` | bash | in process |
| `grep -rn x lib \| grep -v test \| head` | bash | in process |
| `git log --oneline \| head -5` | bash | bash, because `git` is not in the table |
| `echo hi > out.txt` | in process | in process |
| `grep -rn x lib > out.txt` | bash | in process |

After this, adding a command is one entry in the table. It then works
alone, in a pipeline, with a redirect, and in a mixed line, with no
further rule.

## What the logs say this reaches

I collected every shell line the agent ran from the five logs
(`~/.agency-agent/perry-log.jsonl`, `~/perry/log.jsonl`, and the
checkout's three `log*.jsonl`), and the corpus in
`tests/agency/safeBash-corpus.json`: 89 distinct logged lines and 128
corpus lines, holding 76 pipelines.

- **After a pipe:** `head` 50 times, `grep` 24, `tail` 6. Every other
  command together appears 13 times. All three are in the table already,
  so pipelines need no new entry.
- **Before a pipe:** `grep` 18 times, `find` and `ls` 18, `git` 14,
  `cat` and `head` 9. So `ls` and `find` are the entries to add next.
- **Position:** only 9 of the 29 distinct logged lines with a pipe are a
  lone pipeline. The rest sit in longer lines, usually searches joined
  by `; echo ---;`, which is why "each step decides for itself" matters
  as much as pipelines do.

This work saves no prompt. Each line it touches is narrow today.

## How the code changes

The useful parts exist. The readers `readGrep` and `readFileVerb` already
return either the files a command names or `{ kind: "stdin" }`, and both
planners already call them.

- **One classifier.** `classify` gives each simple command its effects,
  as now, and also its in-process execution when the table accepts it.
  `runStepOf` stores that in `RunStep.inProcess`, which exists and is
  null for every step of a narrow line today.
- **Three functions go away:** the lone-command call at the top of
  `planLine`, `tryShellFreeChain`, and its tree walk (`linksOf`,
  `joinedLinks`, `ChainLink`, `stepExecOf`).
- **Input.** A table entry whose reader returns `stdin` is accepted when
  the command is a later stage of a pipeline, and takes the text of the
  stage before. `head` and `tail` print through `_renderReadView`, as
  now. `grep` on text needs one new function beside
  `_grepPatternToRegex`, which filters lines by the same regular
  expression the stdlib search uses.
- **Output.** A `>` or `>>` on an in-process step writes its text
  through the write tool's own write (`_write`).
- **The outcome name `shellFree`** stays, and means what it means today:
  every step of the line ran in process (`allInProcess`).

The runner needs no change for a mixed line. `runOneStep` already runs
an in-process step with no check before it, because the stdlib tool
checks its path when it opens it, and a bash step with the check.

## What a person is asked

Every question is still raised up front in `approvedPlan`, before
anything runs. The runner raises nothing. Three payloads change:

1. **A grep that moves in process** asks with `flags: "u"` and
   `maxResults: 1000` where it asked `flags: ""` and `maxResults: 0`.
   That is the payload the lone grep has today, and it is true of what
   runs. A saved rule that matches on `pattern`, `dir`, or `file` is not
   affected.
2. **A redirect on an in-process step** asks `std::write` with the
   content empty, as the bash path does today, because the text is not
   known until the step runs. An `echo` keeps its content in the
   payload, in a mixed line too: `true; echo hi > out.txt` asks with
   `content: ""` today and would ask with `content: "hi\n"`.
3. **`grep -rn x node_modules | head`** asks `std::bash` today, while
   the same grep alone runs in process. Under this rule it asks
   `std::grep`. The bash path refuses it for a reason that does not
   apply in process: the grep it writes excludes every folder name the
   grep tool skips (`--exclude-dir=node_modules`), so a search of a
   folder with that name would find nothing, while the tool does search
   a folder it is given (`grepSearchRule`).

4. **A group of commands safeBash runs itself asks nothing.**
   `echo a && (echo b || echo c)` asks `std::bash::readonly` today,
   because the chain planner refuses parentheses and the line goes to
   bash. Under the rule no shell starts, so there is nothing to ask.
   (Found while building the first pull request.)

5. **A line of a `cd` and commands safeBash runs itself asks only their
   questions.** `cd lib` alone and `cd sub && echo hi` ask
   `std::bash::readonly` today. The runner moves folder with no shell,
   so they ask nothing, and `cd sub && cat a.txt` asks only `std::read`.
   (From the owner's review of the first pull request.)

No effect is added to or removed from any other line.

## Where the output can differ from bash

- **A search stops at 1000 matches.** The stdlib grep stops there and
  says so in a note. A lone `grep -rn x .` works this way today.
  Followed by `| head`, or placed after `pnpm build;`, the same search
  runs real grep today, which has no limit. Both paths skip the same
  folders: the grep the bash path writes excludes every name the tool
  skips. A note is printed after the last stage, so `| head` does not
  cut it off.
- **A swapped folder is refused, not checked for.** A bash step earlier
  in the line can replace a folder with a link. A bash step after it is
  planned again and the line stops. An in-process step is not planned
  again: its stdlib tool opens the approved folder with `fixedRoot`,
  which refuses a link anywhere in the path
  (`docs/dev/stdlib/contained-files.md`), so the step fails with the
  tool's message.
- **A stage that fails.** In bash, a failing first stage prints its
  error and the later stages still run on empty input. A file that is
  missing when the line is planned is not accepted by the table, so that
  line runs through bash and nothing changes. A read that fails later,
  because the file was removed after approval, fails the step with the
  read tool's message.
- **Exit status.** A pipeline's status is its last stage's, as in bash:
  0 after `head` or `tail`, and 1 after a `grep` that matched no line.

## Three pull requests

1. **One classifier, and each step decides for itself.** Deletes the two
   extra planners. No pipelines and no new redirects yet. This is
   ADI-360. Payload change 1 above lands here, and so does the `echo`
   half of change 2.
2. **Input from the stage before.** Pipelines whose stages are all in
   the table. This is ADI-261. Payload change 3 lands here.
3. **Output to a file** for every entry in the table.

Each pull request is tested the way `shellFreeReadMatchesRealTools`
tests reads today: a row runs the line in process and under real bash
and compares the text and the exit status. Each also checks that a
rejected question runs nothing, and that no shell starts for an
in-process step.

## Not in this design

- **New table entries.** `ls` and `find` come next, each as its own
  small change with its own comparison against the real program.
- **`sort`, `uniq`, `cut`, `nl`, `tac`, `rev`, `tr`, `wc`,** which the
  ADI-261 ticket lists. They appear 4 times in 76 pipelines.
- **The `agency` outcome,** which is also decided for a lone command
  only (`tryAgencyPlan`). It runs a different kind of thing and is left
  as it is.
- **`2>/dev/null` on an in-process step.** 4 of the logged pipelines
  this could reach are written `grep -rn x lib 2>/dev/null | head`. It
  fits the rule as a fourth place output can go (nowhere), and I would
  add it with the third pull request if the owner agrees.
