# A lone `cat` of several files, and a chain of in-process commands, run in process (ADI-264, ADI-262)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cat a.txt b.txt` reads both files through `_read` with no shell; and a line of commands joined by `;`, `&&`, or `||`, where every command is one safeBash already runs in process on its own, runs in process as a chain, with the same questions it asks today and no shell.

**Architecture:** Task 1 widens `ReadExec` from one payload to a list, which is all a multi-file `cat` needs. Task 2 adds one execution kind, `ChainExec`, a list of steps each holding an existing in-process execution (`echo`, `write`, `grep`, `read`) and the operator that joins it to the step before. `planFor` builds it by running the existing lone-command planners on each command of the chain; `runChain` folds over the steps with bash's left-to-right rule for `&&` and `||`. The chain is all or nothing: one command the planners refuse sends the whole line down today's path.

**Tech Stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), the Agency test runner, `make`.

**Spec:** `docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 5 and the rule in `docs/dev/stdlib/safe-bash.md`, "In process when it translates". Tickets ADI-264 and ADI-262 on Linear.

**Order:** Execute `2026-11-01-safebash-bash-shell-and-echo-n.md` first. The parity tests here compare against the `bash` tool, and the chain runner's echo must agree with the shell's echo, which is only settled once the shell is bash.

## Background for the implementer

Read `docs/dev/stdlib/safe-bash.md` whole, then in `stdlib/safeBash.agency`: `planFor`, `trySeeIfShellFree`, `echoPlan`, `writePlan`, `tryShellFreeGrep`, `tryShellFreeRead`, `shellFreeReadPlan`, `readViewFor`, `outcomeOf`, `safeBash`, `raiseAll`; in `stdlib/safeBash/actions.agency`: `Execution`, `ReadExec`, `readExecution`, `runRead`, `runGrep`, `runWrite`, `exitFailure`; in `lib/stdlib/readDialect.ts`: `_renderReadView`.

How a plan is made today: `planFor(source, cwd)` parses `source` into `commands: Command[]`. A `;` between commands puts them in that top-level list; `a && b` is an `And` node with `left` and `right`; `a || b` an `Or`; parentheses a `Parens`; `a | b` a `Pipeline`. The parser is left-associative, so `a && b || c` is `Or(And(a, b), c)`. When the list holds exactly one `SimpleCommand`, four planners are tried in order (`tryAgencyPlan`, `trySeeIfShellFree` for echo and a redirected echo, `tryShellFreeGrep`, `tryShellFreeRead`); the first success is the plan. Otherwise every simple command is classified with `effectsFor`, and the whole text runs through bash, narrow when all were recognized and broad otherwise.

So the owner's line

```
echo "=== table.json ==="; cat table.json; echo; echo "=== comments.jsonl ==="; cat comments.jsonl
```

asks two `std::read` questions today (the echoes contribute nothing), and then spawns a shell to run real `cat` and the shell's echo. Every one of its five commands would run in process on its own.

How a plan runs: `safeBash` raises every effect with `raiseAll`, then dispatches on `plan.execution.kind`. The in-process executors (`runWrite`, `runGrep`, `runRead`, and the inline `echo` arm) each call `keepOutput(text, exitCode, command)`, which caps long output and names the command in the saved copy, so their result is already the model's view. A chain needs each step's raw text, joins them, and calls `keepOutput` once on the whole.

Bash's rule for a chain, which the runner copies: commands run left to right; `;` runs the next whatever happened; `&&` runs the next only when the last run command exited 0; `||` runs the next only when it did not. The chain's exit status is the last command that ran. A command that is skipped does not change the status. `grep` with no match exits 1, and the shell-free grep already reports that as a failure through `exitFailure`.

## Global Constraints

- Never force-push or amend. Commit messages and PR bodies go in a file and are passed with `-F`.
- Run `make` after any `.agency` edit and commit the regenerated `docs/site/stdlib/safeBash.md` and `docs/site/stdlib/safeBash/actions.md`. Never hand-edit `docs/site`.
- `pnpm run typecheck` and `pnpm run lint:structure` after every edit; prettier on any `.ts` file you touch, never `pnpm run fmt:ts` from the main checkout.
- Save test output to a file and read it. Run only `pnpm run agency test tests/agency/safeBash.agency` and the vitest files named here, not the suite.
- Every executor keeps calling `_read`, `_grep`, `_write` (the non-raising internals), never `read`, `grep`, `write`, for the reason `runBash`'s comment gives: the only path to an executor runs through a `raiseAll` that raised every effect in the plan.
- Dev docs state the mechanism and the rule, with no history or dates.
- Agency: no lambdas; an `isFailure` guard does not narrow a `Result` over a union (match on it through a helper def); `!=` on a tag does not narrow (use `is`); a match arm value cannot hold an if-else, so put it in a def; build a record copy field by field, not with spread.
- `.claude/skills/agency-stdlib-docs/SKILL.md` is tracked but gitignored: `git add -f` it in its own command.
- Use objects, arrays, and types; never maps, sets, or interfaces.

## Review Focus

1. `cat one.txt noeol.txt`, where the first file has no final newline. Expected: the second file's first line joins the first file's last line, as real `cat` prints. Parity row in Task 1.
2. `a && (b || c)` where every command is in-process. Expected: bash skips the whole group when `a` fails; a flat chain would run `c`. The chain planner refuses a `Parens`, so the line takes today's path. Test in Task 2.
3. `grep nomatch one.txt && echo yes` and `grep nomatch one.txt || echo no`. Expected: the first prints nothing and fails with exit 1; the second prints `no` and succeeds. Tests in Task 2.
4. `cat a.txt && rm a.txt`. Expected: still refused at the wall; the chain planner must not become a way around it. Test in Task 2.
5. `echo hi > out.txt; cat out.txt` when `out.txt` does not exist before the run. Expected: `cat` is refused at plan time (a missing file is never a read), so the line is broad; the plan does not pretend to know what the write will leave. Test in Task 2.

---

### Task 1: A lone `cat` of several files runs in process (ADI-264)

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`ReadExec`, `readExecution`, `runRead`)
- Modify: `stdlib/safeBash.agency` (`shellFreeReadPlan`, `readViewFor`)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`
- Modify: `docs/dev/stdlib/safe-bash.md`

**Interfaces:**
- Produces: `ReadExec = { kind: "read"; payloads: ReadPayload[]; view: ReadView }` and `readExecution(payloads: ReadPayload[], view: ReadView): ReadExec`.
- Path counts stay in `READ_VERBS`, which already gives `head` and `tail` at most one path (`AT_MOST_ONE`) and refuses `head a b` in `readFileVerb` before any shell-free code sees it; `shellFreeReadOf`'s `stdin` arm already refuses a read with no path. So the only change `shellFreeReadPlan` needs is to delete its `paths.length != 1` check. `SHELL_FREE_READ_VERBS` stays as it is. No second table, and no second message to keep in step.
- Produces: in `readViewFor`, beside the count-of-0 rule, a rule that the `numbered` view takes one file: `cat -n a b` is refused shell-free with `"cat -n of several files is refused shell-free"`. GNU `cat -n` numbers the two files as one stream (1 to 4), BSD starts again at 1 for each file (checked on this Mac: `cat -n noeol.txt one.txt` prints `1, 2, 1, 2, 3`), so no one rendering is right everywhere. `readViewFor` needs the path count for this; pass `paths.length`.
- Produces: `runRead(exec: ReadExec, command: string): Result<string>` reads each payload with `_read` in order, joins the texts, renders the joined text once with `_renderReadView`, and wraps with `keepOutput`. With only the `whole` view allowed for several files, the joined text is what plain `cat` prints, including a first file with no final newline running into the second. When a read fails, the result is `_read`'s own failure, as it is for one file today, and the text already read is dropped. A failure here means a file went missing or unreadable between planning and running, since the plan refused a missing file. Real `cat a b` would have printed `a` before complaining about `b`; that difference goes in the dev doc's left-out list.
- Produces (used by Task 2): `printRead(exec: ReadExec): Result<string>`, the raw text before `keepOutput`, with the same failure rule; `runRead` is `printRead` plus `keepOutput`.

- [ ] **Step 1: Write the failing tests**

In `loneReadIsShellFree`, the `cat one.txt two.txt` row changes from `narrow` to `shellFree`. Add rows `head one.txt two.txt` (`broad`: `READ_VERBS` gives head one path) and `cat -n one.txt two.txt` (`narrow`: numbered, several files).

In `shellFreeReadMatchesRealTools` add (the helper is `exactParityOf(source, kind, cwd)` after the bash plan):

```agency
    exactParityOf("cat one.txt noeol.txt", "read", READ_FIXTURES),
    exactParityOf("cat noeol.txt one.txt", "read", READ_FIXTURES),
    exactParityOf("cat empty.txt one.txt", "read", READ_FIXTURES),
    exactParityOf("cat one.txt one.txt", "read", READ_FIXTURES),
```

Add a node:

```agency
node catOfTwoFilesAsksTwoQuestions() {
  // Two std::read approvals, one per file, and no shell. The plan's kind
  // comes first, because the bash path asks the same two questions and
  // prints the same text; only the kind tells the two apart.
  const kind = planFor("cat one.txt two.txt", FIXTURES).execution.kind
  const result = safeBash("cat one.txt two.txt", cwd: FIXTURES)
  if (result is failure(why)) {
    return "FAILED: ${why}"
  }
  return [kind, result.value]
}
```

with two approve handlers for "Are you sure you want to read this file?" in the `.test.json`, expecting `["read", <the two fixture files joined>]` (read them to write it).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run agency test tests/agency/safeBash.agency > $SCRATCH/t1.txt 2>&1`, then grep it for the three nodes. Expected: the outcome row says `narrow`; the parity rows say `NOT SHELL-FREE`; the two-question node returns `"bash"` as its kind.

- [ ] **Step 3: Implement**

The interface items: `ReadExec.payloads`, the one-file rule for the numbered view, the deleted length check in `shellFreeReadPlan`, and `printRead` with `runRead` over it. The numbered-view message is internal: a failed shell-free plan falls through to the general rules.

- [ ] **Step 4: `make`, run, verify pass**

`make > $SCRATCH/make1.txt 2>&1`, then the agency test. Expected: all pass. `pnpm vitest run lib/stdlibCapabilities.test.ts` passes.

- [ ] **Step 5: Dev doc**

"A lone cat, head, or tail runs the read tool's read": the first sentence covers `cat` of any number of files and `head`/`tail` of one, with the header reason. Beside the count-of-0 sentence, one on `cat -n` of several files: GNU numbers them as one stream and BSD starts over per file. The "These are left out" list loses "More than one file in process" and gains "`head` and `tail` of more than one file: each prints a header per file", "`cat -n` of more than one file", and "the text of the files before one that failed to read: real `cat` prints them, the shell-free read returns the failure alone". The `READ_TOOL_FOR_VERB` comment and the "In process when it translates" table need no change.

- [ ] **Step 6: Commit**

```bash
git add stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json docs/dev/stdlib/safe-bash.md docs/site/stdlib
git commit -F $SCRATCH/c1.txt
```

Message: `safeBash: a lone cat of several files runs in process`.

---

### Task 2: A chain of in-process commands runs in process (ADI-262)

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`Execution`, new `ChainExec`, `ChainStep`, `StepExec`, `printGrep`, `runChain`)
- Modify: `stdlib/safeBash.agency` (`planFor`, new `tryShellFreeChain`, `chainLinks`, `linksOf`, `tryShellFreeStep`, `stepExecOf`, `outcomeOf`, `safeBash` dispatch)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`
- Modify: `docs/dev/stdlib/safe-bash.md`, the spec's Part 5 departures, `CLAUDE.md`, `.claude/skills/agency-stdlib-docs/SKILL.md`

**Interfaces:**

In `actions.agency`:

```agency
/** How a chain step follows the one before it: `;` always runs it, `&&`
 * only after a success, `||` only after a failure. */
export type Join = "seq" | "and" | "or"

/** The executions a chain may hold: every in-process kind, and nothing
 * that spawns a shell. */
export type StepExec = EchoExec | WriteExec | GrepExec | ReadExec

export type ChainStep = {
  join: Join;
  execution: StepExec
}

/** Several in-process commands joined by `;`, `&&`, or `||`, run left to
 * right with bash's rule for each join. */
export type ChainExec = {
  kind: "chain";
  steps: ChainStep[]
}
```

`Execution` gains `ChainExec`. `printGrep(exec: GrepExec): Result<string>` is `runGrep` without `keepOutput`: the rendered matches plus notes on success, and on no match a failure carrying the notes (read `runGrep`: it returns `exitFailure(command, 1, "", notes, command)`; `printGrep` returns `failure(notes)` and `runGrep` keeps its `exitFailure`). `printRead` is from Task 1.

```agency
@capabilities(fileRead, fileWrite)
export def runChain(exec: ChainExec, command: string): Result<string>
```

Folds over `exec.steps` with `let out = ""`, `let ok = true`, `let lastError = ""`. For each step: skip when `join == "and" && !ok` or `join == "or" && ok`; otherwise run it through `printStep(step.execution): Result<string>` (a match over `StepExec`: echo gives `success(content)`; write gives `runWrite(exec)`; grep `printGrep`; read `printRead`), append the value to `out` on success and set `ok = true`, or set `ok = false` and `lastError = why` on failure. After the loop: `ok` false gives `exitFailure(command, 1, out, lastError, command)`; otherwise `success(keepOutput(out, 0, command))`. A failed step contributes nothing to `out`, the way a failing program's stdout is empty and its complaint goes to stderr.

A write step runs inside a `destructive { }` region of `runChain`'s own. `runWrite` enters one, but that marks `runWrite`'s activation, and a failure built later by `runChain` (`echo started >> log.txt; grep zzz one.txt`: the write happens, the grep finds nothing) would leave `runChain` with `destructiveRan: false`, which the tool loop reads as "nothing happened yet" and may retry, appending `started` twice. Read `docs/dev/language/destructive-regions.md` before writing this. The region wraps the one `printStep` call for a write step; the other kinds stay outside it.

In `safeBash.agency`:

```agency
/** One command of a chain and how it follows the one before. */
type ChainLink = {
  join: Join;
  command: SimpleCommand
}

def chainLinks(commands: Command[]): Result<ChainLink[]>
```

The top-level list joins with `"seq"`; `linksOf(command: Command, join: Join): Result<ChainLink[]>` matches: a `simpleCommand` is one link; `and` is `linksOf(left, join)` followed by `linksOf(right, "and")`; `or` the same with `"or"`; `parens` and `pipeline` are failures (`"a parenthesized group is not run in process"`, `"a pipeline is not run in process"`). Because the parser is left-associative, this flat list with per-link joins gives the same order bash uses for `a && b || c`.

This is a second walk over the tree beside `flattenOne`, on purpose: `flattenOne` feeds the refuse wall, so it must see through parentheses and pipelines, while the chain must stop at them. Making one walk answer both questions would give the wall a reason to skip a node. Say this in a comment on `linksOf`.

```agency
def tryShellFreeStep(command: SimpleCommand, cwd: string): Result<Plan>
```

Tries `trySeeIfShellFree`, `tryShellFreeGrep`, `tryShellFreeRead` in that order and returns the first success; not `tryAgencyPlan`. This is the one list of in-process planners: `planFor`'s single-command block today spells the same three out after `tryAgencyPlan`, so change that block to `tryAgencyPlan` then `tryShellFreeStep`, and a planner added later is added in one place. It returns a `Plan`, because the lone-command path uses it as one.

```agency
def stepExecOf(exec: Execution): Result<StepExec>
```

The narrowing lives here, called from `tryShellFreeChain` on each step plan's `execution`, not in `tryShellFreeStep` (where the lone-command path would have to undo it). A match over `Execution` that is exhaustive with no `_` arm: the four step kinds return the step, and every other kind (`bash`, `agency`, `refuse`, `chain`) returns a failure, so a future in-process kind is a type error until someone decides whether chains may hold it.

```agency
def tryShellFreeChain(commands: Command[], cwd: string): Result<Plan>
```

Fails unless `chainLinks` succeeds and there are at least two links. Runs `tryShellFreeStep` then `stepExecOf` on every link; any failure is the chain's failure. Builds `ChainExec` from the steps, `effects` as the concatenation of every step plan's effects, `broadReason: null`, `verbs: verbNames(the commands)`. `planFor` calls it after the single-command block and before `flattenCommands`; a success is returned as the plan.

`outcomeOf`: `"chain" => "shellFree"`. `safeBash`'s dispatch: `{ kind: "chain" } => runChain(exec, command)`.

The refuse wall: the step planners accept only `echo`, `grep`, `cat`, `head`, and `tail`, none of which the wall names, and a chain with any other command falls through to the general path where `isRefused` runs on every command. Task 2's test pins `cat a.txt && rm a.txt` as refused so this stays true.

Effects may be empty. A chain of nothing but echoes raises nothing, the way a lone echo raises nothing: the audit rule in `bashPlan` is about shell spawns, and the chain spawns none. Say this in the dev doc.

- [ ] **Step 1: Write the failing tests**

New nodes in `tests/agency/safeBash.agency`, planning in `FIXTURES`:

```agency
def chainSummary(source: string): any {
  const plan = planFor(source, FIXTURES)
  return [outcomeOf(plan), plan.execution.kind, [e.name for e in plan.effects]]
}

node chainsOfInProcessCommands() {
  return [
    chainSummary("echo a; echo b"),
    chainSummary("echo \"=== one ===\"; cat one.txt; echo; echo \"=== two ===\"; cat two.txt"),
    chainSummary("cat one.txt && cat two.txt"),
    chainSummary("grep hello one.txt || echo none"),
    chainSummary("echo a && echo b || echo c"),
    chainSummary("echo a; git status"),
    chainSummary("echo a; true"),
    chainSummary("echo a && (echo b || echo c)"),
    chainSummary("echo a; cat one.txt | head"),
    chainSummary("cat nope.txt; echo hi"),
    chainSummary("echo hi > out.txt; cat out.txt"),
    chainSummary("cat one.txt && rm one.txt"),
    chainSummary("echo a; agency --version"),
  ]
}
```

Expected, row by row: `["shellFree","chain",[]]`; `["shellFree","chain",["std::read","std::read"]]`; `["shellFree","chain",["std::read","std::read"]]`; `["shellFree","chain",["std::grep"]]`; `["shellFree","chain",[]]`; `["narrow","bash",["std::git::status"]]`; `["broad","bash",["std::bash"]]`; `["broad","bash",["std::bash"]]` (the parens row: today's path, every command recognized, no effects, so the audit rule asks `std::bash`); `["narrow","bash",["std::read"]]` (the pipeline row takes today's path too, where `cat one.txt` adds `std::read` and `head` with no path after a pipe adds nothing); `["broad","bash",["std::bash"]]` (missing file); `["broad","bash",["std::bash"]]` (`out.txt` missing at plan time); `["refuse","refuse",[]]`; `["broad","bash",["std::bash"]]` (`agency` is not a step).

Parity, through the `exactParityOf(source, kind, cwd)` helper the bash plan generalized (it compares the whole output exactly, which is right here because every grep names one file, so no skipped-folders note appears):

```agency
node chainMatchesBash() {
  return [
    exactParityOf("echo \"=== one ===\"; cat one.txt; echo; echo \"=== two ===\"; cat two.txt", "chain", FIXTURES),
    exactParityOf("cat one.txt && echo done", "chain", FIXTURES),
    exactParityOf("grep hello one.txt || echo none", "chain", FIXTURES),
    exactParityOf("grep zzz one.txt || echo none", "chain", FIXTURES),
    exactParityOf("echo a && echo b || echo c", "chain", FIXTURES),
    exactParityOf("cat -n one.txt; cat -n two.txt", "chain", FIXTURES),
  ]
}
```

Expected: all `true`. (`exactParityOf` returns `"FAILED: ..."` when `safeBash` fails, a fix the bash plan made while renaming it, so a row cannot pass by comparing an empty failure with empty output.)

The write region, in a scratch folder of its own (the pattern of `LINK_FIXTURE`: `remove`, `mkdir`, copy `one.txt` in with `bash` under `with approve`, work, `remove`):

```agency
node chainFailureAfterAWriteIsDestructive() {
  // The write ran, then the grep found nothing. The failure must say a
  // destructive step ran, or the tool loop may retry and write twice.
  const after = safeBash("echo hi > out.txt; grep zzz one.txt", cwd: CHAIN_FIXTURE)
  // Here the grep fails first and && skips the write, so nothing ran.
  const before = safeBash("grep zzz one.txt && echo hi > out.txt", cwd: CHAIN_FIXTURE)
  return [destructiveFlag(after), destructiveFlag(before)]
}
```

where `destructiveFlag(result)` returns `result.destructiveRan` for a failure (see `tests/agency/destructive-block.agency:12` for the field) and `"UNEXPECTEDLY SUCCEEDED"` otherwise. Expected `[true, false]`, with the `.test.json` approving `std::write` and `std::grep` as many times as the two lines ask.

Exit status (`FIXTURES` is the grep fixtures folder; `one.txt` holds `hello world` on its first line and no `zzz`):

```agency
node chainFailsLikeBash() {
  // grep with no match exits 1, so && skips the echo and the chain fails;
  // || runs it and the chain succeeds. Approved by the test file.
  const skipped = safeBash("grep zzz one.txt && echo yes", cwd: FIXTURES)
  const ran = safeBash("grep zzz one.txt || echo no", cwd: FIXTURES)
  return [skipped is failure, ran]
}
```

Expected `[true, {"success":true,"value":"no\n"}]` in whatever shape a `Result` serializes to in a neighboring row; the `.test.json` approves `std::grep` twice ("Are you sure you want to search files with grep?").

The owner's line end to end, with two `std::read` approvals, returning the output: `chainOfReadsAsksOnlyTheReads`. Expected value is the exact text; copy it from the parity row's `theirs` on a first run if needed, after confirming it is what `bash` printed.

Rows that change meaning: `wholeStringPlans` has `echo hi; echo bye` expecting `["bash",["std::bash"]]`; it becomes `["chain",[]]`. `shellFreeEcho` has `echo hi; echo bye` expecting bash; it becomes `["chain","",[]]` (its `content` is only read for `echo`). Four other rows use such strings to prove something about the bash path, so each gets a string the chain planner refuses for a reason that keeps the plan on the same path:

- `planReasons` has `echo hi; echo bye` expecting `["noEffects",""]`, and `planOutcomes` has it expecting `"broad"`. These are the only rows that pin the `noEffects` reason and an all-echo line's `broad` outcome. Both become `echo hi | cat`: recognized, no effects, and a pipeline, so the reason stays `noEffects` and the outcome `broad`.
- `rejectedAuditSaysWhy` uses `echo hi; echo bye` to get the `noEffects` sentence. Same swap, `echo hi | cat`.
- `sequenceRunsThroughBash` uses `echo hi && echo bye` to show a sequence runs in one bash call and prints what bash prints. A pipe is not a sequence, so use `echo hi && echo bye && true`: `true` has no rule, the line stays broad, runs through bash, and prints `hi\nbye\n`.
- `echoIsTheSameAloneAndInAChain`, from the bash plan, already ends its chain with `; true` for this reason. Check that it does; if the bash plan was executed from an earlier revision, add the `true` here.

Grep the test file for any other string made only of echoes, greps, and lone reads joined by `;`, `&&`, or `||`, whatever its row expects, and record each swap in the ledger with the old and new string.

- [ ] **Step 2: Run to verify they fail**

The agency test into `$SCRATCH/t2.txt`. Expected: the new nodes fail (kind is `bash`, parity rows say `NOT SHELL-FREE`), and the rows that change meaning still pass with their old values.

- [ ] **Step 3: Implement**

The interfaces above. Keep `tryShellFreeChain` and its helpers next to `tryShellFreeRead`. `runChain` and `printStep` in `actions.agency` beside `runRead`.

- [ ] **Step 4: `make`, run, verify pass**

`make`, then the agency test. Expected: all pass, including the swapped rows. `pnpm vitest run lib/stdlibCapabilities.test.ts` passes.

- [ ] **Step 5: Docs**

`docs/dev/stdlib/safe-bash.md`:

- "Outcomes", `shellFree`: add "A chain of such commands joined by `;`, `&&`, or `||` runs them in process in order (see "Chains in process")."
- "In process when it translates": the rule's first sentence becomes "A lone command, or a chain of them, whose flags and arguments translate exactly runs the matching stdlib tools in process." Add a table row: `echo "== a =="; cat a.txt` runs `_read` and the echo in process, raises `std::read`.
- New section "Chains in process" after "The read family": what a chain is (the top-level list and `And`/`Or` nodes, flattened to links with a join each, left to right); which commands may be steps (the three lone planners, not `agency`); why a `Parens` or a `Pipeline` is refused (`a && (b || c)` skips the group as a whole; a pipeline is ADI-261); the all-or-nothing rule (one refused command sends the whole line down the bash path, where the wall runs); the run rule (bash's `;`, `&&`, `||`, status of the last command run, a failed step adds no text); why a write step runs in a `destructive` region of `runChain`'s own, and that the region is entered before `_write` runs, so a write that fails before writing anything still reports `destructiveRan: true`, which is the safe direction; why effects may be empty (no shell spawns); that a shell-free directory grep's skipped-folders note lands in the chain's output where that step's text goes, so `grep -rn TODO src; echo done` prints the note before `done`, which real bash would not; and the plan-to-run gap: a write step changes a file a later read step reads, and each read was resolved at plan time, so `echo x > f; cat f` with `f` present reads whatever the write left, under a `std::read` that named `f`. Point at "Resolving the path when the plan is made".
- "Why the executors call `_bash`, `_write`, `_grep`, and `_read`": add `runChain` to the list of executors that reach them.
- "Files and tests": the new nodes.

Spec Part 5, under "Departures for the read family (ADI-244)", add a bullet: "A chain of in-process commands joined by `;`, `&&`, or `||` runs in process (ADI-262); a parenthesized group or a pipeline in the chain sends the line through bash."

`CLAUDE.md` and `.claude/skills/agency-stdlib-docs/SKILL.md`: the `safe-bash.md` line gains "chains of in-process commands and bash's join rule" (the skill file with `git add -f`, alone).

- [ ] **Step 6: Commit**

```bash
git add stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json docs/dev/stdlib/safe-bash.md docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md CLAUDE.md docs/site/stdlib
git commit -F $SCRATCH/c2.txt
git add -f .claude/skills/agency-stdlib-docs/SKILL.md
git commit -F $SCRATCH/c2b.txt
```

Messages: `safeBash: a chain of in-process commands runs in process` and `docs index: the chain section`.

---

### Task 3: Checks and PR

- [ ] **Step 1:** `pnpm run typecheck`, `pnpm run lint:structure`, `pnpm vitest run lib/stdlibCapabilities.test.ts lib/stdlib/readDialect.test.ts`, and the safeBash agency test, each saved to a file and green.
- [ ] **Step 2:** Push and open the PR with the body in a file: a before/after table (`cat a.txt b.txt`; `cat -n a.txt b.txt`; the owner's five-command line; `grep x f || echo none`; `a && (b || c)`; `echo a; cat a.txt | head`), where to look (`readViewFor`'s one-file rule for `-n`, `chainLinks`, `stepExecOf`, `runChain` and its write region), departures from this plan if any, what is left out (pipelines, ADI-261; `agency` as a step; a write step whose target a later read reads is planned against the file as it was; the bash path has the same `destructiveRan` gap for `echo hi >> f && false`, which is a ticket to file, not this PR). Link ADI-264 and ADI-262. End with the attribution line. The owner merges.
