# Review, round 2: a lone `cat` of several files, and chains, run in process

This is a second review of `docs/superpowers/plans/2026-11-01-safebash-cat-files-and-chains-in-process.md`, after the first review was folded in (commit cf555a63a).

I checked the revised plan against the code on this branch: `planFor`, the shell-free planners, `READ_VERBS`, the executors in `stdlib/safeBash/actions.agency`, and the test rows the plan changes. I read `docs/dev/language/destructive-regions.md` for the write region. I did not run any tests.

Every first-round finding is folded in correctly. I traced the flat link list with its joins through `a || b && c` and `a && b || c`, with each command succeeding and failing, and it gives bash's order every time. The new findings are in three groups:

1. Fix before building. Two test rows change meaning and the plan does not name them, and one failure case is not specified.
2. Should fix. One new table repeats a table that already exists.
3. Smaller points.

---

## 1. Fix before building

### 1.1 Two more rows change meaning, and the grep in Step 1 will not find them

Step 1 says to grep for other all-echo lines "whose row expects `std::bash`". Two rows use `echo hi; echo bye` and expect something else:

- `planReasons` (`tests/agency/safeBash.agency:422`) expects `["noEffects",""]`. After Task 2 the line is a chain with no `broadReason`, so the row gives `null`.
- `planOutcomes` (`tests/agency/safeBash.agency:448`) expects `"broad"`. After Task 2 it gives `"shellFree"`.

These are the only rows that pin the `noEffects` reason and an all-echo line's `broad` outcome. Swap each to `echo hi | cat`, the same string the plan uses for `rejectedAuditSaysWhy`. It is recognized, has no effects, and is a pipeline, so the reason stays `noEffects` and the outcome stays `broad`. Name both rows in Task 2 next to the other swaps.

The bash plan's new node `echoIsTheSameAloneAndInAChain` uses `echo 'a\tb'; echo x`, which also becomes a chain. My round-2 review of that plan asks it to use `echo 'a\tb'; echo x; true` instead. If that change is not made there, this plan has to make it.

### 1.2 What `runRead` does when the second file fails

Task 1 says `runRead` "reads each payload with `_read` in order, joins the texts". It does not say what happens when one read fails. The plan refuses a missing file at plan time, so a failure here means the file was removed or became unreadable between planning and running. Real `cat a.txt b.txt` prints `a.txt`, writes an error for `b.txt`, and exits 1.

Pick one rule and write it in the interface. I'd return `_read`'s failure as it is, the way the one-file `runRead` does today (`stdlib/safeBash/actions.agency:333-336`), and drop the text already read. That keeps one rule for one file and for several. Real `cat` would also have printed the first file. Write that difference in the dev doc's "left out" list. `printRead` follows the same rule, so a chain sees the step as failed.

---

## 2. Should fix

### 2.1 `SHELL_FREE_READ_PATHS` repeats `READ_VERBS`

The new table gives `head` and `tail` at most one path. `READ_VERBS` already does (`paths: AT_MOST_ONE`, `stdlib/safeBash.agency:1135-1142`), and `readFileVerb` refuses `head a b` before `shellFreeReadPlan` sees it. The plan's own new row says so: `head one.txt two.txt` is `broad`, refused by `READ_VERBS`. The table's `least: 1` repeats `shellFreeReadOf`, whose `stdin` arm already refuses a read with no path.

So the head and tail entries can never be the reason a plan is refused, and the cat entry allows any number. The whole change Task 1 needs in `shellFreeReadPlan` is to delete the `paths.length != 1` check. Keep `SHELL_FREE_READ_VERBS` as it is. Path counts then live in one table, and there is no second message to keep in step with `describeCount`.

### 2.2 The parity helper passes when safeBash fails and bash prints nothing

`readParityOf`, which becomes `exactParityOf`, sets `ours` only when `safeBash` succeeds. When it fails, `ours` stays `""`. A row where safeBash fails and the real command prints nothing compares `""` with `""` and returns `true`. None of the six chain rows fails today. Chains add failing steps, though, and a later row such as `grep zzz one.txt && echo yes` would pass whether or not the chain ran. Return `"FAILED: ${why}"` from the helper when `safeBash` fails. The helper is being renamed in the bash plan anyway, so this costs one `if`.

### 2.3 Say where the narrowing to `StepExec` lives

`tryShellFreeStep` returns `Result<Plan>`, because `planFor` uses it for a lone command too. The exhaustive match that turns a plan's `Execution` into a `StepExec` is described in the same paragraph, but it belongs in `tryShellFreeChain`. Name it, for example `stepExecOf(exec: Execution): Result<StepExec>`, and put it in the Interfaces block. Then the implementer does not put the narrowing in `tryShellFreeStep`, where `planFor`'s lone-command path would have to undo it.

---

## 3. Smaller points

1. `chainFailsLikeBash` returns `[skipped is failure(why), ran]`. Binding `why` inside an array literal has no precedent in the tests. The value-position form in use is `result is failure` with no binding (`tests/agency/toolbox/designTool/accept.agency:89`). Use `skipped is failure`.
2. In Task 2 Step 1, the sentence "Expected: all `true`." comes after `chainFailureAfterAWriteIsDestructive`, whose expected value is `[true, false]`. It belongs to `chainMatchesBash`. Move it up.
3. The write region is entered before `_write` runs, so a write step that fails before writing anything (a permission error) still reports `destructiveRan: true`. That is the safe direction. One clause in the dev doc's region paragraph says so.

---

## Claims I checked and found true

1. Every first-round finding is in the plan: the `cat -n` one-file rule with its reason, the write region with the `[true, false]` test, `exactParityOf`, row 9 as `["narrow","bash",["std::read"]]`, the `"read"` kind first in the two-question node, the `describeCount` message, the grep note in the dev doc, `echo hi && echo bye && true`, and the exhaustive match without `_`.
2. `true` and `agency` reach `otherVerbEffects` on the general path and fail with "no rule for ..." (`stdlib/safeBash.agency:412-421`), so rows 7 and 13 of `chainsOfInProcessCommands` are `broad`.
3. `runWrite` is an ordinary def with a region inside (`stdlib/safeBash/actions.agency:355-375`). Calling it does not flip the caller's flag, so `runChain` needs its own region, as the plan says. `destructive-regions.md` puts no limit on a region inside a loop or a `match` arm.
4. `safeBash` returns `raised` unchanged when `broadReason` is null (`stdlib/safeBash.agency:2041-2043`), so a rejected question in a chain keeps its `rejected` flag with no new code.
5. `grep-fixtures` holds `one.txt` and `two.txt`, and `one.txt` has no `zzz`, so the no-match rows fail for the reason the plan gives.
