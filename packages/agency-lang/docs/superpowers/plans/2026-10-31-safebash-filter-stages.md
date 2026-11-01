# safeBash: a `grep` at the end of a pipe reads only its stdin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Paths are relative to `packages/agency-lang`.

**Goal:** In `git log | grep fix`, grep searches git's output and reads no file. Such a stage needs no `std::grep` question, so the whole line can ask only the git question. Today this line is unrecognized, because a `grep` with no path and no `-r` is unrecognized wherever it appears. This plan teaches safeBash which commands read their stdin from a pipe, so a `grep` with no path in one of those positions contributes no effect.

**Background: what stdin is here.** A command in a pipe reads the previous command's output on its standard input ("stdin"). `grep fix` with no file named searches its stdin. As the first command on a line, its stdin is empty, because safeBash closes the shell's stdin (`_bash` is called with `stdin: ""`, which leaves the child's input unset, and `lib/host/node/nodeSubprocess.ts:134-137` ends the stdin pipe at once). It reads no file, but the line does nothing useful, so it stays unrecognized. As the second or later stage of a pipe, its stdin is the previous stage's output, so it reads no file.

**The rule above all others:** the same rule as the grep work (ADI-242). If there is any doubt about what a command reads, the line is unrecognized and asks `std::bash`.

**Architecture.** Two small pieces, each with one job.

1. **Where a command sits.** The walk that flattens a parsed line into simple commands (`flattenCommands` and `flattenOne` in `stdlib/safeBash.agency`) returns, with each command, whether it reads its stdin from a pipe. `planFor` passes that to `effectsFor`.
2. **What a command reads.** A verb's rule says what the command reads and nothing about where it sits. For grep, `readGrep` returns one of two answers: "it searches this path", or "it names no path and reads its stdin". The verb rule never sees the pipe flag.

One helper joins the two: `stdinStage(verb, readsStdin, redirects)`. A command that reads its stdin contributes only its redirects when it is fed by a pipe, and is unrecognized otherwise. This is the only place the pipe flag is read. ADI-244's `head`, `tail`, `wc`, and `cat` filters call the same helper, so adding a filter verb means writing its "reads stdin" answer and nothing else.

For grep, the missing-path rule in `searchHere` keeps this order:

1. `-r` is present: the path is `.`. grep searches the working directory even when it is fed by a pipe. With ugrep it reads both. This check comes first, because a pipe does not stop `-r` from reading files. `.` is a directory, so the bash path then asks `std::bash`, as ADI-242 decided.
2. No `-r`: the command reads its stdin. `stdinStage` then decides from the pipe flag.

A lone `grep` with no path asks `std::bash`, as today. The shell-free path (`tryShellFreeGrep`) gets the "reads stdin" answer and returns a failure, so the general rules decide, and they reach `stdinStage` with `readsStdin: false`.

A grep in a pipe still goes through `splitFlags` with `GREP_FLAGS`, so an unknown or dangerous flag (`--filter`, `-R`) is still unrecognized, and so is a flag after the pattern. In a pipe stage the first positional is the pattern, so `git log | grep fix -i` would make BSD grep read a file named `-i`, and it stays broad. Its redirects still contribute `std::write`.

**Which greps the stdin claim was checked against.** A grep with no path and no `-r` reads only its stdin when stdin is a pipe. That holds for GNU grep, BSD grep (macOS's `/usr/bin/grep`), and ugrep. ugrep switches to a recursive search only when stdin is a terminal, which a pipe never is.

**Depends on:** ADI-242, merged as PR #1319. It wrote `readGrep`, `searchHere`, and `grepEffects`, which this plan changes.

**Where it fits in ADI-244.** ADI-244 is "file reads (cat, head, tail, wc, diff) raise std::read; filters as pipeline stages". This plan is its first half: the pipe flag, `stdinStage`, and grep as a filter. Until the second half lands, the only lines this plan narrows are `git status`, `git log`, or `git diff` piped into a `grep`. The second half (`cat a.txt | grep x`, `git log | head -20`) needs its own plan, and it reuses `FlatCommand.readsStdin` and `stdinStage`.

**Review this plan answers:** `docs/superpowers/plans/2026-10-31-safebash-filter-stages-REVIEW.md`.

**Spec:** `docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 4 (pipelines: "a read verb with no path argument is allowed as any stage but the first, because there it reads its stdin").

## Global Constraints

- Nothing new runs. A filter stage contributes no effect, and the line still runs as one bash call of the rebuilt text.
- A grep in a pipe is decided by the same flag table as any other `grep`. Only the missing-path rule changes.
- `verbNames` keeps its signature. Every other call site already passes a one-element list, `verbNames([command])`. `planFor` names the flattened list `flat` and calls `verbNames([entry.command for entry in flat])`.
- `effectsFor` is exported, and `tests/agency/safeBash.agency` calls it with two arguments. Give the new parameter a default, `readsStdin: boolean = false`, so that caller does not change.
- Test helpers that need unexported functions use `import test { ... } from "std::safeBash"`. Add names to the existing `import test { splitFlags }` line. Do not export anything only for tests. An exported function that reaches `_bashParser` fails `lib/stdlibCapabilities.test.ts` unless it is put on the allow list.
- `make` after `.agency` changes; `pnpm run typecheck`, `pnpm run lint:structure`; absolute paths inside any script; never force-push.

## Review Focus

- `git status | grep -rn hello`: `-r` wins, so this grep searches the working directory through bash, and the line asks `std::bash`. A plan with only the git effect here would let grep read the whole tree under an approval for `git status`.
- `git status | grep hello && grep bye`: the second `grep` is not in the pipe and reads the shell's own stdin, so the line is unrecognized.
- `(git status | grep a) | grep b`: the group is the first stage of the outer pipe. `git status` reads nothing, and `grep a` and `grep b` read pipes.
- `git status | grep hello one.txt`: a path wins over stdin. grep reads `one.txt` and ignores the pipe, so the stage raises `std::grep` for the file.

---

### Task 1: Each flattened command says whether it reads a pipe

**Files:**
- Modify: `stdlib/safeBash.agency` (`flattenOne`, `flattenCommands`, a new `pipelineCommands`, and `planFor`'s loop)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Produces: `type FlatCommand = { command: SimpleCommand; readsStdin: boolean }`. It is not named `Stage`, because `PipelineStage` already names a parsed pipe stage, and the two mean different things.
- `flattenCommands(commands: Command[]): FlatCommand[]` and `flattenOne(command: Command): FlatCommand[]`.
  - A simple command gives `[{ command: command, readsStdin: false }]`.
  - `and`, `or`, and `parens` concatenate, as they do today.
  - The `pipeline` arm calls `pipelineCommands(stages)`.
- `planFor` loops over the flat commands (`for (entry in flat)`). It passes `entry.command` to `isRefused`, and `entry.command, cwd, entry.readsStdin` to `effectsFor`.
- `effectsFor(command: SimpleCommand, cwd: string, readsStdin: boolean = false)`. Task 1 only adds the parameter. Task 2 uses it.

The pipeline arm, so the flag is set in one place:

```
/** A pipe's commands: the first stage as it is, and every command in a
 * later stage marked as reading the pipe. In `a | (b && c)`, both `b`
 * and `c` read it, because the group's stdin is the pipe. */
def pipelineCommands(stages: PipelineStage[]): FlatCommand[] {
  let out: FlatCommand[] = flattenOne(stages[0])
  for (stage in stages.slice(1)) {
    const fed = [{ command: flat.command, readsStdin: true } for flat in flattenOne(stage)]
    out = [...out, ...fed]
  }
  return out
}
```

Keep `flattenOne`'s match exhaustive with no catch-all, and keep its comment. It feeds the refuse wall, where an empty result must never happen.

- [ ] **Step 1: Write the failing test**

Add `flattenCommands` to the existing `import test { splitFlags } from "std::safeBash"` line, then:

```
def stdinFlags(source: string): any {
  const parsed = bashParser(source)
  if (parsed is failure(why)) {
    return "UNPARSEABLE"
  }
  const flat = flattenCommands(parsed.value)
  return [entry.readsStdin for entry in flat]
}

node stagesReadStdin() {
  return [
    stdinFlags("git status"),
    stdinFlags("a | b | c"),
    stdinFlags("a | b && c"),
    stdinFlags("(a | b) | c"),
    stdinFlags("a; b | c"),
    stdinFlags("a | (b && c)"),
  ]
}
```

`expectedOutput`: `[[false],[false,true,true],[false,true,false],[false,true,true],[false,false,true],[false,true,true]]`

- [ ] **Step 2: Run to see it fail**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/filter-t1-red.txt 2>&1; grep -n "stagesReadStdin" -A4 /tmp/filter-t1-red.txt | head`

- [ ] **Step 3: Implement**, then `make` and run the file. Every existing node must still pass.

Run: `make > /tmp/filter-make1.txt 2>&1; tail -2 /tmp/filter-make1.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/filter-t1.txt 2>&1; tail -3 /tmp/filter-t1.txt`

- [ ] **Step 4: Commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: each flattened command says whether it reads a pipe"
```

---

### Task 2: A `grep` with no path in a pipe stage is a filter

**Files:**
- Modify: `stdlib/safeBash.agency` (`readGrep`, `searchHere`, `grepEffects`, `tryShellFreeGrep`, the `effectsFor` grep arm, and a new `stdinStage`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

```
/** What a grep command reads: the path it names (or `.` with -r), or
 * its stdin when it names no path. */
type GrepRead = { kind: "stdin" } | { kind: "search"; call: GrepCall }
```

- `readGrep(command, cwd, spec): Result<GrepRead>`. Its signature otherwise stays the same, and it takes no pipe flag. `GrepCall.target` stays non-null. The review also offered a nullable `target`; a separate answer type is used because it keeps every user of `GrepCall` free of null checks, and it keeps the pipe flag out of the grep code.
- `searchHere` keeps the `-r` check first. With `-r` it returns `{ kind: "search", call }` for `.`. Without `-r` it returns `success({ kind: "stdin" })` in place of today's failure.
- The grep arm of `effectsFor` asks `readGrep` what the command reads, then hands each answer to the function that owns it:

```
"grep" => {
  const read = readGrep(command, cwd, GREP_FLAGS)
  if (isFailure(read)) {
    return read
  }
  return match(read.value) {
    { kind: "stdin" } => stdinStage("grep", readsStdin, redirect.value)
    { kind: "search", call } => grepSearchEffects(call, redirect.value)
  }
}
```

  `grepSearchEffects(call: GrepCall, redirects: Effect[]): Result<Effect[]>` is today's `grepEffects` body after its `readGrep` call: a directory fails with the existing message, and a file asks `std::grep`, with the redirects appended. It replaces `grepEffects`, which has no other caller.

- The one helper that reads the pipe flag:

```
def stdinStage(verb: string, readsStdin: boolean, redirects: Effect[]): Result<Effect[]> {
  """
  A command that names no file and reads its stdin. Fed by a pipe, it
  reads only the previous command's output, so it adds nothing beyond its
  redirects. Anywhere else its stdin is safeBash's closed one, so the
  command does nothing useful and stays unrecognized.
  """
  if (readsStdin) {
    return success(redirects)
  }
  return failure("${verb} with no path reads stdin")
}
```

  For grep, the failure text is the same as today's (`grep with no path reads stdin`), so the existing `grepUnrecognized` row for a lone `grep hello` keeps its expected output.

- `tryShellFreeGrep` matches on `readGrep`'s answer. `{ kind: "stdin" }` is a failure ("a lone grep with no path reads stdin"). The general rules then decide, and they reach `stdinStage` with `readsStdin: false`. `{ kind: "search", call }` continues as today.
- In `tryShellFreeGrep`, fix the comment above the `_ignoredFromAbove` check and its failure message. Both still describe the earlier rule ("where they reach into it", "git ignores files in this directory"). The rule since a85c562ea is that the .gitignore files above ignore everything in the directory. Say so: "git ignores everything in this directory, so the grep tool's search would find nothing". No test pins that message, because `planFor` drops a failure from `tryShellFreeGrep`.

- [ ] **Step 1: Write the failing test**

```
node grepFilterStages() {
  return [
    grepNames("git status | grep hello"),
    grepNames("git status | grep -v hello | grep -c x"),
    grepNames("git status | grep -rn hello"),
    grepNames("git status | grep hello one.txt"),
    grepNames("git status | grep hello > out.txt"),
    grepNames("git status | grep hello && grep bye"),
    grepNames("git status | grep -R hello"),
    grepNames("echo hi | grep h"),
    grepNames("git status | grep hello -i"),
    grepNames("git status | grep -e hello"),
  ]
}
```

`expectedOutput`, row by row:

1. `[["std::git::status"],null]`
2. `[["std::git::status"],null]`
3. `[["std::bash"],{"kind":"unrecognized","detail":"grep through bash would search a directory, and reads files the grep tool skips"}]`
4. `[["std::git::status","std::grep"],null]`
5. `[["std::git::status","std::write"],null]`
6. `[["std::bash"],{"kind":"unrecognized","detail":"grep with no path reads stdin"}]`
7. ``[["std::bash"],{"kind":"unrecognized","detail":"grep does not take `-R`"}]``
8. `[["std::bash"],{"kind":"noEffects","detail":""}]`. Every command was recognized and none raised anything, so the audit rule asks `std::bash`.
9. `[["std::bash"],{"kind":"unrecognized","detail":"an option after the first argument is a file name to some versions of grep"}]`
10. `[["std::git::status"],null]`. With `-e`, there is no positional at all, which is the second way into the filter rule.

`grepUnrecognized` has the row `git status | grep hello`. Remove it from that node and its expected output, because this plan recognizes it. Row 1 above covers it.

- [ ] **Step 2: Run to see it fail.** Rows 1, 2, 5, and 10 come back as `std::bash` with `grep with no path reads stdin`.

- [ ] **Step 3: Implement** the interfaces above. The `-r` check in `searchHere` stays first.

- [ ] **Step 4: `make`; run; commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: a grep with no path in a pipe stage is a filter"
```

---

### Task 3: Docs and checks

- [ ] `docs/dev/stdlib/safe-bash.md`: in the grep section, add the missing-path order and the reason `-r` comes first, with the `git status | grep -rn hello` example. Add a short section, "Stages that read a pipe", describing `FlatCommand.readsStdin` and `stdinStage`: a verb rule says only what a command reads, and `stdinStage` is the one place that reads the pipe flag. ADI-244's filters use both.
- [ ] In the same section, say which greps the stdin claim was checked against (GNU, BSD, ugrep), as the Architecture section does.
- [ ] Run `pnpm run typecheck`, `pnpm run lint:structure`, and `pnpm vitest run lib/stdlibCapabilities.test.ts`, each saved to a file. Run `/anti-pattern-check` on the diff. Open the PR against `main` with the body in a file. The owner merges.
