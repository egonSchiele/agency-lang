# Plan review: `grep -r` of a missing file

Reviews `docs/superpowers/plans/2026-11-23-safebash-grep-r-missing-path.md`. The architecture review is in `2026-11-23-safebash-grep-r-missing-path-review.md`, so this review does not cover the accepted `pnpm build && grep -rn x dist` stop again. It checks the plan's claims against the code and checks whether each test can fail. Nothing in the plan has been changed.

Summary: the change is safe and correctly scoped. Finding 1 is a test that cannot fail on the bug it is meant to catch. Finding 2 is an existing test the plan will break without naming it. The other findings are small.

## The safety argument holds

I traced each way a planned grep runs.

- **Through bash.** `runBashStep` (`stdlib/safeBash.agency:7576`) calls `checkedStep` (line 7546) before every step. `checkedStep` plans the step again with `bashLine(freshLine(cwd))`, which is not strict, and compares the effects with `sameEffects`. A path that is now a folder plans to `{ dir: <folder>, file: null }`, which differs from the approved `{ dir, file: "out" }`, so the line stops. A folder whose name the grep tool skips, such as `node_modules`, has no rule in `grepSearchRule` (line 1548), and that also stops the line.
- **In process.** A step safeBash runs itself is not planned again, so it must never get the relaxed lookup. It does not. The only route into an in-process grep is `tryShellFreeGrep`, which passes its own `strictLine(freshLine(cwd))` (line 1643). `inProcessPipeline` (line 5597) reaches grep only through `tryShellFreeStep`, which calls `tryShellFreeGrep`. So a missing path under `grep -r` fails the in-process route and falls to `grepRule` (line 1508), which bash runs.
- **`missingPath` is the only reader of `strict`.** `grep -n '\.strict'` finds one use, line 2226. Removing the `lookup` constant changes nothing else.

The window between `checkedStep` and `_bash` is the same one an existing file under `grep -r` has today, when a file is swapped for a folder. The plan opens no new kind of gap.

## Finding 1: the plan-level rows cannot tell a file question from a folder question

`fileRow` prints each effect as its name and `fixturePath(effect.payload)`. `fixturePath` (`tests/agency/safeBash.agency:1007`) appends `payload.filename`. A `std::grep` payload names its file in `payload.file` (`grepPayload`, line 1495), so the file is dropped. The existing row shows this:

```
["grep x nope.txt | head","narrow",[["std::grep","<fix>"]]]
```

A grep of the whole fixture folder, `grep -rn x .`, prints the same `["std::grep","<fix>"]`. So the rows in Step 1 pass whether the new code asks about the file `nope.txt` or about the whole folder it sits in. The second answer would be a wrong question that a policy could approve. That is the bug this test exists to catch.

The two-path row has the same problem: "two `std::grep`, for `one.txt` and for `nope.txt`" prints as two identical `["std::grep","<fix>"]` entries.

**Fix:** add one row to `grepRNamesAMissingFile` that returns each grep payload's `file`:

```
[effect.payload.file for effect in planFor("grep -rn x one.txt nope.txt | wc -l", FILES_FIXTURE).effects]
```

Expected: `["one.txt","nope.txt"]`. A folder question would give `null` in that place, and the row would fail.

Do not change `fixturePath` to fix this. It would change the expected output of every existing grep row in the file for a gap the new row closes.

## Finding 2: Step 5 will fail on `grepMissingPath`, and the plan should name it

`grepMissingPath` (`tests/agency/safeBash.agency:1497`) plans `grep -rn hello missing-dir` in `FIXTURES` and expects the broad reason's kind, `"unrecognized"`. `FIXTURES` exists and `missing-dir` does not, so after the change this line is narrow, `broadReason` is null, and the node returns `null`.

Step 5 says a failing row "means an existing row asserted that a `grep -r` of a missing path is `broad`. Update that row's expected value." For this node, updating the expected value to `null` would drop what it tests. Its description in `safeBash.test.json` is "A grep path that does not exist makes the command unrecognized; planFor does not throw."

**Fix:** name the node in Task 1, and change its line to `grep -rn hello nodir/missing-dir`. The parent folder is missing too, so the line stays broad with kind `"unrecognized"`, and the expected value does not change. Update the description to say the folder is missing too.

I found no other existing row that this change breaks. The other `grep -r` rows in `safeBash.agency`, `safeBashSteps.agency`, `safeBashGlobs.agency`, and `safeBashAccesses.agency` all name paths that exist. The rows in `lib/stdlib/safeBash.test.ts` only test the parser.

## Finding 3: the comment above `strictLine` still lists `grep`

`stdlib/safeBash.agency:2154-2156`:

```
/* The same line, for a lookup where a missing path has no rule: `find`,
 `tree`, `grep`, `diff`, `cmp`, an input redirect, and the shell-free
 paths, which each need a real folder or real files. */
```

After the change, a grep through bash does not use `strictLine`. Only the shell-free grep does, and the comment already covers that under "the shell-free paths". Add a step to Task 1 that removes `grep` from this list, next to Step 4's change to the same list in the dev doc.

## Finding 4: Step 3's comment names the wrong function

The new comment ends "and the line stops (`runBashStep`)". The fresh plan and the comparison happen in `checkedStep`. `runBashStep` only calls it. Name `checkedStep`, so a reader who follows the comment lands on the code that does the check. The same applies to "Why the strict lookup is not needed" in the plan's background.

## Finding 5: Step 2 points at the wrong model test

Step 2 says to model the new node on `aChangedPlanStopsTheLine`. That node uses `stopRow` and `changedWhileAsking`, which change the disk inside the handler while a question is answered. The new test changes nothing from outside: `mkdir -p out` makes the folder as the line runs. The helper that fits is `skippedCdRow` (line 108). It runs `safeBash(line, cwd: FIXTURE) with approve` and returns whether the line succeeded, its `failureType`, and its text with the fixture path replaced.

The stop message names the whole step, and here the step is the pipeline. So the assertion is that the text starts with:

```
Stopped before `grep -rn x out | wc -l`: 
```

Also assert `failureType(out)` is `"planChanged"`, as `theStopSaysWhatChanged` does. That separates this stop from any other failure of the line.

## Finding 6 (owner's call, say once): the Step 2 test pins a stop that existing line state could prevent

The line `mkdir -p out && grep -rn x out` stops because `grepCallFor` (line 1364) does not check `madeFolder`. `listTargetOf` (line 2263) does check it, so `mkdir -p out && ls out` asks `std::ls` for the folder and runs whole (`foldersTheLineMade`). The `made` list already exists in `LineState`. Using it in grep adds no state, so it does not conflict with "Do not add state to the classifier". The change is about five lines that mirror `listTargetOf`.

The plan lists this under "Not in this plan", and it can stay there. If it does, add one comment above the new test saying that the stop changes to a full run when grep learns `madeFolder`. Then a later change does not read the test as a safety rule. The accepted `pnpm build` stop does not depend on this, because a build raises no `std::mkdir` and leaves nothing in `made`.

## Checked and correct

- Every line number the plan cites matches the code: `readGrep` 1349-1351, `tryShellFreeGrep` 1643, `missingPathsResolveByParent` 1112, `executionCommandIn` 2636, `aChangedPlanStopsTheLine` 200, `theStopSaysWhatChanged` 209, and the dev doc paragraph at 1049.
- The expected command `grep -r -n -e 'x' -- one.txt nope.txt | wc -l` matches `grepCommand`. `searchesFolder` stays false when every target has a `file`, so no `--exclude` flags are written.
- `grep -rn x nodir/nope.txt | head` stays broad. `_missingTarget` requires the parent folder.
- `grep -rn x nope.txt` as a whole line is narrow, not shell-free. `tryShellFreeGrep` fails on the strict lookup and `grepRule` takes it.
- Decision 3 holds. `find` (line 2458), `diff`/`cmp` (line 2638), `tree` (line 2522), the input redirect (line 354), and the shell-free read (line 4463) keep their own strict lookups.
- Step 5 runs `make` once, each test file once with `--check-capabilities`, and saves every log.
