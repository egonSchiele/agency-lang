# safeBash: file reads run the read tool, and ask `std::read` otherwise — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Paths are relative to `packages/agency-lang`.

**Goal:** `cat a.txt` runs the `read` tool's own file read with no shell, under one `std::read` question. `head -20 a.txt` and `tail -5 a.txt` do the same. Every other read of a named file (`wc -l a.txt`, `diff a b`, `cat a b`, `cat a.txt > copy.txt`, `< in.txt`) runs through bash and asks `std::read` per path. A read verb with no path in a later pipe stage, and the plain text filters (`sort`, `uniq`, `cut`, `tr`, `tac`, `rev`, `nl`), contribute nothing. `echo -n` joins the shell-free echo.

**The rule this plan makes general.** The grep slice (ADI-242) decided it for one verb, and this plan writes it into the dev doc as the rule for every verb: a lone command whose flags and arguments translate exactly runs the matching stdlib tool in process, under that tool's effect. Anything else goes to bash, with a narrow effect only when the payload describes what bash will do, and `std::bash` otherwise. The 2026-10-31 discussion settled why: the approval then describes exactly what runs, the output is the same on every machine and every `sh`, and the in-process path works on a host with no shell. A trojaned binary on the user's `PATH` is not the reason; the containment floor in `docs/dev/security/goal.md` is the defense against that, and the bash path still runs whatever `cat` the shell finds.

**Architecture.** Three pieces, each with one job:

1. **What a read verb reads.** A table of read verbs, `READ_VERBS`, says each verb's flag table and how many paths it takes. `readFileVerb` applies it the way `readGrep` applies `GREP_FLAGS`: it checks the flags, resolves every literal path, and answers `{ kind: "stdin" }` or `{ kind: "files", paths, counts }`. It never sees the pipe flag.
2. **Which question to ask.** On the bash path, each resolved path raises `std::read { dir, filename }`, the effect the `read` tool raises, so `recommended` already approves it under the launch directory. A stdin reader goes through the existing `stdinStage`.
3. **The shell-free path.** `tryShellFreeRead` applies to a lone `cat`, `head`, or `tail` of one file whose flags are in the shell-free table. It reads the file with `_read` and renders what the program would print with one pure TypeScript function, `_renderReadView` in a new `lib/stdlib/readDialect.ts`, the way `grepDialect.ts` renders grep's output. A parity test runs each row through the shell-free path and the real program and compares.

**Tech stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), TypeScript (`lib/stdlib/readDialect.ts`), vitest, the Agency test runner.

**Spec:** `docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 5 (the `std::read` rows, input redirects, filters). This plan is the second half of ADI-244. The first half, the pipe flag and `stdinStage`, is on main from the filter-stages plan. The in-process rows are a departure from the spec's table, decided 2026-10-31 and recorded in the dev doc by Task 8.

**Depends on:** the filter-stages plan (`2026-10-31-safebash-filter-stages.md`), merged: `FlatCommand`, `stdinStage`, `readsStdin` on `effectsFor`.

**Left out, on purpose:**

- `file`, `stat`, `md5sum`, `shasum`: `stat` takes different flags on BSD and GNU and prints different text, and the others are rare in agent logs. A later slice can add rows.
- `wc` in process. GNU and BSD pad the count column differently, so one rendering would be wrong somewhere. `wc` is a bash-path row only.
- `cat` of more than one file in process, `head`/`tail` of more than one file in process. `head` prints `==> name <==` headers for several files. They go to the bash path with one `std::read` per file.
- `tail -f` stays unrecognized. It is not in the table, so it asks `std::bash`, as it does today.
- The pipeline runner (`cat a | grep x | head` in process). The 2026-10-31 discussion put it in the slice after this one. This plan's `stdinStage` rows are what that runner will reuse.
- `echo -e`. dash prints `-e` as text and bash reads it as a flag. Refused, so it stays broad (ADI-248).

## Global Constraints

- The rule above all others, from ADI-242: if there is any doubt about what a command reads, the line is unrecognized and asks `std::bash`.
- A flag table is an allowlist, and every letter in it means the same thing in GNU coreutils, BSD (macOS) coreutils, and busybox. A letter that does not is left out, with the reason in the table's comment.
- Every path must be fully literal (`literalWordText`). A variable, a glob, or an interpolated word makes the command unrecognized. ADI-247 gives globs a meaning later.
- Paths resolve with `_resolveRedirectTarget(text, cwd, tildeModeFor(word))`, the resolver the redirect write uses: against the cwd, `~` expanded only when unquoted, through the strict symlink walk, to the real parent and name. A path that cannot be resolved (a dangling link, a loop) makes the command unrecognized.
- The executors call `_read`, never `read`. The `read` tool raises its own `std::read`, and the caller already raised one carrying this path. See "Why the executors call `_bash`, `_write`, and `_grep`" in the dev doc.
- `verbNames`, `effectsFor`, and `planFor` keep their signatures.
- Test helpers that need unexported functions use `import test { ... } from "std::safeBash"`. Only a constant that is `export`ed can be imported that way (the symbol table records exported constants only), which is why `GREP_FLAGS` is exported; export `READ_VERBS` and `FILTER_VERBS` the same way.
- `make` after `.agency` changes; `pnpm run typecheck`, `pnpm run lint:structure`, `pnpm vitest run lib/stdlibCapabilities.test.ts`; absolute paths inside any script; never force-push.
- Agency gotchas from the grep slice: no lambdas; `["A","B"].includes(str)` is a type error on a literal-typed array, so declare `static const X: string[]`; `if (x.tag != "flag") { continue }` does not narrow, use `if (x is { tag: "flag" })`; an `isFailure` guard does not narrow a `Result` whose value is a union, so match on the Result (`success(found) => ...`, `failure(why) => failure(why)`) through a helper def, as the grep arm of `effectsFor` does.

## Review Focus

Each line names an input and what a person expects. The task that owns it has the test.

1. `cat a.txt > copy.txt`: a read and a write. The line raises `std::read` for `a.txt` and `std::write` for `copy.txt`, and runs through bash. Task 2.
2. `cat ../secrets.txt` and `cat /etc/hosts`: the payload names the real parent, outside the launch directory, so `recommended` does not approve it. Task 5.
3. `cat link.txt` where `link.txt` is a symlink to a file elsewhere: the payload names the link's real target directory, not the directory the link sits in. Task 2.
4. `sort -o out.txt`: `-o` writes a file, and it is not in the filter table, so the line is unrecognized. `sort a.txt` in a pipe: a positional on a filter is unrecognized, because sort would read the file and ignore the pipe. Task 4.
5. A file with no trailing newline, an empty file, and a file with Windows line endings: the shell-free `cat`, `head`, and `tail` print what the programs print. Task 6's parity rows.

---

### Task 1: The read-verb table, and what a read verb reads

**Files:**
- Modify: `stdlib/safeBash.agency` (new types and defs beside `readGrep`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

Produces, in `stdlib/safeBash.agency`:

```
/** A read verb's flags, and how many paths it takes. */
export type ReadVerb = {
  flags: FlagSpec;
  /** 1 for head and tail (several files print headers), 0 for any number. */
  maxPaths: number
}

/** The verbs that read the files they name. Every letter means the same
 * thing in GNU, BSD, and busybox coreutils. Left out: cat -A -e -t -v
 * (GNU and BSD spell the escapes differently), head/tail -c (BSD head
 * lacks it), tail -f (never returns), tail -r (BSD only), wc -L (GNU
 * only), diff -y (column width depends on the terminal). */
export static const READ_VERBS: Record<string, ReadVerb> = {
  cat: { flags: { plain: ["n", "b", "s"], valued: [], optionsFirst: true }, maxPaths: 0 },
  head: { flags: { plain: [], valued: ["n"], optionsFirst: true }, maxPaths: 1 },
  tail: { flags: { plain: [], valued: ["n"], optionsFirst: true }, maxPaths: 1 },
  wc: { flags: { plain: ["l", "w", "c", "m"], valued: [], optionsFirst: true }, maxPaths: 0 },
  diff: { flags: { plain: ["u", "q", "N", "w", "b", "B", "r", "--color=never"], valued: ["U"], optionsFirst: true }, maxPaths: 2 },
  cmp: { flags: { plain: [], valued: [], optionsFirst: true }, maxPaths: 2 }
}

/** One resolved path of a read verb. `argument` is the path as bash hands
 * it to the program, for the shell-free path's error messages. */
type ReadPath = { dir: string; filename: string; argument: string }

/** What a read verb reads: the files it names, or its stdin. `count` is
 * the line count a head or tail asked for, 10 when it did not. */
type FileRead =
  | { kind: "stdin" }
  | { kind: "files"; paths: ReadPath[]; split: SplitArgs; count: number }

@capabilities(fileRead)
def readFileVerb(verb: string, command: SimpleCommand, cwd: string, spec: ReadVerb): Result<FileRead>
```

`readFileVerb`:

- Runs `splitFlags(verb, command, spec.flags)`. Before that, for `head` and `tail` only, rewrites a short flag whose letters are all digits (`-20`) into the valued flag `-n 20`, because `head -20 f` parses as the flag `-20` and the table has no letter `2`. Write this as `countFlagAsN(args: Word[]): Word[]`, applied to a copy of the command's args, so `splitFlags` is unchanged.
- The value of `-n` must be digits (`isDigits`), so `tail -n +5` and `head -n -5` are unrecognized. `count` is that value as a number, 10 when `-n` is absent.
- Each positional must be literal, or the command is unrecognized. No positional is `{ kind: "stdin" }`. More than `maxPaths` positionals (when `maxPaths` is not 0) is unrecognized: `"${verb} with more than ${maxPaths} path(s)"`. `diff` and `cmp` with fewer than two is unrecognized: `"${verb} needs two paths"`.
- Each path resolves with `try _resolveRedirectTarget(text, cwd, tildeModeFor(word))`; a failure is a failure. `argument` is the literal text as written.

- [ ] **Step 1: Write the failing test**

Add `readFileVerb` to the `import test { ... }` line, and:

```
def readOf(source: string): any {
  const parsed = bashParser(source)
  if (parsed is failure(why)) {
    return "UNPARSEABLE"
  }
  const first = parsed.value[0]
  if (first.tag != "simpleCommand" || first.command == null) {
    return "NOT-SIMPLE"
  }
  const verb = first.command.text
  return match(readFileVerb(verb, first, FIXTURES, READ_VERBS[verb])) {
    success(found) => match(found) {
      { kind: "stdin" } => "stdin"
      { kind: "files", paths, count } => [[p.filename for p in paths], count]
    }
    failure(why) => why
  }
}

node readVerbsReadFiles() {
  return [
    readOf("cat one.txt"),
    readOf("cat one.txt two.txt"),
    readOf("cat -n one.txt"),
    readOf("head one.txt"),
    readOf("head -n 20 one.txt"),
    readOf("head -20 one.txt"),
    readOf("tail -n5 one.txt"),
    readOf("wc -l one.txt"),
    readOf("diff one.txt two.txt"),
    readOf("cat"),
    readOf("head -n 3"),
    readOf("head one.txt two.txt"),
    readOf("tail -n +5 one.txt"),
    readOf("tail -f one.txt"),
    readOf("cat -A one.txt"),
    readOf("cat $F"),
    readOf("cat *.txt"),
    readOf("diff one.txt"),
    readOf("cat one.txt -n"),
  ]
}
```

`expectedOutput`, row by row: `[["one.txt"],10]`, `[["one.txt","two.txt"],10]`, `[["one.txt"],10]`, `[["one.txt"],10]`, `[["one.txt"],20]`, `[["one.txt"],20]`, `[["one.txt"],5]`, `[["one.txt"],10]`, `[["one.txt","two.txt"],10]`, `"stdin"`, `"stdin"`, `"head with more than 1 path(s)"`, `"the value of \`-n\` is not a number"`, `"tail does not take \`-f\`"`, `"cat does not take \`-A\`"`, `"the cat path is not literal"`, `"the cat path is not literal"`, `"diff needs two paths"`, `"an option after the first argument is a file name to some versions of cat"`.

Note: if `readFileVerb` cannot be reached with a `match` arm that nests a second `match` (Agency has no `if-then-else` inside a match arm, and nested matches have needed hand-wiring before), split `readOf` into two defs: one that matches the Result, one that matches the `FileRead`.

- [ ] **Step 2: Run to see it fail**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/reads-t1-red.txt 2>&1; grep -n "readVerbsReadFiles" -A4 /tmp/reads-t1-red.txt | head`
Expected: the node fails to compile (no `readFileVerb`, no `READ_VERBS`) or fails with every row wrong.

- [ ] **Step 3: Implement** the interfaces above. `make`.

- [ ] **Step 4: Run; every existing node still passes**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/reads-t1.txt 2>&1; grep -n "tests passed" /tmp/reads-t1.txt`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json docs/site/stdlib/safeBash.md
git commit -F /tmp/msg.txt   # "safeBash: the read-verb table says what cat, head, tail, wc, diff, and cmp read"
```

---

### Task 2: A read of named files asks `std::read` per path, on the bash path

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`Effect` gains a variant), `stdlib/safeBash.agency` (`effectsFor`, `raiseOne`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

- Consumes: `FileRead`, `readFileVerb`, `READ_VERBS` (Task 1); `stdinStage` (main).
- Produces, in `actions.agency`:

```
export type ReadPayload = { dir: string; filename: string }
// Effect gains:
  | { name: "std::read"; payload: ReadPayload }
export def readEffect(payload: ReadPayload): Effect
```

- The default arm of `effectsFor`'s match (`_ => failure("no rule for ...")`) becomes a call to `otherVerbEffects(name.text, command, cwd, readsStdin, redirect.value)`, which looks the verb up in `READ_VERBS`. A hit matches on `readFileVerb`'s Result through a helper, as the grep arm does: `{ kind: "stdin" }` goes to `stdinStage(verb, readsStdin, redirects)`; `{ kind: "files", paths }` is one `readEffect({ dir, filename })` per path, then the redirects. A miss keeps today's `"no rule for \`${verb}\`"`. Task 4 adds the filter lookup to the same def.
- `raiseOne` gains the arm:

```
"std::read" => {
  raise std::read("Are you sure you want to read this file?", {
    dir: effect.payload.dir,
    filename: effect.payload.filename,
    command: fullCommand
  })
  return success(null)
}
```

- `outcomeOf` is unchanged: these plans are `bash` with no `broadReason`, so `narrow`.
- `READ_TOOL_FOR_VERB` gains `cat`, `head`, `tail`, `wc` pointing at `read`, so a rejected broad line made of those verbs names the tool. (`diff` and `cmp` have no tool.)

- [ ] **Step 1: Write the failing test**

`grepNames` already returns `[effect names, broadReason]` for a plan over `FIXTURES`. Reuse it:

```
node readsAskStdRead() {
  return [
    grepNames("cat one.txt"),
    grepNames("cat one.txt two.txt"),
    grepNames("wc -l one.txt"),
    grepNames("diff one.txt two.txt"),
    grepNames("cat one.txt > copy.txt"),
    grepNames("git status && cat one.txt"),
    grepNames("cat one.txt | head -3"),
    grepNames("head -3 one.txt | cat"),
    grepNames("cat"),
    grepNames("cat -A one.txt"),
    grepNames("tail -f one.txt"),
  ]
}

node readPayloadNamesTheRealParent(): boolean {
  // A link inside the fixtures to a file outside names the target's directory.
  const outside = resolve(FIXTURES, "../outside-fixture.txt")
  // ... create outside, symlink FIXTURES/link.txt -> outside, plan `cat link.txt`,
  // compare payload.dir to the real parent of `outside`, delete both.
}
```

For the symlink row, follow `absoluteRedirectReportsParent` and `tildeRedirectQuoting` in the same file for how a fixture is made and removed (`std::fs`, always with `safeDeleteDirectoryWithin`-style cleanup, never a hand-rolled remove of a path outside the test's own folder).

`expectedOutput` for `readsAskStdRead`, row by row:

1. `[["std::read"],null]`
2. `[["std::read","std::read"],null]`
3. `[["std::read"],null]`
4. `[["std::read","std::read"],null]`
5. `[["std::read","std::write"],null]`
6. `[["std::git::status","std::read"],null]`
7. `[["std::read"],null]` (the `head -3` stage is a filter)
8. `[["std::read"],null]` (the `cat` stage is a filter)
9. `[["std::bash"],{"kind":"unrecognized","detail":"cat with no path reads stdin"}]`
10. ``[["std::bash"],{"kind":"unrecognized","detail":"cat does not take `-A`"}]``
11. ``[["std::bash"],{"kind":"unrecognized","detail":"tail does not take `-f`"}]``

Row 1 shows the bash path here. Task 6 makes a lone `cat one.txt` shell-free; its effect list stays `["std::read"]`, so this row does not change then. Also add a row to `planOutcomes` (if that node lists outcomes by command) for `cat one.txt && git status` as `narrow`.

- [ ] **Step 2: Run to see it fail.** Rows 1 through 8 come back `std::bash` with ``no rule for `cat` ``.

- [ ] **Step 3: Implement.** `make`.

- [ ] **Step 4: Run; all pass. Commit**

```bash
git add stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json docs/site/stdlib/safeBash.md
git commit -F /tmp/msg.txt   # "safeBash: cat, head, tail, wc, diff, and cmp ask std::read per path"
```

---

### Task 3: `< file` asks `std::read`

**Files:**
- Modify: `stdlib/safeBash.agency` (`redirectEffect`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `readEffect` (Task 2), `prepareRedirectWrite` (main).
- Changes `redirectEffect(redirects, cwd)`: a redirect with op `<` and no explicit fd, to a literal target, contributes `readEffect({ dir, filename })`, resolved with `_resolveRedirectTarget` and `tildeModeFor(target)`. One input redirect and one output redirect may both appear (`sort < in.txt > out.txt` is a read and a write). Two of the same direction, an explicit fd, or a non-literal target stay failures. `prepareRedirectWrite` is unchanged, so the shell-free write path still refuses any `<`.

- [ ] **Step 1: Write the failing test**

```
node inputRedirectIsARead() {
  return [
    grepNames("git status < one.txt"),
    grepNames("cat < one.txt"),
    grepNames("echo hi < one.txt > copy.txt"),
    grepNames("git status < $F"),
    grepNames("git status < one.txt < two.txt"),
  ]
}
```

`expectedOutput`: `[["std::git::status","std::read"],null]`, `[["std::bash"],{"kind":"unrecognized","detail":"cat with no path reads stdin"}]`, `[["std::read","std::write"],null]`, ``[["std::bash"],{"kind":"unrecognized","detail":"`variable` is not fully literal"}]``, `[["std::bash"],{"kind":"unrecognized","detail":"more than one input redirect"}]`.

Row 2 is deliberate: `cat < one.txt` reads its stdin, which is the file, but `cat` names no path and is not in a pipe, so today's rule keeps it unrecognized. Recognizing "stdin is a redirect" is a later refinement; note it in the dev doc as left out.

Also add `"echo hi < one.txt"` to `shellFreeEcho`'s rows as `"bash"`, if it is not there, so the write path's refusal of `<` is pinned.

- [ ] **Step 2: Run to see it fail.** Rows 1 and 3 come back broad with ``` `<` is not an output redirect ```.

- [ ] **Step 3: Implement. `make`. Run; all pass. Commit**

```bash
git commit -F /tmp/msg.txt   # "safeBash: an input redirect asks std::read"
```

---

### Task 4: Text filters as pipe stages

**Files:**
- Modify: `stdlib/safeBash.agency` (`FILTER_VERBS`, `otherVerbEffects`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `otherVerbEffects` (Task 2), `stdinStage`, `splitFlags`.
- Produces:

```
/** Verbs that read only their stdin and write only their stdout. A
 * positional is refused: `sort a.txt` reads the file and ignores the pipe.
 * Left out: sort -o (writes a file), column (flags differ between BSD and
 * GNU), xxd and hexdump (rare), tee (writes), xargs (runs a command). */
export static const FILTER_VERBS: Record<string, FlagSpec> = {
  sort: { plain: ["n", "r", "u", "f", "b"], valued: ["k", "t"], optionsFirst: false },
  uniq: { plain: ["c", "d", "u", "i"], valued: [], optionsFirst: false },
  cut: { plain: [], valued: ["d", "f", "c"], optionsFirst: false },
  tr: { plain: ["d", "s"], valued: [], optionsFirst: false },
  tac: { plain: [], valued: [], optionsFirst: false },
  rev: { plain: [], valued: [], optionsFirst: false },
  nl: { plain: [], valued: ["b"], optionsFirst: false }
}
```

`tr` takes its two sets as positionals (`tr a b`, `tr -d x`), so `tr` is the one filter where positionals are allowed: one with `-d` or `-s`, two otherwise, each literal. Every other filter refuses any positional with `"${verb} with a path reads the file, not the pipe"`.

In `otherVerbEffects`, after the `READ_VERBS` lookup misses: a `FILTER_VERBS` hit runs `splitFlags`, checks the positionals as above, and returns `stdinStage(verb, readsStdin, redirects)`.

- [ ] **Step 1: Write the failing test**

```
node filtersInAPipe() {
  return [
    grepNames("git log | sort | uniq -c"),
    grepNames("cat one.txt | sort -u"),
    grepNames("cat one.txt | cut -d: -f1"),
    grepNames("cat one.txt | tr a b"),
    grepNames("cat one.txt | tr -d x"),
    grepNames("cat one.txt | sort two.txt"),
    grepNames("cat one.txt | sort -o out.txt"),
    grepNames("sort one.txt"),
    grepNames("git log | tee log.txt"),
    grepNames("git log | xargs echo"),
    grepNames("git log | sort > sorted.txt"),
  ]
}
```

`expectedOutput`: `[["std::git::log"],null]`, `[["std::read"],null]`, `[["std::read"],null]`, `[["std::read"],null]`, `[["std::read"],null]`, `[["std::bash"],{"kind":"unrecognized","detail":"sort with a path reads the file, not the pipe"}]`, ``[["std::bash"],{"kind":"unrecognized","detail":"sort does not take `-o`"}]``, `[["std::bash"],{"kind":"unrecognized","detail":"sort with a path reads the file, not the pipe"}]`, ``[["std::bash"],{"kind":"unrecognized","detail":"no rule for `tee`"}]``, ``[["std::bash"],{"kind":"unrecognized","detail":"no rule for `xargs`"}]``, `[["std::git::log","std::write"],null]`.

Row 3: check how the parser reads `-d:` and `-f1` (a valued short flag with the rest of the word as its value, as `-A3` for grep) before pinning the row; if `-d:` does not parse as a flag, write the row as `cut -d : -f 1` and say so in the ledger.

- [ ] **Step 2: Run to see it fail.** Rows 1 through 5 and 11 come back ``no rule for `sort` `` (or `cut`, `tr`).

- [ ] **Step 3: Implement. `make`. Run; all pass. Commit**

```bash
git commit -F /tmp/msg.txt   # "safeBash: sort, uniq, cut, tr, tac, rev, and nl are filters in a pipe"
```

---

### Task 5: End to end: one question, no shell for the question, the right payload

**Files:**
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

No production change. These nodes run `safeBash` and check the interrupts, following `loneGrepAsksOneQuestion`, `grepUnderRecommendedNeedsNoPrompt`, and `grepOutsideTheLaunchDirIsUndecided`.

- [ ] **Step 1: Write the tests**

```
node readUnderRecommendedNeedsNoPrompt() {
  // cat one.txt && git status under recommended: both approved, output is the file then the status.
}

node readOutsideTheLaunchDirIsUndecided() {
  // cat of a file under a temp directory outside FIXTURES: checkPolicy(recommended) returns
  // no decision (the same shape grepOutsideTheLaunchDirIsUndecided asserts).
}

node readAsksExactlyOneQuestion() {
  // handle { safeBash("wc -l one.txt && git status", cwd: FIXTURES) } with a handler that counts
  // interrupts by effect: {"std::read": 1, "std::git::status": 1}, and the result is a success.
}

node rejectedReadNamesTheTool() {
  // safeBash("cat -A one.txt", cwd: FIXTURES) with a handler that rejects std::bash:
  // the failure text ends with "Call the read tool instead: a policy can approve its question in advance."
}
```

Write each body in the style of the node it follows. `expectedOutput` values come from running them once the bodies are right; the first run is the RED step because the nodes did not exist.

- [ ] **Step 2: Run; all pass. Commit**

```bash
git commit -F /tmp/msg.txt   # "safeBash: end-to-end tests for file reads"
```

---

### Task 6: A lone `cat`, `head`, or `tail` of one file runs the read tool's read

**Files:**
- Create: `lib/stdlib/readDialect.ts`, `lib/stdlib/readDialect.test.ts`
- Modify: `stdlib/safeBash/actions.agency` (`Execution` gains `ReadExec`, `runRead`), `stdlib/safeBash.agency` (`tryShellFreeRead`, `planFor`, `outcomeOf`), `lib/stdlib/safeBash.ts` or the import line that re-exports stdlib-lib helpers
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

In `actions.agency`:

```
/** How the shell-free path prints a file: whole, numbered (cat -n), the
 * first `lines` lines (head), or the last `lines` lines (tail). */
export type ReadView =
  | { kind: "whole" }
  | { kind: "numbered" }
  | { kind: "head"; lines: number }
  | { kind: "tail"; lines: number }

export type ReadExec = {
  kind: "read";
  payload: ReadPayload;
  /** The path as written, for the error a missing file prints. */
  argument: string;
  verb: string;
  view: ReadView
}
// Execution gains ReadExec.

@capabilities(fileRead)
export def runRead(exec: ReadExec, command: string): Result<string>
```

`runRead` calls `try _read(exec.payload.dir, exec.payload.filename)` with no offset or limit, which returns the raw text (`sliceLines` returns the text untouched when both are unset; the parity test proves it). A failure is `exitFailure(command, 1, "", "${exec.verb}: ${exec.argument}: No such file or directory", command)`, the message GNU and BSD both print. On success it returns `keepOutput(_renderReadView(text, exec.view), 0, command)`.

In `lib/stdlib/readDialect.ts`, pure, no host access:

```ts
export type ReadView = { kind: "whole" } | { kind: "numbered" } | { kind: "head"; lines: number } | { kind: "tail"; lines: number };
/** What cat, cat -n, head -n, or tail -n prints for `text`. */
export function _renderReadView(text: string, view: ReadView): string;
```

The rules the function follows, each pinned by a `readDialect.test.ts` case:

- `whole`: the text as is.
- `numbered`: every line, including a final line with no newline, prefixed by its 1-based number right-aligned in 6 columns and a tab (`%6d\t`), the format GNU and BSD share. An empty file prints nothing. A line is a run ending in `\n`; a final run with no `\n` is a line that keeps no `\n`.
- `head`: the first `lines` lines, each with its `\n` if it had one. `lines` of 0 prints nothing.
- `tail`: the last `lines` lines. A file whose last byte is not `\n` has a final partial line that counts as one. `lines` of 0 prints nothing.

In `stdlib/safeBash.agency`, `tryShellFreeRead(command, cwd): Result<Plan>`, called from `planFor`'s lone-command branch after `tryShellFreeGrep`:

- The verb is `cat`, `head`, or `tail`; no assignments; no redirects; otherwise "not a lone read".
- `readFileVerb` with the verb's `READ_VERBS` row. `{ kind: "stdin" }` is a failure ("a lone read with no path reads stdin"). More than one path is a failure ("the shell-free path reads one file").
- The flags allowed here are narrower than the row: `cat` with no flag is `whole`, `cat -n` is `numbered`, `cat -b` or `-s` is a failure ("not rendered shell-free"); `head` and `tail` take `count` as `lines`.
- The plan: `effects: [readEffect(payload)]`, `execution: { kind: "read", payload, argument, verb, view }`, `broadReason: null`, `verbs: verbNames([command])`.

`outcomeOf` gains `"read" => "shellFree"`. `safeBash`'s dispatch gains `{ kind: "read" } => runRead(exec, command)`.

- [ ] **Step 1: Write the failing unit test** for `_renderReadView` in `lib/stdlib/readDialect.test.ts`: whole; numbered on `"a\nb\n"` gives `"     1\ta\n     2\tb\n"`; numbered on `"a\nb"` gives `"     1\ta\n     2\tb"`; numbered on `""` gives `""`; head 1 of `"a\nb\n"` gives `"a\n"`; head 5 of `"a\n"` gives `"a\n"`; head 0 gives `""`; tail 1 of `"a\nb\n"` gives `"b\n"`; tail 1 of `"a\nb"` gives `"b"`; tail 2 of `"a\r\nb\r\n"` gives `"a\r\nb\r\n"`; tail 5 of `"a\n"` gives `"a\n"`.

Run: `pnpm vitest run lib/stdlib/readDialect.test.ts > /tmp/reads-t6-unit-red.txt 2>&1; tail -5 /tmp/reads-t6-unit-red.txt`
Expected: fails to import `_renderReadView`.

- [ ] **Step 2: Implement `_renderReadView`; run; pass.** `pnpm run fmt:ts -- lib/stdlib/readDialect.ts lib/stdlib/readDialect.test.ts` (named files only).

- [ ] **Step 3: Write the failing Agency tests**

```
node loneReadIsShellFree() {
  return [
    outcomeOf(planFor("cat one.txt", FIXTURES)),
    outcomeOf(planFor("cat -n one.txt", FIXTURES)),
    outcomeOf(planFor("head -3 one.txt", FIXTURES)),
    outcomeOf(planFor("tail -n 2 one.txt", FIXTURES)),
    outcomeOf(planFor("cat -b one.txt", FIXTURES)),
    outcomeOf(planFor("cat one.txt two.txt", FIXTURES)),
    outcomeOf(planFor("cat one.txt > copy.txt", FIXTURES)),
    outcomeOf(planFor("cat one.txt | head", FIXTURES)),
    outcomeOf(planFor("wc -l one.txt", FIXTURES)),
  ]
}
```

`expectedOutput`: `["shellFree","shellFree","shellFree","shellFree","narrow","narrow","narrow","narrow","narrow"]`.

```
def readParityOf(source: string): any {
  // As parityOf, but the execution kind is "read" and the comparison is exact, not sorted lines:
  // cat, head, and tail print in order.
}

node shellFreeReadMatchesRealTools() {
  return [
    readParityOf("cat one.txt"),
    readParityOf("cat -n one.txt"),
    readParityOf("head -1 one.txt"),
    readParityOf("head -n 1 one.txt"),
    readParityOf("head -n 100 one.txt"),
    readParityOf("tail -1 one.txt"),
    readParityOf("tail -n 100 one.txt"),
    readParityOf("cat noeol.txt"),
    readParityOf("cat -n noeol.txt"),
    readParityOf("tail -1 noeol.txt"),
    readParityOf("cat empty.txt"),
    readParityOf("cat -n empty.txt"),
    readParityOf("cat crlf.txt"),
    readParityOf("tail -1 crlf.txt"),
  ]
}
```

Add three fixtures to `tests/agency/stdlib/grep-fixtures/`: `noeol.txt` (two lines, no final newline), `empty.txt` (zero bytes), `crlf.txt` (two lines ending `\r\n`). Check first that no existing grep row's expected output changes because a new fixture matches its pattern; if one does, put the new files in a sibling `read-fixtures/` directory and point `readParityOf` there.

`expectedOutput`: `[true,true,true,true,true,true,true,true,true,true,true,true,true,true]`.

```
node shellFreeReadMissingFile() {
  // safeBash("cat nope.txt", cwd: FIXTURES) with approve: a failure whose text contains
  // "cat: nope.txt: No such file or directory" and exitCode 1.
}

node loneReadAsksOneQuestion() {
  // As loneGrepAsksOneQuestion: one std::read, no std::bash, success with the file's text.
}
```

- [ ] **Step 4: Run to see them fail.** `loneReadIsShellFree` rows 1 through 4 are `narrow`; the parity rows are `"NOT SHELL-FREE: ..."`.

- [ ] **Step 5: Implement. `make`. Run; all pass.** Then `pnpm vitest run lib/stdlibCapabilities.test.ts`; if `tryShellFreeRead` or `runRead` is reported, add it to the allow list the way `bashParser` is.

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/readDialect.ts lib/stdlib/readDialect.test.ts stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json tests/agency/stdlib/grep-fixtures docs/site/stdlib/safeBash.md
git commit -F /tmp/msg.txt   # "safeBash: a lone cat, head, or tail runs the read tool's read"
```

---

### Task 7: `echo -n` is shell-free

**Files:**
- Modify: `stdlib/safeBash.agency` (`echoPlan`, `writePlan`, `echoOutput`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- `echoOutput(words: string[], newline: boolean): string`: joined by single spaces, then `\n` only when `newline`.
- `echoPlan` and `writePlan` accept exactly one flag, `-n`, and pass `newline: false`. Any other flag (`-e`, `-E`, `-ne`) keeps today's failure ``"`echo` with flags prints differently"``. Check the flag by `flagNames(command)` being `[]` or `["-n"]`.

- [ ] **Step 1: Write the failing test.** Add rows to `shellFreeEcho`: `"echo -n hi"` as `"shellFree"`, `"echo -e hi"` as `"bash"`, `"echo -ne hi"` as `"bash"`. Add a node:

```
node echoNoNewline() {
  // safeBash("echo -n hi") returns success("hi"); safeBash("echo hi") returns success("hi\n").
  // safeBash("echo -n hi > out.txt", cwd: <temp dir>) writes the two bytes "hi".
}
```

- [ ] **Step 2: Run to see it fail.** `echo -n hi` is `bash`.

- [ ] **Step 3: Implement. `make`. Run; all pass. Commit**

```bash
git commit -F /tmp/msg.txt   # "safeBash: echo -n is shell-free"
```

---

### Task 8: Docs, checks, PR

**Files:**
- Modify: `docs/dev/stdlib/safe-bash.md`, `CLAUDE.md` (the `safe-bash.md` index line), `.claude/skills/agency-stdlib-docs/SKILL.md` (the same line; the file is tracked)

- [ ] `docs/dev/stdlib/safe-bash.md`: a new section after "Outcomes", "In process when it translates", stating the rule from this plan's second paragraph, with the grep and read rows as the two instances and the reasons (the approval is the action; one output everywhere; hosts with no shell), and one sentence saying what it is not (a defense against a trojaned binary; the bash path still runs the user's `PATH`). Then a section "The read family": the `READ_VERBS` table and what each left-out flag would have meant; `readFileVerb` and `FileRead`; the bash path's one `std::read` per path and why `recommended` already approves it; `< file`; `FILTER_VERBS` and the positional rule; the shell-free rows (`cat`, `cat -n`, `head`, `tail`, one file) and `readDialect.ts` with the four rendering rules; the "left out" list from this plan; and the resolve-before-run note from the grep section, which now covers reads too.
- [ ] Update the "Files and tests" list and the `CLAUDE.md` and skill index lines for `safe-bash.md` to mention the read family and `readDialect.ts`.
- [ ] Run `pnpm run typecheck`, `pnpm run lint:structure`, `pnpm vitest run lib/stdlib/readDialect.test.ts lib/stdlibCapabilities.test.ts`, each saved to a file. Run `/anti-pattern-check` on the diff. Open the PR against `main` with the body in a file; the owner merges.
