# Architecture review: safeBash runs a command in process wherever it sits

Reviewed on 2026-11-21: the plan
`docs/superpowers/plans/2026-11-21-safebash-in-process-everywhere.md`,
its spec, and the branch `adit/safebash-pipeline-in-process` (pull
request #1535, the first of three).

## Summary

- **Pull request 1 is sound and has the largest reach, and the review
  found one regression in it, now fixed on the branch.** A line that
  writes a file and then searches it stopped with a false "the plan
  changed".
- **Pull request 2 (pipelines) is worth building, with one change:** use
  the text search that already exists for saved output, and do not write
  a second one.
- **Pull request 3 (output to a file) should shrink to `2>/dev/null`
  only.** No logged or corpus line redirects one of these commands to a
  file.

## The regression found, and its fix

```
pnpm build > out.txt; grep -n error out.txt
```

When the line is planned, `out.txt` does not exist, so the `grep` is a
step bash runs, and its `std::grep` payload describes real grep
(`maxResults: 0`). Before a bash step runs, `checkedStep` plans it again.
By then `out.txt` exists, so the new plan took the `grep` for one
safeBash runs itself and asked with the stdlib search's payload
(`maxResults: 1000`). The two differed, and the line stopped:

```
Stopped before `grep -n 1 v.txt`: it was approved to search …/v.txt,
and it now asks to search …/v.txt.
```

A `cat` in the same position was not affected, because both paths ask
the same `std::read` payload. That is why the existing test
(`pnpm --version > v.txt && cat v.txt`) passed, and why CI was green.

**Fix (on the branch):** a step bash runs is planned again by the bash
rules only. `LineState.piped` became `LineState.byBash`, which is true
inside a pipeline and in `checkedStep`. `harmlessLinesDoNotStop` gained
the grep row.

**What this says about the design.** The table and the bash rules can
describe the same command with different payloads, and anything that
plans a command twice has to say which one it wants. `checkedStep` is
the one such place today, and it is now explicit.
A third caller of `classify` would need the same care. The comment on
`LineState` says so.

## Major features and public surface

- **`safeBash` is the agent's main shell tool**, so every change here is
  to a most-used feature. The questions a person sees change in three
  rows, all listed in the pull request. That is deliberate.
- **`planFor` is exported, and the shape of its result changed.** A lone
  `cat a.txt` used to give `execution.kind == "read"` and now gives
  `"steps"`, with the read inside the one step. I searched `lib/`, the
  agent, and the tests: only tests read it, and one agency-js test
  needed a change. A program outside this repository that reads
  `plan.execution.kind` would break. I think that is acceptable for a
  type that exists to be planned and run by `safeBash` itself, but it
  belongs in the changelog when the owner writes it.
- **`outcomeOf` and the `safeBash plan` debug event are unchanged**, so
  the measurement method (replaying logged plans) still works.
- **One behaviour a model will notice.** `pnpm build; cat one.txt`, with
  `one.txt` swapped for a link after approval, used to stop with a
  sentence that named what changed. It now fails with the read tool's
  error. Nothing is read from outside either way. The stop's message was
  more helpful to the model, and this case is rare.
- **An error message got worse in one case.** `rm one.txt; cat one.txt`
  prints Node's text (`ENOENT: no such file or directory, open '…'`)
  where real `cat` prints `cat: one.txt: No such file or directory`.
  This happens only when a file is removed between planning and
  running. Not worth code now.

## Effort and impact

I counted what each pull request reaches in the 89 distinct logged lines
and the 128 corpus lines. The count splits lines on `;`, `&&`, `||`, and
`|` as text and checks no flags, so each number is an upper bound.

| Pull request | Effort | Reaches in the logs | Reaches in the corpus |
| --- | --- | --- | --- |
| 1. Each step decides for itself | done, net 147 lines removed from `safeBash.agency` | 110 steps in 40 lines | 7 steps in 7 lines |
| 2. Pipelines | medium: one execution kind, the stage rules, parity tests | 12 of 50 pipelines | 10 of 26 pipelines |
| 3a. `>` and `>>` to a file | small to medium | 0 | 0 |
| 3b. `2>/dev/null` | small | 5 (4 of them in pipelines) | 1 |

The logged count for pull request 1 is inflated by `echo ---`
separators, but the direction is clear: almost every in-process command
in the logs sits in a longer line, which is the case pull request 1
handles and the old code did not. Only 2 logged steps were in process
before it.

None of the three saves a prompt. The payoff is the one the owner chose
on 2026-11-21: fewer commands whose behaviour safeBash has to predict.

**Recommendation on pull request 3.** Build `2>/dev/null` and drop `>`
and `>>`. Nobody writes `grep … > file` or `cat a > b` in these logs,
and a write whose bytes are not known when the line is planned needs
its own answer about what the `std::write` payload shows. The owner
said "easy stays even with no logged use, hard and unused waits", and
this is the second kind. The rule stays general without it: output to a
file is a place output can go that no table entry supports yet.

**Documentation and CI weight.** The dev doc section is about 50 lines
in a 2,300 line doc, which fits a rule every command passes through. The
five new tests add about five seconds to one file.

## The 80/20 question

Is there a cheaper way to the same goal? The goal is more commands run
by Agency functions. The steps bash still runs most often are:

- **Logs:** `ls` 23, `cd` 15, `git` 14, `timeout` 11, `sed` 10.
- **Corpus:** `git` 29, `ls` 14, `pnpm` 11.

So after pull request 1, adding `ls` to the table would move more steps
than pipelines do: 37 steps against 22 pipelines. The stdlib has an `ls`
tool. `timeout` in front of a table command is 11 logged steps and is a
one-line rule (drop the wrapper, since the stdlib tool cannot hang on a
file).

**Recommendation on order:** pipelines next, as planned, because the
runner piece is the hard part and everything later benefits from it.
Then `ls`, then `timeout` in front of a table command. `git` is the
largest group and has no stdlib equivalent that prints what `git`
prints, so it stays with bash.

## Reusing code

- **Pull request 2 must not add `_filterLines`.** `lib/stdlib/spill.ts`
  already searches a text with a grep query: `searchText` calls
  `compileGrepQuery` and `firstMatchingLines`, and `_grepSaved` is the
  in-process grep of a saved output built on it. A later `grep` stage is
  the same operation on the text of the stage before. Export one
  function beside `_grepSaved` that takes a text, and give it the same
  `GrepQuery` the first stage uses. The plan is changed to say this.
- **Three record shapes are close:** `InProcess` (`effects`, `exec`),
  `Classified` (`effects`, `line`, `command`, `steps`), and `Plan`.
  `InProcess` replaced a use of `Plan` that filled three fields with
  constants, so it is smaller than what it replaced. No change.
- **`loneExec` and `kindOf` in the test file** read a lone command's
  step. They exist so about 150 expected values did not move. They are
  test helpers and stay there.

## Concepts

- **One concept was removed:** "a chain". The docs, the code, and the
  comments no longer have a word for a line whose commands are all in
  process, apart from the outcome name `shellFree`.
- **One was added:** `byBash`, a flag on the line that says the bash
  rules decide. It is internal. It replaces two decisions that used to
  be made by which function was called.
- **Pull request 2 adds one execution kind (`pipe`).** It could instead
  be a list of steps with an input, but a pipeline is one step to the
  runner (one status, one place in the join order), so one kind that
  holds its stages is the smaller idea.

## Things tied together

- **The table and the bash rules now sit in one function**
  (`classifySimple`), with the table first. A change to what the table
  accepts changes every line that holds the command, where it used to
  change only lone commands and chains. That is the point of the rule,
  and it means a table change needs the corpus test run, which already
  happens.
- **Jobs follow from one question.** A job is a shell, so `startsShell`
  decides: a line that starts none runs in the foreground. After the
  owner's review a `cd` counts as starting none, so `cd sub && cat
  a.txt` is such a line.

## Changes made to the plan and the branch

1. Fixed the regression above (code, a test row, and the dev doc).
2. Pull request 2 reuses the saved-output text search and adds no second
   one.
3. Pull request 3 is narrowed to `2>/dev/null`, with `>` and `>>` moved
   to "Not in this plan". This is my recommendation and waits for the
   owner's yes, since the owner approved the three-part rule.
