# safeBash: a `grep` at the end of a pipe reads only its stdin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In `git log | grep fix`, grep searches git's output and reads no file. Such a stage needs no `std::grep` question, so the whole line can ask only the git question. After the grep plan, this line is unrecognized, because a `grep` with no path and no `-r` is unrecognized wherever it appears. This plan teaches safeBash which pipeline stages read their stdin, so a `grep` with no path in one of those stages contributes no effect.

**Background: what stdin is here.** A command in a pipe reads the previous command's output on its standard input ("stdin"). `grep fix` with no file named searches its stdin. As the first command on a line, its stdin is empty, because safeBash closes the shell's stdin (`_bash` is called with `stdin: ""`, which leaves the child's input unset, and `lib/host/node/nodeSubprocess.ts:134-137` ends the stdin pipe at once). It reads no file, but the line does nothing useful, so it stays unrecognized. As the second or later stage of a pipe, its stdin is the previous stage's output, so it reads no file.

**The rule above all others:** the same rule as the grep plan. If there is any doubt about what a stage reads, the line is unrecognized and asks `std::bash`.

**Architecture:** The walk that flattens a parsed line into simple commands (`flattenCommands` and `flattenOne` in `stdlib/safeBash.agency`) returns, with each command, whether it reads its stdin from a pipe. `effectsFor` passes that on to `grepEffects`, the bash-path grep rule. In the grep plan, `readGrep` decides a missing path; this plan changes that decision to the following order:

1. `-r` is present: the path is `.`. grep searches the working directory even when it is fed by a pipe. With ugrep it reads both. This check comes first, because a pipe does not stop `-r` from reading files. `.` is a directory, so the bash path then asks `std::bash`, as the grep plan decided.
2. The stage reads a pipe: the stage is a filter and contributes no effect.
3. Neither: unrecognized, as today.

A lone `grep` never reaches this rule, because it has no pipe. The shell-free path in the grep plan is unchanged.

A filter stage still goes through `splitFlags` with `GREP_FLAGS`, so an unknown or dangerous flag (`--filter`, `-R`) is still unrecognized, and so is a flag after the pattern. In a filter stage the first positional is the pattern, so `git log | grep fix -i` would make BSD grep read a file named `-i`, and it stays broad. Its redirects still contribute `std::write`.

**Which greps the stdin claim was checked against.** A grep with no path and no `-r` reads only its stdin when stdin is a pipe. That holds for GNU grep, BSD grep, and ugrep. ugrep switches to a recursive search only when stdin is a terminal, which a pipe never is.

**Depends on:** the grep plan (ADI-242), `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-242/packages/agency-lang/docs/superpowers/plans/2026-10-31-safebash-grep-std-grep.md`. That plan writes the `grepEffects` this plan changes.

**When to run it:** after the grep plan, and together with ADI-244 ("file reads (cat, head, tail, wc, diff) raise std::read; filters as pipeline stages"). Until ADI-244 lands, the only lines this plan narrows are `git status`, `git log`, or `git diff` piped into a `grep`. ADI-244 adds `cat a.txt | grep x` and the `head`/`tail`/`wc` filters (`git log | head -20`), which reuse the `readsStdin` flag this plan adds. Either run this plan as ADI-244's first task, or run it just before ADI-244.

**Review this plan answers:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-242/packages/agency-lang/docs/superpowers/plans/2026-10-31-safebash-filter-stages-REVIEW.md`

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-242/packages/agency-lang/docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 4 (pipelines: "a read verb with no path argument is allowed as any stage but the first, because there it reads its stdin").

## Global Constraints

- Nothing new runs. A filter stage contributes no effect, and the line still runs as one bash call of the rebuilt text.
- A filter stage is decided by the same flag table as any other `grep`. Only the missing-path rule changes.
- `verbNames` keeps its signature. Six other call sites pass it a one-element list of plain commands (`stdlib/safeBash.agency:579`, `:609`, `:619`, `:621`, `:704`, `:738`). `planFor` calls it with `[stage.command for stage in stages]`.
- Test helpers that need unexported functions use `import test { ... } from "std::safeBash"`. Do not export anything only for tests. An exported function that reaches `_bashParser` fails `lib/stdlibCapabilities.test.ts` unless it is put on the allow list.
- `make` after `.agency` changes; `pnpm run typecheck`, `pnpm run lint:structure`; absolute paths inside any script; never force-push.

## Review Focus

- `git status | grep -rn hello`: `-r` wins, so this grep searches the working directory through bash, and the line asks `std::bash`. A plan with only the git effect here would let grep read the whole tree under an approval for `git status`.
- `git status | grep hello && grep bye`: the second `grep` is not in the pipe and reads the shell's own stdin, so the line is unrecognized.
- `(git status | grep a) | grep b`: the group is the first stage of the outer pipe. `git status` reads nothing, and `grep a` and `grep b` read pipes.
- `git status | grep hello one.txt`: a path wins over stdin. grep reads `one.txt` and ignores the pipe, so the stage raises `std::grep` for the file.

---

### Task 1: Each flattened command says whether it reads a pipe

**Files:**
- Modify: `stdlib/safeBash.agency` (`flattenOne`, `flattenCommands`, and `planFor`'s loop)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Produces: `type Stage = { command: SimpleCommand; readsStdin: boolean }`. `flattenCommands(commands: Command[]): Stage[]` and `flattenOne(command: Command): Stage[]`.
  - A simple command gives `[{ command, readsStdin: false }]`.
  - `and`, `or`, and `parens` concatenate, as they do today.
  - The `pipeline` arm flattens the first stage as is. It flattens every later stage and sets `readsStdin: true` on each `Stage` it produced. For example, in `a | (b && c)`, both `b` and `c` read the pipe.
- `planFor` loops over the stages. It passes `stage.command` to `isRefused`, and `stage.command, cwd, stage.readsStdin` to `effectsFor`. `effectsFor` gains a third parameter, `readsStdin: boolean`. Every existing caller of `effectsFor` in `tests/agency/safeBash.agency` (line 55) passes `false`.

- [ ] **Step 1: Write the failing test**

```
import test { flattenCommands } from "std::safeBash"

def stdinFlags(source: string): any {
  const parsed = bashParser(source)
  if (parsed is failure(why)) {
    return "UNPARSEABLE"
  }
  const stages = flattenCommands(parsed.value)
  return [stage.readsStdin for stage in stages]
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
- Modify: `stdlib/safeBash.agency` (`readGrep` and `grepEffects` gain `readsStdin`; `GrepCall.target` becomes nullable; the `effectsFor` grep arm passes `readsStdin`; `tryShellFreeGrep` passes `false`, because a lone grep reads no pipe)

**Interfaces:**
- `readGrep(command: SimpleCommand, cwd: string, spec: FlagSpec, readsStdin: boolean): Result<GrepCall>`.
- `GrepCall.target: GrepTarget | null`. Null means the stage names no path and reads its stdin: a filter. `readGrep` returns null only when there is no path, no `r`, and `readsStdin` is true.
- `grepEffects` returns `success([])` when `target` is null, before the directory check, because a filter reads no path at all.
- `tryShellFreeGrep` passes `readsStdin: false`, so it never sees a null target. It still treats null as a failure, so the type is handled without relying on that.
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

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
8. `[["std::bash"],{"kind":"noEffects","detail":""}]`. Every stage was recognized and none raised anything, so the audit rule asks `std::bash`.
9. `[["std::bash"],{"kind":"unrecognized","detail":"an option after the first argument is a file name to some greps"}]`
10. `[["std::git::status"],null]`. With `-e`, there is no positional at all, which is the second way into the filter rule.

`grepUnrecognized` from the grep plan has the row `git status | grep hello`. It moves out of that node, because this plan recognizes it.

- [ ] **Step 2: Run to see it fail.** Rows 1, 2, and 5 come back as `std::bash` with `grep with no path reads stdin`.

- [ ] **Step 3: Implement** the three-step order from the Architecture section in `readGrep`'s missing-path rule. The `-r` check stays first. A filter stage returns from `grepEffects` with no effect before the directory check, because it reads no path at all.

- [ ] **Step 4: `make`; run; commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: a grep with no path in a pipe stage is a filter"
```

---

### Task 3: Docs and checks

- [ ] `docs/dev/stdlib/safe-bash.md`: in the grep section, add the missing-path order and the reason `-r` comes first, with the `git status | grep -rn hello` example. Add a short section, "Stages that read a pipe", describing `Stage.readsStdin`, so ADI-244's filters can use it.
- [ ] In the same section, say which greps the stdin claim was checked against (GNU, BSD, ugrep), as the Architecture section does.
- [ ] Run `pnpm run typecheck`, `pnpm run lint:structure`, and `pnpm vitest run lib/stdlibCapabilities.test.ts`, each saved to a file. Run `/anti-pattern-check` on the diff. Open the PR against `main` with the body in a file. The owner merges.
