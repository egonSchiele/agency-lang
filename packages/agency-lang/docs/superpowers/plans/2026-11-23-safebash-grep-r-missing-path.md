# safeBash: `grep -r` of a Missing File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `grep -rn x lib/missing.ts` asks the narrow `std::grep` question that `grep -n x lib/missing.ts` already asks, in place of `std::bash`.

**Architecture:** `readGrep` stops switching to the strict lookup when it sees `-r`. A missing path then goes through `missingPath`, the rule a grep without `-r` already uses. Nothing else changes.

**Tech Stack:** Agency (`stdlib/safeBash.agency`), Agency tests in `tests/agency/`.

**Spec:** There is no separate spec. The trace that motivated this is analysed in `docs/superpowers/specs/2026-11-22-safebash-prompts-trace-analysis.md`, under "A path that does not exist (4)". The owner agreed to this change on 2026-11-23.

## Background

`safeBash` asks one narrow question per command when it can describe the command, and `std::bash` about the whole line when it cannot. A policy can answer a narrow question in advance. Read "Resolving the path when the plan is made" in `docs/dev/stdlib/safe-bash.md` before you start.

A file that does not exist already has a rule, `missingPath`, when the folder it would be in exists. This line asks `std::grep` for the file `nope.txt` in the working folder, grep runs, and the model reads grep's own "No such file" error:

```bash
grep -n hello nope.txt | head
```

The same line with `-r` asks `std::bash`:

```bash
grep -rn hello nope.txt | head
```

The cause is one line in `readGrep` (`stdlib/safeBash.agency:1351`):

```
const lookup: LineState = if (args.plain.includes("r")) then strictLine(line) else line
```

A strict lookup never uses `missingPath`. The comment above the line gives the reason: "A grep -r searches a folder, which must be real."

Models write `-rn` out of habit, on single files too. In one 97-minute agent session, three lines were a `grep -rn` of one file that did not exist, and each asked `std::bash`. In all three the folder existed (`lib/runtime`, `lib/host/node`, `lib/compiler`).

## Why the strict lookup is not needed

The strict lookup guards against one case: the path is missing when the plan is made and is a folder by the time grep runs. A question that named a file would then be false, because `grep -r` would read every file under the folder.

The runner already covers that case. It plans each step again just before the step runs, and stops the line when the question changed. The fresh plan and the comparison are in `checkedStep` (`stdlib/safeBash.agency:7546`), which `runBashStep` calls before every step. A path that is now a folder plans to the folder question, which differs from the approved file question, so the line stops before grep starts.

## Decisions

1. A missing path under `grep -r` is asked about as the file it would be: `{ dir: <the real parent>, file: <the name> }`. This is what a grep without `-r` asks.
2. The parent folder must exist, as `missingPath` requires today. `grep -rn x nodir/nope.txt` stays on `std::bash`.
3. `find`, `tree`, `diff`, `cmp`, an input redirect, and the in-process paths stay strict.

## Global Constraints

- The in-process grep is not changed. `tryShellFreeGrep` passes its own strict line to `readGrep` (line 1643), and a lone `grep -rn x nope.txt` falls through to bash, as a lone `cat nope.txt` does.
- Do not run `agency fmt` on any existing `.agency` file.
- Run `make` once and each test file once. Save the output of every test run to a file. Do not run any other Agency test file locally. CI runs them.
- Write every commit message in a file and pass it with `git commit -F <file>`.
- Change files with the Edit and Write tools only.

## Review Focus

1. `grep -rn x nope.txt` as the whole line must be `narrow`, not `broad` and not `shellFree`. [Task 1]
2. `grep -rn x nodir/nope.txt | head` must stay `broad`, because the parent folder is missing. [Task 1]
3. A path that is missing at plan time and is a folder when grep runs must stop the line before grep starts. [Task 1, Step 3]
4. A grep of two paths where one is missing, `grep -rn x one.txt nope.txt | wc -l`, must ask one question per path and keep both paths in the command that runs. [Task 1]

### A behavior the owner accepted on 2026-11-23

A line that creates a folder and then greps it with `-r` now stops before the grep, when the folder was missing at plan time:

```bash
pnpm build && grep -rn "createRun" dist | head
```

In a fresh worktree with no `dist`, this line used to ask `std::bash` once and run whole. It now asks `std::exec` for the build and `std::grep` for a file named `dist`. The build runs, `dist` turns out to be a folder, and the line stops before the grep. The model reads why and runs the grep again as its own line.

The stop is safe, and the cost is one more model turn. The owner accepted it because a grep of a mistyped file name is the more common line. Do not add state to the classifier to predict what an earlier command created.

The test in Step 3 pins this stop. It uses `mkdir -p out` in place of a build, because `mkdir` asks a narrow question a test can approve.

---

### Task 1: let `grep -r` name a missing file

**Files:**
- Modify: `stdlib/safeBash.agency:1349-1351` (`readGrep`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`
- Test: `tests/agency/safeBashSteps.agency`, `tests/agency/safeBashSteps.test.json`
- Modify: `docs/dev/stdlib/safe-bash.md`

**Interfaces:**
- Consumes: `missingPath`, through `grepCallFor`, unchanged.
- Produces: no new name. `readGrep` keeps its signature.

- [ ] **Step 1: Add the test node `grepRNamesAMissingFile` to `tests/agency/safeBash.agency`**

Put it after `missingPathsResolveByParent` (line 1112). It uses that node's fixture and helper, `makeFilesFixture` and `fileRow`.

| Row | Outcome | Effects |
|---|---|---|
| `fileRow("grep -rn x nope.txt \| head")` | `narrow` | the same one `std::grep` that `grep x nope.txt \| head` gives in `missingPathsResolveByParent` |
| `fileRow("grep -rn x nope.txt")` | `narrow` | the same |
| `fileRow("grep -rn x one.txt nope.txt \| wc -l")` | `narrow` | two `std::grep`, for `one.txt` and for `nope.txt` |
| `fileRow("grep -rn x nodir/nope.txt \| head")` | `broad` | `std::bash` |
| `fileRow("grep -rn x sub \| head")` | `narrow` | one `std::grep` for the folder `sub`, as today |

`fileRow` cannot tell a file question from a folder question for grep. It prints a payload through `fixturePath` (line 1007), which appends `payload.filename`, and a `std::grep` payload names its file in `payload.file`. So every row above prints `["std::grep","<fix>"]` whether the question names `nope.txt` or the whole folder. Add one row that reads the field directly:

```
[effect.payload.file for effect in planFor("grep -rn x one.txt nope.txt | wc -l", FILES_FIXTURE).effects]
```

Expected: `["one.txt","nope.txt"]`. A folder question would put `null` in that place. Do not change `fixturePath`. That would change the expected output of every existing grep row in the file.

Add one row with `executionCommandIn` (line 2636): `grep -rn x one.txt nope.txt | wc -l` in `FILES_FIXTURE` runs as `grep -r -n -e 'x' -- one.txt nope.txt | wc -l`. No path is a folder, so the command has no `--exclude` flags.

Add the node's entry to `tests/agency/safeBash.test.json` with `"type": "exact"`. Copy the shape of the entry for `missingPathsResolveByParent`, and take the payload text for `nope.txt` from that entry's row for `grep x nope.txt | head`.

- [ ] **Step 2: Keep `grepMissingPath` testing what it tests**

`grepMissingPath` (`tests/agency/safeBash.agency:1497`) plans `grep -rn hello missing-dir` in `FIXTURES` and expects the broad reason's kind, `"unrecognized"`. After this change that line is narrow, and the node would return `null`.

Change its line to `grep -rn hello nodir/missing-dir`. The parent folder is missing too, so the line stays broad and the expected value stays `"unrecognized"`. In `tests/agency/safeBash.test.json`, change the node's description to say that a grep path whose folder is missing too makes the command unrecognized.

No other existing row names a missing path under `grep -r`.

- [ ] **Step 3: Add the test node `aGrepOfAPathThatBecameAFolderStops` to `tests/agency/safeBashSteps.agency`**

Use the helper `skippedCdRow` (line 108), or a copy of it without the extra `mkdir`. It runs `safeBash(line, cwd: FIXTURE) with approve` and returns the line, whether it succeeded, its `failureType`, and its text with the fixture path replaced. Run this line:

```bash
mkdir -p out && grep -rn x out | wc -l
```

Assert that the line did not succeed, that its `failureType` is `"planChanged"`, and that its text starts with:

```
Stopped before `grep -rn x out | wc -l`: 
```

The stop message names the whole step, and here the step is the pipeline. Add the entry to `tests/agency/safeBashSteps.test.json`.

Put this comment above the node:

```
// The line stops because grep does not know the folders a line made, as
// a listing does (`madeFolder`). If grep learns that, this line runs
// whole and this test changes. The stop is not a safety rule.
```

- [ ] **Step 4: Change `readGrep`**

Replace the comment and the `lookup` line at 1349-1351 so that `grepCallFor` is called with `line`:

```
// A path that is missing now resolves like any other read's, with or
// without -r. If it is a folder by the time grep runs, the step's fresh
// plan asks about the folder, which is not what was approved, and the
// line stops (`checkedStep`).
```

Remove the `lookup` constant.

The comment above `strictLine` (lines 2154-2156) lists the lookups that are strict. Take `grep` out of that list. A grep through bash no longer uses `strictLine`, and the in-process grep is covered by "the shell-free paths" in the same comment.

- [ ] **Step 5: Update `docs/dev/stdlib/safe-bash.md`**

1. In the paragraph that starts "Some lookups set `strict`" (line 1049), take `grep -r` out of the list.
2. After the numbered rules for a missing path in the same section, add one short paragraph: a `grep -r` of a missing path is asked about as the file it would be, with the `pnpm build && grep -rn x dist` example and the fact that the line stops before the grep.

Write only the mechanism and the rule.

- [ ] **Step 6: Build and run the two test files**

The commands write their logs to `$LOGS`. Set it to a scratch folder outside the repository first.

Run: `make > $LOGS/make.log 2>&1; echo "exit=$?"`
Expected: `exit=0`.

Run: `pnpm run agency test tests/agency/safeBash.agency --check-capabilities > $LOGS/safebash.log 2>&1; echo "exit=$?"`
Expected: `exit=0`. Step 2 handled the one existing node this change affects. Any other failing row is a bug in this branch.

Run: `pnpm run agency test tests/agency/safeBashSteps.agency --check-capabilities > $LOGS/steps.log 2>&1; echo "exit=$?"`
Expected: `exit=0`.

On a failure, read the log. Do not run a test again to see its output.

- [ ] **Step 7: Commit**

Message: `safeBash: grep -r of a missing file asks std::grep for the file`

---

## Not in this plan

- A missing file whose folder is also missing, such as `ls dist/scripts/agency.js` before a build. `_missingTarget` requires the parent folder on purpose, and that reason has to be read before the rule is relaxed. It was one prompt in the trace.
- Letting grep use the folders a line made (`madeFolder`), so `mkdir -p out && grep -rn x out` runs whole. The owner decided on 2026-11-23 to leave this out. Do not add it in this PR. A grep of a folder the line just created finds nothing, so the line is rare. The test in Step 3 carries a comment saying its stop would become a full run if this is ever added.
- `find`, `tree`, `diff`, and `cmp` of a missing path.
