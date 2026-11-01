# Review: a lone `cat` of several files, and chains, run in process

This is a review of `docs/superpowers/plans/2026-11-01-safebash-cat-files-and-chains-in-process.md`.

I checked the plan against the code on this branch (5f2b4db74). I ran the bash parser from the main checkout's build (tarsec 0.5.6) on the plan's test lines, and ran macOS `cat` on the read fixtures. I did not run any tests.

The design reads well. One list of in-process planners, the flat link list with a join each, and refusing a `Parens` all hold up. The left-associative parse gives the same order bash uses. I checked `a || b && c`, which parses as `And(Or(a, b), c)`.

The findings come in two groups:

1. Fix before building. One output is wrong on macOS, a retry could repeat a write, and three tests cannot fail or will fail.
2. Should fix.

At the end there is a list of the plan's claims that I checked and found true.

---

## 1. Fix before building

### 1.1 BSD `cat -n` numbers each file from 1

Task 1 says "one render over the joined text is what makes `cat -n a b` number across both files as one stream, which is what `cat -n` does". That is GNU's behavior. macOS `cat` starts again at 1 for each file:

```
$ cat -n read-fixtures/noeol.txt read-fixtures/one.txt
     1	first line
     2	second line     1	hello world
     2	foo bar baz
     3	hello again
```

GNU prints `1` to `4` for the same command. One rendering cannot match both, which breaks the rule the read family rests on: one output on every machine. The parity row `parityOf("cat -n noeol.txt one.txt", ...)` would fail on macOS.

Suggested fix: the shell-free path takes several files only for the `whole` view. `cat -n` of more than one file goes through bash, the way a count of 0 does. Do that in `shellFreeReadPlan`, with a message such as "cat -n of several files is refused shell-free". It is the same kind of rule as `readViewFor`'s count-of-0 refusal, so it belongs next to it.

Change Task 1's tests to match:

- the `cat -n one.txt two.txt` row in `loneReadIsShellFree` becomes `narrow`;
- drop the parity row `cat -n noeol.txt one.txt`;
- the chain parity row `cat -n one.txt; cat -n two.txt` stays, because each step is one file.

The dev doc needs one sentence on why.

### 1.2 A chain with a write step loses `destructiveRan`

`destructive-regions.md` says a failure carries `destructiveRan: true` when it leaves the function that entered the destructive work. Only `runWrite` enters a `destructive { }` region (`stdlib/safeBash/actions.agency:368`). In a chain, `runWrite` returns success, and a later step's failure is a new `exitFailure` built in `runChain`, whose activation never entered a region. Take this line:

```
echo started >> log.txt; grep zzz one.txt
```

The write happens, the grep finds nothing, and the chain fails with `destructiveRan: false`. The tool loop reads that as "failed before touching anything" and may let the model call it again, which appends `started` a second time.

Suggested fix: in `runChain`, run a write step inside a `destructive { }` region of `runChain`'s own, so any failure that leaves `runChain` after a write carries `destructiveRan: true`. `printStep` can stay as it is for the other kinds. Add a test in the style of `tests/agency/destructive-block.agency`:

```
node chainFailureAfterAWriteIsDestructive() {
  const result = safeBash("echo hi > out.txt; grep zzz one.txt", cwd: <a scratch folder holding one.txt>)
  if (result is failure(why)) {
    return [result.destructiveRan]
  }
  return "UNEXPECTEDLY SUCCEEDED"
}
```

Expected `[true]`. Add a twin with the grep first and the write after a `&&`, so the write never runs, expecting `[false]`. Use a scratch folder, not `FIXTURES`, because the write is real.

The bash path has the same gap today. `runBash` enters no region, so `echo hi >> f && false` through bash is also a clean failure. That is outside this plan, but worth a ticket.

### 1.3 `parityOf(source, kind, cwd)` does not exist

Task 1's parity rows and Task 2's `chainMatchesBash` call `parityOf(source, kind, cwd)`, "the helper the bash plan generalized". The bash plan does not generalize it. It adds a third copy, `echoParityOf`. Today the test file has `parityOf(source)` (grep, sorted lines, `FIXTURES`) and `readParityOf(source)` (exact, `READ_FIXTURES`).

My review of the bash plan asks it to replace `readParityOf` with `exactParityOf(source, kind, cwd)`. Whichever way that goes, this plan should name the helper it uses, and add it here if the bash plan did not.

### 1.4 Row 9 of `chainsOfInProcessCommands` expects the wrong thing

`echo a; cat one.txt | head` parses as a simple command and a pipeline. The chain planner refuses it, so it goes down the general path. There, `echo` adds nothing, `cat one.txt` adds `std::read`, and `head` with no path in a later pipe stage adds nothing (`stdinStage`). So the plan is narrow:

```
["narrow","bash",["std::read"]]
```

The plan expects `["broad","bash",["std::bash"]]` "(pipeline, same reason)". That reason applies to the parens row, where every command is an echo. Here it does not.

### 1.5 `catOfTwoFilesAsksTwoQuestions` cannot fail

Before Task 1, `cat one.txt two.txt` asks two `std::read` questions and runs real `cat` through bash, which prints the same text. So the node passes before and after the change, and Step 2's prose says so mid-sentence ("...no: it asks two `std::read` and runs bash, so it passes the handler check but the test proves nothing yet"). Make the node prove the new path. Return `[planFor("cat one.txt two.txt", FIXTURES).execution.kind, result.value]` and expect `"read"` first. Then tidy Step 2's text.

---

## 2. Should fix

### 2.1 Task 1's miss message contradicts itself

Task 1 Step 3 says the message for too many paths is "the shell-free path reads one file" for head and tail, and also "reuse `describeCount`". `describeCount` would produce "at most 1 path". Pick one. I'd reuse `describeCount` with the verb, so the message comes from the same table as the check: "the shell-free head takes at most 1 path". The message is internal, because a failed shell-free plan falls through to the general rules.

### 2.2 A grep's note lands in the middle of a chain's output

A shell-free directory grep appends `_skippedDirsNote()`, and possibly the match-cap note. In a chain such as `grep -rn TODO src; echo done`, the note sits between the matches and `done`. Real bash prints no note there. The parity rows avoid it, because every grep in them names one file. Say this in the "Chains in process" section, so a reader of a session log does not take the note for the program's output.

### 2.3 Keep what `sequenceRunsThroughBash` proves

The plan swaps `echo hi; echo bye` for `echo hi | cat` in the tests whose meaning changes. For `rejectedAuditSaysWhy` that keeps the point, because the line has no effects. `sequenceRunsThroughBash` is about a sequence, though ("A sequence runs in one bash call, so its output is bash's"), and a pipe is not a sequence. Use a sequence the chain planner refuses, such as `echo hi; echo bye; true`. `true` has no rule, so the line stays broad, runs through bash, and prints `hi\nbye\n`.

### 2.4 Name the planner list once

`tryShellFreeStep` is the right idea. After Task 2, `planFor`'s single-command block reads `tryAgencyPlan`, then `tryShellFreeStep`, and the chain reads `tryShellFreeStep`. Make sure the narrowing match in `tryShellFreeStep` is exhaustive over `Execution`, with the non-step kinds as failure arms and no `_`. Then a new in-process kind is a type error until someone decides whether chains may hold it, which is what the plan asks for.

---

## Claims I checked and found true

1. `a && b || c` parses as `Or(And(a, b), c)`, and `a || b && c` as `And(Or(a, b), c)`. `echo a && (echo b || echo c)` gives an `and` whose right side is a `parens`.
2. `(a; b)` does not parse, so a `;` inside parentheses never reaches the chain planner.
3. `cat one.txt noeol.txt` with plain `cat` joins the second file's first line to the first file's last line on macOS, as Review Focus 1 says. The same holds for GNU.
4. `head one.txt two.txt` is refused by `READ_VERBS` (`paths: AT_MOST_ONE`, "head takes at most 1 path"), so the row's `broad` is right.
5. `cat one.txt && rm one.txt` reaches the general path, where `isRefused` returns a refuse plan. `outcomeOf` names it `"refuse"`, and its kind is `"refuse"`.
6. `planDetail` plans against `/repo` and reads `content` only for an `echo` execution, so a chain row gives `["chain","",[]]` as the plan says.
7. Tests read a failure's `destructiveRan` field directly (`tests/agency/destructive-block.agency:12`), so the test in 1.2 can be written in Agency.
