# Review: safeBash checks each command just before it runs (plan of 2026-11-21)

Reviewed: `2026-11-21-safebash-check-each-command.md`, checked against
the code on this branch (`stdlib/safeBash.agency`,
`stdlib/safeBash/actions.agency`, `lib/stdlib/shell.ts`,
`lib/host/node/nodeFiles.ts`) and against the spec
`docs/superpowers/specs/2026-11-20-safebash-check-each-command-design.md`.

## Summary

The plan's shape is right. One step type, one runner, and one execution
kind is simpler than today's two paths, and the order of the pull
requests lets each one be checked on its own. The background section is
accurate. I checked these claims against the code, and they hold:

- `classify` is already "plan one command in this line".
- `runChain` and `skipsStep` give the runner its shape.
- The parser is left-associative, so a flat list with one join per step
  runs in bash's order (see the comment in `linksOf`).
- `files.realDir` follows a link in the last step of a path and
  `files.realPath` does not (`root` and `wholePath` in
  `lib/host/node/nodeFiles.ts`).
- `std::date` exports `now()`, so the runner has a clock.

The plan should change in eleven places before it is built. Item 1
makes every line stop in common setups. Items 2 to 6 would let a wrong
change pass its tests, or would leave the implementer facing an
instruction that contradicts the code. Items 7 to 11 are smaller.

## 1. The folder check compares a real path with a path that may not be real

Task 6 stops a step when `_realFolder(state.cwd)` differs from
`step.cwd`. `step.cwd` is `line.cwd` from the plan. For every step
before the first `cd`, that is the starting folder, and the starting
folder is whatever `resolveCwd` returned. `resolveCwd` returns the
caller's string unchanged, or `"."` when no folder is set
(`stdlib/safeBash.agency:5927`). It never resolves links.

So these lines stop before their first step:

- `safeBash("pnpm --version; ls")` with no `cwd` in a test, where
  `resolveCwd` returns `"."`. `_realFolder(".")` is an absolute path,
  and `"."` is not.
- Any call whose folder is spelled through a link. On macOS `/tmp` and
  `/var` are links, so a fixture under `/var/folders/...` stops every
  line.
- A relative `cwd` such as `"tests/fixtures"`.

A folder reached through a `cd` is fine, because `cdTarget` returns a
real path.

**Fix:** record the real folder at plan time and compare real with real.
Give `RunStep` a `realCwd` field, filled with `_realFolder(line.cwd)`
when the step is planned, and compare `_realFolder(state.cwd)` with it.
Leave the payload `cwd` alone, because changing it would change
questions, and pull requests 1 and 2 must change none. Add two rows to
Task 6's table: a line run with `cwd: "."` and a line run from a folder
spelled through a link. Both are expected to succeed.

## 2. Pull request 1 runs a command nobody compared with what was approved

Task 3 has `runOneStep` classify each step again, rebuild it, and run
the new text. Pull request 1 runs that text without comparing anything.
Task 5, in pull request 2, adds the comparison. If pull request 1 merges
first, main runs re-planned commands that were never checked against
the questions that were answered.

The re-planned text can differ from the approved text. `git checkout
foo` decides whether `foo` is a branch or a file by looking at the disk
(`refsAndPathsByDisk` and `onDisk`, `stdlib/safeBash.agency:3198`). If
an earlier step makes a file named `foo`, the second plan rebuilds
`foo` as a file to restore, under a question that named a branch.
Pull request 1 also does not say what the runner does when the second
`classify` fails.

**Fix:** give `RunStep` a `text` field, filled from the plan-time
rebuild of the step's classified command. Pull request 1 runs `text`.
Pull request 2 classifies again, compares, and only then runs the new
text. With this order, pull request 1 changes how a line is split and
never what runs. This also makes item 3 easy.

## 3. `stepTextsMatchTheLine` cannot be written as described

Task 3 asks for a node that joins the step texts with their joins and
compares the result with `execution.command`. That never matches:

- A `cd` step runs inside the runner and has no text. The rebuilt line
  has `cd '/abs' || exit 1` for a top-level `cd`, and
  `(cd '/abs' && ls)` for a group.
- A step that reads `$?` has the `(exit N);` prefix.
- The plan says to rebuild each step's text by calling "`planFor` on the
  step's own text". A step holds a command tree, and nothing turns it
  back into its text without a rebuild.

**Fix:** with item 2's `text` field, test what matters. For each line,
check that every `RunStep`'s `text` equals the matching part of the
line that one `bash -c` would have run. One way is a node that rebuilds
the line from the steps, writing each `CdStep` the way `cdOrExit` and
`cdTo` do. A cheaper way is to drop this node and rely on the parity
test, once item 4 makes that test reach the runner.

## 4. Most of the parity test's lines never reach the runner

`planLine` plans a line whose commands raise no effect as a
`std::bash::readonly` plan of kind `bash`
(`stdlib/safeBash.agency:5304`), and Task 2 keeps that branch. `printf`,
`true`, and `false` raise nothing. `ls nope` is broad, because `ls` has
a rule only for a path that exists. Of the ten lines in
`stepsMatchOneBash`:

| Line | Plan kind |
|---|---|
| `printf 'a\n' && printf 'b\n'` | `bash` (readonly) |
| `false; printf 'after\n'` | `bash` (readonly) |
| `false && printf 'skipped\n'; printf 'ran\n'` | `bash` (readonly) |
| `false \|\| printf 'rescued\n'` | `bash` (readonly) |
| `true \|\| printf 'skipped\n'` | `bash` (readonly) |
| `ls nope; printf 'exit=%s\n' "$?"` | `bash` (broad) |
| `cd sub && ls` | `steps` |
| `(cd sub && ls); ls` | `steps` |
| `ls \| head -1 && printf 'done\n'` | `steps` |
| `printf 'x\n' >&2; false` | `bash` (readonly) |

Seven lines run under one `bash -c` both ways, so they pass whatever the
runner does. Review Focus items 1 and 2 (`$?` and a failure in the
middle of a `;` list) are not tested at all.

**Fix:** put a command that raises an effect into every line, such as
`ls sub` in front: `ls sub; false; printf 'after\n'`. Use `false` for a
failing status in place of `ls nope`. Have the node check first that
each line plans as `steps`, and return that line as a failure when it
does not. The test then fails if a later change sends a line back to
one `bash -c`.

A second problem: `bash()` returns an `ExecResult`, and `safeBash`
returns a `Result` whose failure text ends in `Command exited with code
N`. The plan reduces both to `{ ok, text }` without saying how, and the
two texts differ for every failing line. Step 2 already runs the test
while the arm still calls `runBash`. Record those values as the
expected values at that point, and drop the comparison with `bash()`.
The runner must then reproduce them exactly.

## 5. A limit of zero means no limit

`buildSpawnOptions` sets a time limit only when the limit is above zero
(`lib/stdlib/shell.ts:33`). The runner passes `state.leftMs`, which
reaches zero or below after the earlier steps use up the time. The next
step then runs with no limit.

`stepsShareOneTimeLimit` (`sleep 1; sleep 1; sleep 1` with a 2 second
limit) catches this only when the second step happens to finish under
2 seconds and leaves a few milliseconds.

**Fix:** in `runStepList`, before starting a step, treat
`state.leftMs <= 0` as a timeout and run nothing. Say this in Task 3,
Step 3.

## 6. Task 2 says no expected value changes, but 58 do

Task 2, Step 4 says that only the new node may differ. The Global
Constraints say every expected value that pins effects stays the same.
`tests/agency/safeBash.test.json` pins the execution kind in many rows
(`planSummary`, `planKind`, and others): 51 rows hold `"bash"` and 7
hold `"chain"`. After Task 2, every narrow line's kind is `steps`, and
so is every chain's. The implementer will meet a contradiction on the
first run.

**Fix:** say in Task 2 that rows pinning `execution.kind` change. Every
such change must be either `bash` to `steps` for a line whose outcome
is `narrow`, or `chain` to `steps` for a line whose outcome is
`shellFree`. Any other change is a bug. The effect lists and outcomes
must not change.

## 7. No test pins the harmless lines the spec says will not stop

The check plans each step with `freshLine(state.cwd)`, which knows
nothing about what earlier steps wrote or made. The up-front plan used
`written` and `made`. The spec says these give the same payloads
("What is deleted"). No test in Task 5 or Task 6 checks that claim, and
these are common lines. Add these rows, each expected to succeed:

- `mkdir -p out && ls out`
- `mkdir -p build && cd build && pnpm --version`
- `pnpm --version > v.txt && cat v.txt`
- `pnpm --version > v.txt; pnpm --version >> v.txt`. A write payload
  may say whether the file existed, and here it did not exist up front
  and does exist when the second step runs.

Review Focus item 3 says a pending `gh` lookup is pinned in Task 5.
Task 5 has no `gh` row. Add one, with a git fixture that has an origin
remote. `_ghResolveRepo` runs `git remote get-url` and needs no
network.

## 8. Two more shell variables change when the line is split

`echo` accepts any word (`"echo" => success(redirects)` at
`stdlib/safeBash.agency:606`), so a narrow line can print a shell
variable. The spec's table lists three pieces of shared state. Bash
sets at least two more that the split changes visibly:

- `pnpm --version && cd sub && echo $OLDPWD`. Under one `bash -c` it
  prints the starting folder. Split, the step's bash gets whatever
  `OLDPWD` the agent process had.
- `false | true; echo $PIPESTATUS`. Under one `bash -c` it prints `1`.
  Split, it prints `0`.

`$$`, `$RANDOM`, and `$SECONDS` also differ, but nobody relies on their
values.

**Fix:** Task 4, Step 2 adds a refusal for `$_`. Make it a short list:
`_`, `OLDPWD`, `PIPESTATUS`, `BASH_COMMAND`, `LINENO`, and `!`. Add a
row for `$OLDPWD` and one for `$PIPESTATUS`.

## 9. The builtin test in Task 4 cannot fail when it should

The node plans `<verb> x` for every builtin and returns the names whose
outcome is `narrow`. It has three problems:

- It tries one argument shape. `command -v x` has a rule and
  `command x` does not. A new rule for `export FOO=1` or `set -e` would
  not show up in `export x` or `set x`.
- `cd x` is narrow or broad depending on whether `x` exists in the
  fixture.
- "or whatever subset the run shows" accepts any result.

**Fix:** test concrete lines that change the shell, each followed by
`; ls sub` so the line has a step, and expect every one to be `broad`:
`export FOO=1`, `set -e`, `shopt -s globstar`, `alias ll=ls`,
`umask 077`, `hash -p /bin/ls ls`, `FOO=1`, `printf -v x hi`, `read x`,
`trap 'echo' EXIT`, `pushd sub`, `source x`, `eval ls`, `exec ls`,
`unset PATH`, `declare x=1`, `enable -n echo`, `builtin cd sub`,
`command cd sub`. This list fails when someone adds a rule for one of
them.

## 10. Task 6, row 4 expects the stop in the wrong place

The handler changes `sub` while the first question is being answered.
Every question is raised before any step runs, so `sub` is already a
link when the first step starts. The runner is in `<fixture>/sub` from
the start, so the folder check stops the line before `git status`, the
first command. The row expects the stop before the second command.

**Fix:** expect "Stopped before `git status`" and no output from either
command.

## 11. Smaller points

- **A failing `cd` in pull request 1.** The runner sets `stopped` for
  any `cd` whose folder is missing. Bash does that only for a
  top-level `cd`, which today runs as `cd '/abs' || exit 1`. A `cd`
  inside `&&` gives status 1, and bash carries on after a group. For
  example, in `(cd sub && ls); ls` bash still prints the outer listing.
  The plan also does not say how the runner learns that the folder is
  missing. `_realFolder` keeps a missing folder as written and does not
  fail. `_bash` throws when the folder is missing (`resolveSpawnCwd`).
  Give `runOneStep` the same handling `runBash` has for a thrown
  `_bash` ("`<label>` was not run: …"). Give an `&&` `cd` status 1 in
  pull request 1. In pull request 2 a changed or missing `cd` target
  stops the line anyway.
- **In-process failure text.** `runChain` keeps only the last failure
  message (`lastError`). Task 3 appends every failure to `stderr`. A
  shell-free chain with two failing steps would print different text.
  Keep only the last one, as today, or pin the new text with a test.
- **The refuse wall is not run again.** `removeRefusal` reads the disk,
  and the runner only calls `classify`. A changed `rm` target changes
  the `std::remove` payload, so the effect check stops the line. Say
  that in the doc section, so that a reader does not add a second wall.
- **Step 0 and Task 3, Step 1 disagree.** Step 0 leaves the test
  technique open (a handler, or an agency-js test). Task 3, Step 1 then
  uses a handler that calls `remove(...)`. Write "with the technique
  Step 0 chose" in Step 1 and in Tasks 5 and 6.
- **Task 1's test line `false; echo after`** is a readonly `bash` plan
  and has no `steps` field. Drop it, or expect null for it.
