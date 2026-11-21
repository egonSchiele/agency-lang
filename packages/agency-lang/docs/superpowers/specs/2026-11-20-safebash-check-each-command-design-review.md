# Review: safeBash checks each command just before it runs (ADI-358)

Reviewed: `2026-11-20-safebash-check-each-command-design.md`, against
`stdlib/safeBash.agency` and `lib/stdlib/shell.ts` on the branch
`adit/safebash-check-at-use` (commit c23247a7c, which sits on #1523).

## Summary

The idea is right, and it matches what the owner asked for on
2026-11-21: ask every question up front, check each command before it
runs, and never ask in the middle of a line. I checked the spec's main
example against the code. `_searchTargetIn` resolves a path through
`host.files.root`, which follows every symlink, the last one included
(`walkSpelling` in `lib/host/node/nodeFiles.ts`). So after `git checkout
evil`, planning `cat README.md` again does give `/outside/secret`, and
the check would catch the attack the way the spec says.

Four problems need fixing in the spec before a plan is written. The
first two would each leave a hole or make the check fire on harmless
lines:

1. "Plan the step again, alone" is not defined well enough. Taken
   literally, it gives different effects than the up-front plan for
   harmless steps, so `git switch main; grep -rn TODO src`, one of the
   four lines the spec promises to make narrow, would stop every time.
2. A `cd` is never checked again, and the effects of a `git` or
   `std::exec` step name their folder as a plain string. A folder that
   becomes a link after `git checkout` passes the check.
3. The pipeline rule that replaces the prediction rule needs the same
   hand-made list of effects that the spec says it deletes.
4. "What is deleted" removes a check whose removal is the change that
   "What this leaves for other tickets" says is separate.

Below are those four, then smaller points, then comments on the three
owner decisions.

## Must fix

### 1. Say exactly how a step is planned, and use one function for it

The spec says: "Before the step runs, it plans the step again, alone, in
the runner's current folder. The step runs when the two lists are
equal." Today there are three different ways a command gets its effects,
and they disagree.

- **Inside a line**, `classifyAll` calls `classify`, which calls
  `simpleCommandRule` with a `LineState`. This is what the up-front
  plan uses for a line of more than one command.
- **Alone**, `planFor` tries `tryShellFreeStep` first, then goes through
  `classifyAll`, and then `planLine` turns an empty list into
  `std::bash::readonly` or into a broad plan.
- **In process**, `tryShellFreeGrep` and `tryShellFreeRead` build their
  own payloads.

They give different effects for the same command:

| Step | Effects inside a line (up front) | Effects from `planFor` alone |
|---|---|---|
| `grep -rn TODO src` | `std::grep` with the raw pattern, `flags: ""`, `maxResults: 0` (`grepSearchRule`) | `std::grep` with the translated regex, `flags: "u"`, `maxResults: 1000` (`shellFreeGrepPlan`) |
| `pwd` | none | `std::bash::readonly` |
| `echo "exit=$?"` | none | `std::bash::readonly` |
| `echo $HOME` | none | broad `std::bash` (`everyWordKnown` is false) |

So if "plan again, alone" means calling `planFor` on the step's text,
`git switch main; grep -rn TODO src` stops at the `grep` every time,
and so does `pnpm test; echo "exit=$?"`.

The spec also says a step that translates to a stdlib tool runs in
process. A `grep` that runs in process needs the in-process payload,
with the regex the search really uses. That is a different question
from the one the up-front plan asked. Two more cases point the same way:

- Up front, a path the line has not made yet is planned with
  `LineState` (`mkdir -p out && grep -rn x out`). The in-process planners
  use `strictLine` and cannot plan a missing path. So the up-front plan
  takes the bash form, while at run time the in-process form now
  succeeds, and the two give different payloads.
- The plan rewrites some commands before running them. `git diff`
  becomes `(git rev-parse --show-toplevel >/dev/null && git diff ...)`
  (`insideRepository`), `cd x` becomes `cd '/abs/x' || exit 1`, and gh
  commands gain `GH_HOST`. So one step of the model's text can be more
  than one command in the text that runs.

**Suggested fix.** Add one function that plans one step. Call it
`planStep(command, line)`. It returns the step's effects, how the step
runs (in process, or the text to give `bash -c`), and the `LineState`
after the step. The up-front plan calls it for each step in order, with
the `LineState` it has built so far. Before each step runs, the runner
calls it again on the same source command, with a fresh `LineState`
whose `cwd` is the runner's folder. The spec should then say:

- Up front, `planStep` decides how each step will run, and the questions
  are asked for that form. A `grep` that will run in process asks the
  in-process payload.
- The check compares the effects of the two calls. It also requires the
  same kind of run: a step planned up front to run in process must still
  be planned to run in process.
- The runner runs what the fresh call returned, so the rewritten text
  always comes from the disk as it is now.
- A step with no effects (`pwd`, `echo`) has an empty list both times,
  and the two lists match. `std::bash::readonly` stays a whole-line
  question that `planLine` asks.

This needs a per-step record in the plan. Today `Plan.effects` is one
flat list, and `execution` is one `bash` string. The spec should name
the new execution kind and what each step in it holds: the source
command, how it runs, and its approved effects.

### 2. Check the folder each step starts in, and check every `cd`

The spec says a `cd` "spawns no shell", and that the runner "keeps the
folder and starts each later command in it". It never says the `cd` is
checked again. "What is deleted" removes the `disk` check from
`cdTarget`.

Here is the problem. `execEffects` puts `cwd: cwd` into the
`std::exec` payload, and that `cwd` is the string the runner passes in.
Nothing resolves it again. The git rules put their folder into their
payloads the same way. Take this line:

```
git checkout evil && cd sub && git status
```

1. Up front, `sub` is a real folder. The `cd` resolves to `<cwd>/sub`,
   and the question is `std::git::status` in `<cwd>/sub`.
2. `git checkout evil` runs. On that branch, `sub` is a link to
   `/home/me/other-repo`.
3. The runner moves to `<cwd>/sub`. Nothing checks it.
4. The runner plans `git status` again in `<cwd>/sub`. The payload names
   `<cwd>/sub`, the same as before, so the check passes.
5. `git status` starts in `<cwd>/sub`. The kernel follows the link, and
   git prints the status of `/home/me/other-repo`.

This is the same kind of hole as the `git -C dir status` case that
#1523 handled in `namesPath`. The same thing happens without any `cd`
when a step replaces a folder that a later step starts in, and when the
folder safeBash was called with is inside the repository.

**Suggested fix.** Add one rule to the runner: before each step, resolve
the runner's folder again with `realDir`, and stop the line if the
result differs from the folder the up-front plan used. A `cd` is then a
step like any other. The runner resolves its target again before moving,
and stops if the target changed. A `cd` that fails also stops the line,
which is what `cd '/abs' || exit 1` does today. Add the line above to
the tests for PR 2.

### 3. The pipeline rule needs a list. Use one that does not.

"What is deleted" removes `SEE_THROUGH_EFFECTS`, `NAMED_CHANGE_EFFECTS`,
and `CHANGING_EFFECTS`. The rule that replaces them is: "a pipeline in
which one stage can replace a path and another stage names a path asks
`std::bash`". To know which stage "can replace a path", the code needs
those same lists. So they cannot be deleted, and inside a pipeline an
effect placed on the wrong list is still a hole. That is the first cost
the spec gives for the prediction rule.

There is a second thing that depends on `DiskState`. `classifyPipeline`
sets the disk to "changed" for every stage, so a stage may name a
missing path only when the line wrote it before the pipeline began
(`pnpm test | cat nope.txt`). The spec does not say what replaces this.

I checked the pipelines in `tests/agency/safeBash-corpus.json`. Each of
the 26 lines that has a pipe has at most one stage with an effect other
than `std::exec`. The other stages read the pipe (`grep version`,
`head`, `wc -l`, `tail -30`). The closest to an exception is
`pnpm test 2>&1 | tee out.log | tail -30`, which has a `std::exec` and a
`std::write`.

**Suggested rule.** In a pipeline, at most one stage may raise an effect
other than `std::exec`. Otherwise the line asks `std::bash`.
`std::exec` is the one effect whose approval already lets the program
read and change any file. That is the same reason `CHANGING_EFFECTS`
gives for it today. This rule names one effect and lists nothing else.
Any new effect is treated as unsafe until someone thinks about it, so a
mistake asks a broad question and never opens a hole. It handles the
cases the spec cares about:

| Pipeline | Effects other than exec, by stage | Result |
|---|---|---|
| `git checkout x \| cat README.md` | checkout, read | `std::bash` |
| `git checkout main \| tee log.txt` | checkout, write | `std::bash` |
| `git checkout x \| cat new.txt` (missing now) | checkout, read | `std::bash` |
| `cat package.json \| grep version` | read, none | narrow |
| `pnpm test 2>&1 \| tee out.log \| tail -30` | none, write, none | narrow |

The missing-path case is covered by the third row. A stage may name a
missing path only when no other stage raises anything except
`std::exec`.

### 4. The deleted `missingPath` check is the change the spec defers

"What is deleted" removes "the `disk` checks in `missingPath` and
`cdTarget`". Here is the check in `missingPath`:

```
if (line.disk != "known") {
  return null
}
return { dir: where.dir, filename: where.filename, content: "", mode: "overwrite" }
```

Without it, `pnpm build && cat dist/out.txt` (with `dist` present and
`out.txt` missing) gets a narrow `std::read` for `<cwd>/dist/out.txt`.
"What this leaves for other tickets" calls that "a separate change".

Pick one. Under this design the change is safe. If `pnpm build` makes
`out.txt` a link to a key, the fresh plan resolves the link and the line
stops. I recommend keeping the deletion. Then add the line to the table
of lines that get their narrow questions back, add a test, and remove
the bullet from "other tickets". To defer it instead, the spec has to
keep some flag that says "the line has run a program", and then
`DiskState` is not fully deleted.

## Should fix

### 5. Reuse the gh repository lookup when a step is planned again

`approvedPlan` calls `resolvedPlan`, which looks up the repository for a
`gh` command with `_ghResolveRepo`. That is a call to GitHub. If the
fresh plan of a `gh` step passes no `origin`, its effects still have a
lookup pending and will not equal the approved ones. Otherwise every gh
step makes a second call to GitHub. The spec should say that the check
passes in the `origin` the up-front plan looked up. `git checkout` does
not change the remotes in `.git/config`, so the old answer is still
true.

### 6. Running in process does not match `bash -c`. Say which one PR 1 tests.

PR 1 says a narrow line "must print what the whole line prints under one
`bash -c`". Steps that run in process cannot meet that:

- The in-process grep skips what `.gitignore` ignores, and stops at 1000
  matches (`SHELL_FREE_GREP_CAP`). Real `grep -r` does neither
  (`docs/dev/stdlib/safe-bash.md`, the `.gitignore` paragraph).
- `runChain` treats every failed in-process step as exit status 1. Real
  grep exits 1 when nothing matched and 2 on an error. Once the runner
  supports `$?`, `grep x missing.txt; echo "exit=$?"` prints `exit=1`
  where bash prints `exit=2`. The same status decides `&&` and `||`.

Today these differences show up only for a lone command or a chain made
entirely of in-process steps. Under this design they show up in any
narrow line that has such a step. For example, the `grep` in
`git switch main; grep -rn TODO src` would start skipping ignored files.
I think that is acceptable, because a lone `grep -rn` already behaves
this way. The spec should say so. PR 1's parity tests should cover only
steps that run through bash, and there should be a separate test of the
exit status that `$?` and the joins see after each in-process step.

### 7. Correct "Why splitting a line is safe", and record the builtin check

Two claims in that section need correcting.

**"A variable in a recognized position makes the command unrecognized."**
That is not true for `echo`. `verbEffects` maps `"echo"` to
`success(redirects)` whatever its words are, so `git status && echo
$HOME` is narrow today (ADI-356 is about this). The variables `echo`
can read are environment variables, which are the same in every
`bash -c`, and bash's special parameters. Two of the special parameters
depend on the command before:

- `$?`, which the runner carries. The spec covers it.
- `$_`, the last argument of the previous command. `ls src; echo $_`
  prints `src` under one `bash -c`. Split, it prints something else.

`$LINENO`, `$SECONDS`, `$$`, and `$RANDOM` also change, but no line
could depend on them. The spec should say whether `$_` makes `echo`
unrecognized, which is a one-line check in the classifier, or whether
the difference is accepted.

**"I have not checked every name in `BUILTIN_VERBS` against the rules."**
I checked. These are the builtins that have a narrow rule today:

- `cd`, which `cdTarget` handles.
- `echo`, which `verbEffects` handles.
- In `QUIET_VERBS`: `pwd`, `true`, `false`, `:`, `printf`, `type`, and
  `command` (only with `-v`).

None of them changes the shell except `cd`. `printf -v` is refused by
`printfWordsFit`. Every other builtin fails in `execEffects`. A line
made only of assignments fails in `simpleCommandRule`. The `&`
operator, `!`, and redirects on a group are not in the `Command` type,
so a line that uses them cannot be parsed and asks `std::bash`. The
spec can state all this as a fact. The test it proposes is still worth
adding.

### 8. Say what the runner is written in, and what a pause does to it

The checkpoints section says a run paused in the middle of a line
"resumes after the last step that finished, as `runChain` does today".
That is true only if the runner is Agency code, as `runChain` is, with
its folder, last exit status, and output so far kept in local
variables, so that a checkpoint saves them. If the runner is TypeScript,
a pause cannot happen between steps at all. The spec should pick one.

If the runner is Agency code, the check helps in one more case. A line
paused between steps and resumed an hour later plans the next step
again before it runs, so changes to the disk during the pause are
caught too. The spec can say so.

It should also say what happens when a pause arrives while a step's
`bash -c` is running. Can that step run a second time on resume? Today
the answer is the same for the whole line, so this is not new. The plan
needs the answer before it writes the runner.

### 9. A stop after an in-process write takes safeBash away from the model

`runChain` runs an in-process write inside `destructive { }`, so that a
later failure stops the tool loop from retrying the chain. A failure
with `destructiveRan` removes the tool from the conversation
(`docs/dev/language/destructive-regions.md`). Under this design, more
lines have in-process writes in them. In
`echo notes > a.txt && git checkout evil && cat README.md`, the stop
comes after a write that ran in process. The failure then carries
`destructiveRan: true`, and the model loses safeBash for the rest of the
turn. The stop message tells the model to run the rest as a new
command, which it then cannot do. The spec should say which of these it
wants:

- Run a write step through bash when it is part of a longer line.
- Leave a stop outside the destructive region.
- Accept losing the tool.

Bash steps are never marked destructive (the owner decided this in
`safe-bash.md`, "Why a bash call is never destructive"), so this affects
in-process writes only.

### 10. Drop the "output order" difference, or say what changes

"Each step's stdout and stderr are collected and joined in step order."
`runBash` keeps stdout and stderr apart. A success returns stdout. A
failure carries both. If the runner joins each stream across the steps,
the result is exactly what one `bash -c` gives, and there is no
difference to list. If "joined" means stdout and stderr are mixed into
one text, the output format changes. Say which one. I recommend keeping
the two streams apart, and then the bullet can go.

A related small gain: `isGhLoginFailure` warns that "the exit code
belongs to the whole line". Once each step has its own status, the
check can use the status of the gh step.

## Comments on the owner decisions

1. **The job rule.** The spec says this is the one decision that makes
   a prompt worse, but it does not say how often it happens. The
   measurement method from the fewer-prompts arc replays logged lines
   through `planFor`. Run it on logged `startJob` calls before asking,
   and put the count in this section. If almost no logged job line has
   more than one step, the decision is easy.
2. **Stop, or run the rest of the line?** I recommend removing this
   question. Skipping a step breaks what `&&` means. In
   `cd build && rm -rf out`, skipping a failed `cd` would run `rm` in
   the wrong folder. The spec already says skipping is "harder to
   reason about".
3. **The four lines.** Fine as written. After fix 1, check whether
   `git switch main; grep -rn TODO src` asks the in-process grep
   payload. If it does, policy rules saved for a lone `grep -rn` match
   it. After fix 4, add `pnpm build && cat dist/out.txt`.

## Smaller points

- **"What this does not close."** "Only a process that is already
  running beside the line can use it." A program an earlier step ran
  can also leave a child process running. Only a `std::exec` step can
  do that, and its approval already lets it read the file, so the
  conclusion holds. Say it that way, so the reasoning is complete.
- **Saved-output copies.** `runBash` calls `_prepareSpillFiles` right
  before the shell starts. The runner has to do this before the first
  step that reads a saved output. Name it in PR 1.
- **Logging.** Log each check and each stop with `_debug`, the way
  `approvedPlan` logs the plan, so that stops can be counted from the
  logs after this ships.
- **Size.** Five to seven days is plausible. Fix 1 (the per-step record
  and `planStep`) and fix 2 (checking the folder) both fall inside PR 1
  and PR 2, and they make PR 1 bigger than "the runner, with no checks".
