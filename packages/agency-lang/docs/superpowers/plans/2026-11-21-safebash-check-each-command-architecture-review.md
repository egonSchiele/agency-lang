# Architecture review: safeBash checks each command (plan of 2026-11-21)

Reviewed: `2026-11-21-safebash-check-each-command.md` and its spec. This
is my own plan, reviewed against the architecture-review checklist.

## Summary

The plan closes the right problem, and its first two pull requests are
worth building. Five things should change before it is built:

1. The plan leaves two step types, two runners, and two execution kinds
   side by side. It should end with one of each.
2. One check in pull request 2 uses a helper that does not follow a
   link in the last step of a path, so the folder check would pass on
   the exact case it exists for.
3. Pull request 4 is optional, has a workaround built into it, and
   should come out of this plan.
4. Two test helpers are planned as stdlib exports. Every exported
   function is a tool and a documented API. Neither export is needed.
5. The plan's test technique, changing the disk from inside a handler,
   is not verified.

The effort is also larger than the measured benefit in prompts, which
the plan does not say. Section 2 has the numbers.

## 1. Major features and API

`safeBash` is the shell tool of `agency agent`, and by the logs it is the
most-called tool that agent has. Pull request 1 changes how every narrow
line runs. That is the largest risk in the plan, and the plan treats it
correctly: the parity test compares a stepped line with the same line
under one `bash -c`, and pull requests 1 and 2 change no question.

Public surface the plan touches:

- **`Plan.execution`** gains the kind `steps`. `planFor` and `Plan` are
  exported. I searched for other readers of the execution kind. The
  files outside `safeBash.agency` that mention these names are
  `stdlib/safeBash/actions.agency` and four files in `lib/` that list
  or load stdlib modules. I did not find a consumer that matches on the
  kind, but the builder should run the typecheck after Task 2 before
  trusting that.
- **A new failure**, the stop, with `{ type: "planChanged" }`. The model
  reads its text. The agent's tool trace reads the last line of a failed
  command to find the exit status (see the comment in `exitFailure`). A
  stop has no exit status. Task 5 should say what the trace shows for
  it, and test that, the way `timeoutFailure` is handled.
- **`startJob`** asks a broader question for some lines after pull
  request 3. That is an owner decision already made.

## 2. Effort and impact

| Part | Effort | Impact | Verdict |
|---|---|---|---|
| PR 1: step list and runner | 3 days, the largest | None alone. Everything else needs it. | Must do, if the approach stands |
| PR 2: the two checks and the stop | 1.5 days | High. Closes the whole class of "a command makes a later question false" with no list. | Must do |
| PR 3, Task 7: delete `DiskState` | 0.5 day | Less code, no list to maintain. | Do |
| PR 3, Task 8: pipeline rule | 0.5 day | Needed once the lists are gone. | Do |
| PR 3, Task 9: job rule | 1 day | Needed once the lists are gone. Makes one logged line worse. | Do |
| PR 1, Task 4: builtin test and `$_` | 1 hour | Low. `$_` has no logged use. | Keep the test, see below for `$_` |
| PR 4: in-process steps in a mixed line | 1.5 days | Low for this plan's goal. | Take out of this plan |

**The prompt benefit is close to zero in the logs.** The spec's second
argument is that the prediction rule costs prompts. I searched
`tests/agency/safeBash-corpus.json` (130 lines) for a `git checkout`,
`git switch`, or `git stash` followed by another command. There are two
lines. One, `git checkout main && pnpm test`, is narrow today. The other,
`git checkout main && cat package.json`, is the row #1523 added to show
the cost. So the plan regains a narrow question for about one line.

The honest case for the six to eight days is therefore:

- safety that does not depend on a hand-made list, and
- the step runner, which the direction set on 2026-11-21 needs: an
  Agency function cannot run in the middle of one `bash -c`.

The spec and the plan should say this plainly, and drop "it costs
prompts" as a reason.

**`$_`.** A rule for a variable with no logged use is small, but it is a
rule. It is in the plan only because splitting a line changes what `$_`
prints. That is a fair reason, and the rule is one line. Keep it, with
one test row and no doc beyond a sentence.

**Pull request 4.** It changes payloads, spreads the known differences of
the in-process `grep` to more lines, and carries a workaround: a step
runs through bash when the next step reads `$?`, because an in-process
failure reports status 1 where `grep` reports 2. The clean fix is for an
in-process step to report the real status. That belongs with ADI-261 and
the work to move commands in process, which should get its own short
design. Nothing in pull requests 1 to 3 depends on it.

**Docs and CI.** The doc work is proportionate: one new section, and
pull request 3 deletes a section. `safe-bash.md` is about 2,400 lines, so
pull request 3 should leave it shorter than it found it. The new test
file starts a few dozen shells and sleeps for about three seconds, which
is small beside the existing safeBash tests.

## 3. The 80/20 alternative

There is a cheaper way to get the safety, and the plan does not mention
it: **keep one `bash -c`, and have safeBash write a guard in front of
each command.**

```
git checkout evil; cat README.md
```

would run as

```
git checkout evil; [ "$(realpath README.md)" = /abs/repo/README.md ] || exit 97; cat README.md
```

safeBash already writes guards of this kind: `cd '/abs/x' || exit 1`, and
`git rev-parse --show-toplevel` in front of `git diff`.

| | Guards in the text | The step runner (the plan) |
|---|---|---|
| Effort | About 2 days | 6 to 8 days |
| Closes the checkout hole | Yes | Yes |
| Shell state, `$?`, `$_`, groups | Unchanged, one shell | Carried by the runner |
| Background jobs | Work as today, no job rule | Need the job rule |
| The check is the same code as the plan | No. Bash resolves the path, TypeScript resolved it up front, and the two must agree. | Yes |
| Lets a step be an Agency function | No | Yes |

The last two rows are why I still recommend the runner. A second
implementation of "what is the real path" in shell is where the next
false stop or the next hole would come from. And the guards are a dead
end for the direction decided on 2026-11-21. But the owner should see
that this choice exists, because it is a quarter of the work.

## 4. Reusing code and concepts

**One step type, one runner, one execution kind.** The codebase has
`ChainLink`, `ChainStep`, `StepExec`, `ChainExec`, `tryShellFreeChain`,
`linksOf`, and `runChain`. The plan adds `LineStep`, `RunStep`, `CdStep`,
`GroupStep`, `StepsExec`, `StepsState`, `runSteps`, `runStepList`, and
`runOneStep`. After the plan, a line runs in one of three ways (`chain`,
`steps`, `bash`), and two walks and two runners apply the same `;`,
`&&`, `||` rule. Task 10 even says the old chain stays "for the one case
where a write runs in process".

A chain is a stepped line in which every step runs in process. The plan
should say so in its types:

- A `RunStep` holds how it runs: `{ form: "bash" }` or `{ form:
  "inProcess"; execution: StepExec }`. `StepExec` is reused as it is.
- `planLine` builds one step list. When every step is in process, the
  runner starts no shell, which is today's chain.
- `runSteps` wraps an in-process write in `destructive { }`, as
  `runChain` does.
- `ChainLink`, `ChainStep`, `ChainExec`, the `chain` kind,
  `tryShellFreeChain`, `linksOf`, and `runChain` are deleted in pull
  request 1. `outcomeOf` reports `shellFree` when every step is in
  process, so no test value changes.

This is more work in pull request 1 and less code at the end. It also
means the all-in-process chains get groups for free, which `linksOf`
refuses today.

**No new exports for tests.** Task 1 adds `export def stepsFor`, and Task
4 suggests `export def builtinVerbs`. Every function is a tool, and an
exported stdlib function gets a page in the generated docs. Neither is
needed. `planFor(...).execution.steps` already gives a test the steps,
because `Plan` is exported. The names bash has as builtins do not change,
so the test can hold its own copy of the list.

**`sameEffects`.** The plan says to compare payloads as JSON text and to
"reuse what `planRecord` uses". The builder should look for an existing
deep-equality helper in the stdlib first, and say in the plan which one
it found.

## 5. Concepts tied together

- **The check and the plan share `classify`.** This is the right tie.
  The check is only meaningful when both sides run the same code.
- **Jobs are tied to the step list** through `jobShape`. A change to how
  steps are built can change what a job asks. That is acceptable, and
  the `jobs.agency` tests in Task 9 pin it.
- **The plan is a local variable, so it is in every checkpoint.** Each
  step now carries its source command as a parsed tree. A checkpoint
  taken at a safeBash question grows by that much. For a line of a few
  commands this is small. The plan should say so in the doc section,
  beside the note that a person can edit a checkpoint.

## 6. Defects in the plan

**The folder check uses the wrong helper.** Task 6 resolves the runner's
folder with `_realPathIn(".", state.cwd, ...)`. `_realPathIn` ends in
`files.realPath`, which does not follow a link in the last step of a
path. `files.realDir` does. This is the same mistake as the first
version of `isSymlink` in #1523. A folder that became a link is a link in
the last step, so the check would pass. The task must name a helper that
follows the last step, and it needs a test that fails without it. The
rows in Task 6 do not: both go through a `cd`, and the `cd` check catches
them first. Add this row:

| Line | Run from | What the handler does | Expected |
|---|---|---|---|
| `git status; git log --oneline -1` | `<fixture>/sub` | replaces `sub` with a link to another repository | stops before the second command |

**The test technique is not verified.** Tasks 3, 5, and 6 change the
disk inside a handler, by calling `remove(...)` or a shell command
there. `remove` raises `std::remove`, and a raise inside a handler body
may not behave like a raise anywhere else. The plan needs a first step
that proves the technique with a five-line test, and a fallback if it
fails: an agency-js test, where TypeScript changes the disk between the
interrupt and the response.

**Task 3 runs the classifier for nothing in pull request 1.** `runOneStep`
classifies each step again only to rebuild its text. That is fine as the
place Task 5 hooks into, but the plan should say the rebuilt text must
equal the text the up-front plan rebuilt for that step, and assert it in
a test. Otherwise pull request 1 can change what runs without any test
noticing.

## Recommended changes to the plan

1. Unify the types and the runner as in section 4, and delete the chain
   path in pull request 1.
2. Fix the folder check and add the test row in section 6.
3. Add a first step that verifies the handler technique.
4. Remove pull request 4. Open a ticket for "an in-process step reports
   the real exit status", linked to ADI-261.
5. Remove the two test exports.
6. Say what the tool trace shows for a stop, and test it.
7. Replace "it costs prompts" in the spec with the measured number, and
   add the guard alternative with the reason it was not chosen.
