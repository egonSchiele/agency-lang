# safeBash: file reads run the read tool, and ask `std::read` otherwise — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Paths are relative to `packages/agency-lang`.

**Goal:** `cat a.txt` runs the `read` tool's own file read with no shell, under one `std::read` question. `head -20 a.txt` and `tail -5 a.txt` do the same. Every other read of a named file (`wc -l a.txt`, `diff a b`, `cat a b`, `sort a.txt`, `cat a.txt > copy.txt`, `< in.txt`) runs through bash and asks `std::read` per path. A read verb with no path in a later pipe stage, and `tr`, contribute nothing.

**The rule this plan makes general.** The grep slice (ADI-242) decided it for one verb, and this plan writes it into the dev doc as the rule for every verb: a lone command whose flags and arguments translate exactly runs the matching stdlib tool in process, under that tool's effect. Anything else goes to bash, with a narrow effect only when the payload describes what bash will do, and `std::bash` otherwise. The reasons: the approval then describes exactly what runs, the output is the same on every machine and every `sh`, and the in-process path works on a host with no shell. A trojaned binary on the user's `PATH` is not the reason; the containment floor in `docs/dev/security/goal.md` is the defense against that, and the bash path still runs whatever `cat` the shell finds.

**Architecture.** Three pieces, each with one job:

1. **What a read verb reads.** A table of read verbs, `READ_VERBS`, says each verb's flag table and how many paths it takes. `readFileVerb` applies it the way `readGrep` applies `GREP_FLAGS`: it checks the flags, resolves every literal path to a regular file, and answers `{ kind: "stdin" }` or `{ kind: "files", paths, split }`. It never sees the pipe flag. `tr` is the one verb whose positionals are not paths, and it has its own small rule.
2. **Which question to ask.** On the bash path, each resolved path raises `std::read { dir, filename }`, the effect the `read` tool raises, so `recommended` already approves it under the launch directory. A stdin reader goes through the existing `stdinStage`.
3. **The shell-free path.** `tryShellFreeRead` applies to a lone `cat`, `head`, or `tail` of one file whose flags are in the shell-free set. It reads the file with `_read` and renders what the program would print with one pure TypeScript function, `_renderReadView` in a new `lib/stdlib/readDialect.ts`, the way `grepDialect.ts` renders grep's output. A parity test runs each row through the shell-free path and the real program and compares.

**Tech stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), TypeScript (`lib/stdlib/readDialect.ts`), vitest, the Agency test runner.

**Spec:** `docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 5 (the `std::read` rows, input redirects, filters). This plan is the second half of ADI-244. The first half, the pipe flag and `stdinStage`, is on main (#1324).

**Departures from the spec, recorded in the spec by Task 7:**

- A lone `cat`, `head`, or `tail` of one file runs in process (the spec's table has every read through bash).
- A read path must name a regular file. The spec says a missing path resolves by its parent, as a redirect target does; here a missing path, a folder, or a special file (a FIFO, `/dev/zero`) makes the command unrecognized. The reason is in Task 1: a folder passed as a path lets `diff -r a b` read every file under both, links followed, under two questions that name only `a` and `b`, and a FIFO would hang `runBash`, which has no timeout. The cost is one broad prompt when the model mistypes a file name, the same as `grep x nope.txt` today.
- `diff -r` is refused (the row loses `-r`), for the same reason.
- The filters (`sort`, `uniq`, `cut`, `nl`, `tac`, `rev`) are read verbs, not a second table: each reads the files it names, so `sort a.txt` is a truthful `std::read` and `sort` with no path is a filter through `stdinStage`.

**Review this plan answers:** `docs/superpowers/plans/2026-10-31-safebash-reads-in-process-REVIEW.md`.

**Depends on:** #1324 (`FlatCommand`, `stdinStage`, `readsStdin` on `effectsFor`), merged as 04b90823b.

**Left out, on purpose:**

- `echo -n`. macOS `/bin/sh` (bash 3.2 in POSIX mode) prints `-n hi` for `echo -n hi`, so a shell-free `echo -n` would disagree with the same echo inside a chain on a Mac. It belongs with `echo -e` in ADI-248, and lands when that ticket decides which shell runs the text.
- `file`, `stat`, `md5sum`, `shasum`: `stat` takes different flags on BSD and GNU and prints different text, and the others are rare in agent logs. A later slice can add rows.
- `wc` in process. GNU and BSD pad the count column differently, so one rendering would be wrong somewhere. `wc` is a bash-path row only.
- `cat` of more than one file in process, `head`/`tail` of more than one file in process. `head` prints `==> name <==` headers for several files. They go to the bash path with one `std::read` per file.
- `tail -f` stays unrecognized. It is not in the table, so it asks `std::bash`, as it does today.
- `column`, `xxd`, `hexdump`: `column`'s flags differ between BSD and GNU; the other two are rare.
- A stdin reader whose stdin is an input redirect (`cat < one.txt`). Recognizing "stdin is a redirect" is a later refinement; today's rule keeps it unrecognized.
- `sort -t, -k2`, `cut -d, -f1`, `sort -k2,2n`: the bash parser refuses a comma joined to a flag, so these are unparseable and stay broad. They are the forms models write most, so they need a tarsec ticket (Task 7). This plan's rows cover the forms with a space (`cut -d : -f 1`).
- The pipeline runner (`cat a | grep x | head` in process). The 2026-10-31 discussion put it in the slice after this one. This plan's `stdinStage` rows are what that runner will reuse.

## Global Constraints

- The rule above all others, from ADI-242: if there is any doubt about what a command reads, the line is unrecognized and asks `std::bash`.
- A flag table is an allowlist, and every letter in it means the same thing in GNU coreutils, BSD (macOS) coreutils, and busybox. A letter that does not is left out, with the reason in the table's comment.
- Every path must be fully literal (`literalWordText`). A variable, a glob, or an interpolated word makes the command unrecognized. ADI-247 gives globs a meaning later.
- Paths resolve with `try _searchTargetIn(text, cwd, tildeModeFor(word))` (`lib/stdlib/shell.ts:513`), which `safeBash.agency` already imports for grep: against the cwd, `~` expanded only when unquoted, realpathed, and stat'ed. A result with `file == null` is a folder and is refused. A missing path or a special file throws, and the `try` makes that a failure. The payload carries the real parent as `dir` and the name as `file`, so a symlink to a file elsewhere names its target's directory.
- The executors call `_read`, never `read`. The `read` tool raises its own `std::read`, and the caller already raised one carrying this path. See "Why the executors call `_bash`, `_write`, and `_grep`" in the dev doc.
- `verbNames`, `effectsFor`, and `planFor` keep their signatures.
- Test helpers that need unexported functions use `import test { ... } from "std::safeBash"`. Only a constant that is `export`ed can be imported that way (the symbol table records exported constants only), which is why `GREP_FLAGS` is exported; export `READ_VERBS` the same way.
- `make` after `.agency` changes; `pnpm run typecheck`, `pnpm run lint:structure`, `pnpm vitest run lib/stdlibCapabilities.test.ts`; absolute paths inside any script; never force-push. The worktree has no `node_modules` or `dist` yet: `pnpm install --frozen-lockfile` at the worktree root, then `make`, before Task 1.
- Agency gotchas from the grep slices: no lambdas; `["A","B"].includes(str)` is a type error on a literal-typed array, so declare `static const X: string[]`; `if (x.tag != "flag") { continue }` does not narrow, use `if (x is { tag: "flag" })`; an `isFailure` guard does not narrow a `Result` whose value is a union, so match on the Result (`success(found) => ...`, `failure(why) => failure(why)`) through a helper def, as the grep arm of `effectsFor` does; Agency has no `if-then-else` expression inside a match arm; a nested `match` as an arm value has needed a helper def before.

## Review Focus

Each line names an input and what a person expects. The task that owns it has the test.

1. `cat a.txt > copy.txt`: a read and a write. The line raises `std::read` for `a.txt` and `std::write` for `copy.txt`, and runs through bash. Task 2.
2. `cat ../secrets.txt` and `cat /etc/hosts`: the payload names the real parent, outside the launch directory, so `recommended` does not approve it. Task 5.
3. `cat link.txt` where `link.txt` is a symlink to a file elsewhere: the payload names the link's real target directory, not the directory the link sits in. Task 2.
4. `diff -r a b`, `cat somedir`, `wc -l somefifo`: a folder or a special file as a read path is unrecognized, because the program would read what no payload names, or hang. Task 1.
5. A file with no trailing newline, an empty file, and a file with Windows line endings: the shell-free `cat`, `head`, and `tail` print what the programs print. Task 6's parity rows.

---

### Task 1: The read-verb table, and what a read verb reads

**Files:**
- Modify: `stdlib/safeBash.agency` (new types and defs beside `readGrep`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

Produces, in `stdlib/safeBash.agency`:

```
/** A read verb's flags, how many paths it takes, and whether a bare
 * digit flag (`-20`) means `-n 20`. */
export type ReadVerb = {
  flags: FlagSpec;
  /** 0 for any number; 1 for head and tail (several files print headers)
   * and uniq (a second positional is its OUTPUT file); 2 for diff and cmp. */
  maxPaths: number;
  /** True for head and tail, where `-20` is `-n 20`. */
  digitFlagIsCount: boolean
}

/** The verbs that read the files they name, or their stdin when they
 * name none. Every letter means the same thing in GNU, BSD, and busybox
 * coreutils. Left out: cat -A -e -t -v (GNU and BSD spell the escapes
 * differently); tail -f (never returns); tail -r (BSD only); wc -L (GNU
 * only); diff -r (reads a whole tree under a question that names one
 * folder) and -y (column width depends on the terminal); sort -o
 * (writes a file), -m, -c; uniq's second positional. tac is not on
 * macOS; the line is recognized and the shell reports it missing. sort
 * may spill a large input to files under $TMPDIR, which no payload
 * names; the dev doc says so. */
export static const READ_VERBS: Record<string, ReadVerb> = {
  cat: { flags: { plain: ["n", "b", "s"], valued: [], optionsFirst: true }, maxPaths: 0, digitFlagIsCount: false },
  head: { flags: { plain: [], valued: ["n", "c"], optionsFirst: true }, maxPaths: 1, digitFlagIsCount: true },
  tail: { flags: { plain: [], valued: ["n", "c"], optionsFirst: true }, maxPaths: 1, digitFlagIsCount: true },
  wc: { flags: { plain: ["l", "w", "c", "m"], valued: [], optionsFirst: true }, maxPaths: 0, digitFlagIsCount: false },
  diff: { flags: { plain: ["u", "q", "N", "w", "b", "B", "--color=never"], valued: ["U"], optionsFirst: true }, maxPaths: 2, digitFlagIsCount: false },
  cmp: { flags: { plain: [], valued: [], optionsFirst: true }, maxPaths: 2, digitFlagIsCount: false },
  sort: { flags: { plain: ["n", "r", "u", "f", "b"], valued: ["k", "t"], optionsFirst: true }, maxPaths: 0, digitFlagIsCount: false },
  uniq: { flags: { plain: ["c", "d", "u", "i"], valued: [], optionsFirst: true }, maxPaths: 1, digitFlagIsCount: false },
  cut: { flags: { plain: [], valued: ["d", "f", "c"], optionsFirst: true }, maxPaths: 0, digitFlagIsCount: false },
  nl: { flags: { plain: [], valued: ["b"], optionsFirst: true }, maxPaths: 0, digitFlagIsCount: false },
  tac: { flags: { plain: [], valued: [], optionsFirst: true }, maxPaths: 0, digitFlagIsCount: false },
  rev: { flags: { plain: [], valued: [], optionsFirst: true }, maxPaths: 0, digitFlagIsCount: false }
}

/** One resolved path of a read verb. `argument` is the path as bash hands
 * it to the program. */
type ReadPath = { dir: string; filename: string; argument: string }

/** What a read verb reads: the files it names, or its stdin. */
type FileRead =
  | { kind: "stdin" }
  | { kind: "files"; paths: ReadPath[]; split: SplitArgs }

@capabilities(fileRead)
def readFileVerb(verb: string, command: SimpleCommand, cwd: string, spec: ReadVerb): Result<FileRead>
```

`readFileVerb`:

- When the row has `digitFlagIsCount`, first rewrites a short flag whose letters are all digits (`-20`) into the valued flag `-n` followed by the literal `20`, because `head -20 f` parses as the flag `-20` and the table has no letter `2`. Write this as `countFlagAsN(args: Word[], valued: string[]): Word[]`; `readFileVerb` reads the row, never the verb's name. It must not rewrite a digit flag that is the value of the flag before it: `head -n -5 a` parses as `-n`, `-5`, `a`, and GNU reads it as "all but the last five"; left alone, `-5` reaches `nextWordValue` as a flag word and is refused as not literal, which is the refusal we want. So the rewrite applies only when the previous word is not a flag in `valued`. Build the command to check as a new record, field by field (`tag`, `assignments`, `command`, `args: countFlagAsN(command.args)`, `redirects`), not with a spread.
- Runs `splitFlags(verb, <that command>, spec.flags)`.
- The value of `-n` and `-c` must be digits (`isDigits`), so `tail -n +5` and `head -n -5` are unrecognized with `"the value of \`-n\` is not a number"`.
- Each positional must be literal, or the command is unrecognized with `"the ${verb} path is not literal"`. No positional is `{ kind: "stdin" }`. More than `maxPaths` positionals (when `maxPaths` is not 0) is unrecognized: `"${verb} takes one path"` for 1, `"${verb} takes two paths"` for 2. `diff` and `cmp` with fewer than two is unrecognized with the same `"${verb} takes two paths"`.
- Each path resolves with `try _searchTargetIn(text, cwd, tildeModeFor(word))`. A failure (missing, special) is a failure. A result with `file == null` is unrecognized: `"${verb} would read a directory"`. `argument` is the result's `argument`.

- [ ] **Step 1: Write the failing test**

Add `readFileVerb` and `verbName` to the `import test { ... }` line, `READ_VERBS` to the plain import, and:

```
def filesOf(found: any): any {
  return match(found) {
    { kind: "stdin" } => "stdin"
    { kind: "files", paths } => [p.filename for p in paths]
  }
}

def readOf(source: string): any {
  const parsed = bashParser(source)
  if (parsed is failure(why)) {
    return "UNPARSEABLE"
  }
  const first = parsed.value[0]
  if (first is { tag: "simpleCommand" }) {
    const verb = verbName(first)
    const spec = READ_VERBS[verb]
    if (spec == null) {
      return "NOT A READ VERB"
    }
    return match(readFileVerb(verb, first, FIXTURES, spec)) {
      success(found) => filesOf(found)
      failure(why) => why
    }
  }
  return "NOT-SIMPLE"
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
    readOf("sort -u one.txt"),
    readOf("uniq -c one.txt"),
    readOf("cat"),
    readOf("head -n 3"),
    readOf("head one.txt two.txt"),
    readOf("uniq one.txt out.txt"),
    readOf("tail -n +5 one.txt"),
    readOf("head -n -5 one.txt"),
    readOf("tail -f one.txt"),
    readOf("cat -A one.txt"),
    readOf("cat $F"),
    readOf("cat *.txt"),
    readOf("diff one.txt"),
    readOf("diff -r one.txt two.txt"),
    readOf("cat ."),
    readOf("cat nope.txt"),
    readOf("sort -o out.txt one.txt"),
    readOf("cat one.txt -n"),
  ]
}
```

`expectedOutput`, row by row: `["one.txt"]`, `["one.txt","two.txt"]`, `["one.txt"]`, `["one.txt"]`, `["one.txt"]`, `["one.txt"]`, `["one.txt"]`, `["one.txt"]`, `["one.txt","two.txt"]`, `["one.txt"]`, `["one.txt"]`, `"stdin"`, `"stdin"`, `"head takes one path"`, `"uniq takes one path"`, `"the value of \`-n\` is not a number"`, `"the value of \`-n\` is not a number"`, `"tail does not take \`-f\`"`, `"cat does not take \`-A\`"`, `"the cat path is not literal"`, `"the cat path is not literal"`, `"diff takes two paths"`, `"diff does not take \`-r\`"`, `"cat would read a directory"`, the message `_searchTargetIn` throws for a missing path (run once and pin it), `"sort does not take \`-o\`"`, `"an option after the first argument is a file name to some versions of cat"`.

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
git commit -F /tmp/msg.txt   # "safeBash: the read-verb table says what cat, head, tail, wc, diff, cmp, and the filters read"
```

---

### Task 2: A read of named files asks `std::read` per path, on the bash path

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`Effect` gains a variant), `stdlib/safeBash.agency` (`effectsFor`, `raiseOne`, `READ_TOOL_FOR_VERB`)
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

- The default arm of `effectsFor`'s match (`_ => failure("no rule for ...")`) becomes a call to `otherVerbEffects(name.text, command, cwd, readsStdin, redirect.value)`, which looks the verb up in `READ_VERBS`. A hit matches on `readFileVerb`'s Result through a helper, as the grep arm does: `{ kind: "stdin" }` goes to `stdinStage(verb, readsStdin, redirects)`; `{ kind: "files", paths }` is one `readEffect({ dir, filename })` per path, then the redirects. A miss keeps today's `"no rule for \`${verb}\`"`. Task 4 adds `tr` to the same def.
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

`safeBash`'s `raises` clause already lists `std::read`.

- `outcomeOf` is unchanged: these plans are `bash` with no `broadReason`, so `narrow`.
- `READ_TOOL_FOR_VERB` gains `cat`, `head`, and `tail` pointing at `read`, so a rejected broad line made of those verbs names the tool. Not `wc`: the `read` tool cannot count lines.

- [ ] **Step 1: Write the failing test**

`grepNames` already returns `[effect names, broadReason]` for a plan over `FIXTURES`. Reuse it:

```
node readsAskStdRead() {
  return [
    grepNames("cat one.txt"),
    grepNames("cat one.txt two.txt"),
    grepNames("wc -l one.txt"),
    grepNames("diff one.txt two.txt"),
    grepNames("sort one.txt"),
    grepNames("cat one.txt > copy.txt"),
    grepNames("git status && cat one.txt"),
    grepNames("cat one.txt | head -3"),
    grepNames("head -3 one.txt | cat"),
    grepNames("cat"),
    grepNames("cat -A one.txt"),
    grepNames("tail -f one.txt"),
    grepNames("cat ."),
  ]
}
```

`expectedOutput`, row by row:

1. `[["std::read"],null]`
2. `[["std::read","std::read"],null]`
3. `[["std::read"],null]`
4. `[["std::read","std::read"],null]`
5. `[["std::read"],null]`
6. `[["std::read","std::write"],null]`
7. `[["std::git::status","std::read"],null]`
8. `[["std::read"],null]` (the `head -3` stage is a filter)
9. `[["std::read"],null]` (the `cat` stage is a filter)
10. `[["std::bash"],{"kind":"unrecognized","detail":"cat with no path reads stdin"}]`
11. ``[["std::bash"],{"kind":"unrecognized","detail":"cat does not take `-A`"}]``
12. ``[["std::bash"],{"kind":"unrecognized","detail":"tail does not take `-f`"}]``
13. `[["std::bash"],{"kind":"unrecognized","detail":"cat would read a directory"}]`

Row 1 shows the bash path here. Task 6 makes a lone `cat one.txt` shell-free; its effect list stays `["std::read"]`, so this row does not change then. Add the row `cat one.txt && git status` to `planOutcomes` (`tests/agency/safeBash.agency:437`) as `narrow`.

The symlink row, as its own node. `absoluteRedirectReportsParent` and `tildeRedirectQuoting` in the same file show how a fixture folder is made and removed; the link and its target go in a folder of their own, not in `FIXTURES`, because the grep parity rows search `FIXTURES` with `-r` and a link there would change their output. Clean up with the same safe delete those nodes use.

```
node readPayloadNamesTheRealParent(): boolean {
  // In a temp folder T: T/outside/target.txt, T/inside/link.txt -> ../outside/target.txt.
  // planFor("cat link.txt", T/inside): the std::read payload's dir is the real path of T/outside.
}
```

- [ ] **Step 2: Run to see it fail.** Rows 1 through 9 come back `std::bash` with ``no rule for `cat` ``.

- [ ] **Step 3: Implement.** `make`.

- [ ] **Step 4: Run; all pass. Commit**

```bash
git add stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json docs/site/stdlib/safeBash.md
git commit -F /tmp/msg.txt   # "safeBash: a read of a named file asks std::read per path"
```

---

### Task 3: `< file` asks `std::read`

**Files:**
- Modify: `stdlib/safeBash.agency` (`redirectEffect`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `readEffect` (Task 2), `prepareRedirectWrite` (main).
- Changes `redirectEffect(redirects, cwd)`: a redirect with op `<` and no explicit fd, to a literal target, contributes `readEffect({ dir, filename })`, resolved with `_searchTargetIn` and `tildeModeFor(target)` under the same rules as a read path (a folder, a FIFO, or a missing file is a failure). One input redirect and one output redirect may both appear (`git status < in.txt > out.txt` is a read and a write). Two of the same direction (`"more than one input redirect"`), an explicit fd, or a non-literal target stay failures. `prepareRedirectWrite` is unchanged, so the shell-free write path still refuses any `<`.
- A stdin reader with only an input redirect (`cat < one.txt`, `sort < in.txt`) names no path and is not in a pipe, so it stays unrecognized through `stdinStage`. The redirect's `std::read` is computed and then dropped with the rest of the line's effects, as any unrecognized line's are.

- [ ] **Step 1: Write the failing test**

```
node inputRedirectIsARead() {
  return [
    grepNames("git status < one.txt"),
    grepNames("cat < one.txt"),
    grepNames("echo hi < one.txt > copy.txt"),
    grepNames("git status < $F"),
    grepNames("git status < one.txt < two.txt"),
    grepNames("git status < ."),
  ]
}
```

`expectedOutput`: `[["std::git::status","std::read"],null]`, `[["std::bash"],{"kind":"unrecognized","detail":"cat with no path reads stdin"}]`, `[["std::read","std::write"],null]`, ``[["std::bash"],{"kind":"unrecognized","detail":"`variable` is not fully literal"}]``, `[["std::bash"],{"kind":"unrecognized","detail":"more than one input redirect"}]`, `[["std::bash"],{"kind":"unrecognized","detail":"an input redirect would read a directory"}]`.

Also add `"echo hi < one.txt"` to `shellFreeEcho`'s rows as `"bash"`, if it is not there, so the write path's refusal of `<` is pinned.

- [ ] **Step 2: Run to see it fail.** Rows 1 and 3 come back broad with ``` `<` is not an output redirect ```.

- [ ] **Step 3: Implement. `make`. Run; all pass. Commit**

```bash
git commit -F /tmp/msg.txt   # "safeBash: an input redirect asks std::read"
```

---

### Task 4: `tr`, and the filters in a pipe

**Files:**
- Modify: `stdlib/safeBash.agency` (`TR_FLAGS`, `trEffects`, `otherVerbEffects`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `otherVerbEffects` (Task 2), `stdinStage`, `splitFlags`.
- Produces:

```
/** tr reads only its stdin; its positionals are character sets, not
 * paths. optionsFirst stays true: BSD tr reads `tr a b -d` as three
 * operands and prints a usage error, GNU reads -d as a flag. */
static const TR_FLAGS: FlagSpec = { plain: ["d", "s"], valued: [], optionsFirst: true }

/** How many sets tr takes, by the plain flags given (sorted, joined):
 * the least and the most. `tr -s a b` squeezes after translating. */
static const TR_SET_COUNTS: Record<string, { least: number; most: number }> = {
  "": { least: 2, most: 2 },
  d: { least: 1, most: 1 },
  s: { least: 1, most: 2 },
  ds: { least: 2, most: 2 }
}

def trEffects(command: SimpleCommand, readsStdin: boolean, redirects: Effect[]): Result<Effect[]>
```

`trEffects` runs `splitFlags("tr", command, TR_FLAGS)`, looks the sorted plain flags up in `TR_SET_COUNTS`, and checks that the positionals, each literal, number between `least` and `most`. Any other count is `"tr takes ${least} to ${most} sets here"` (so `tr takes 2 to 2 sets here` for `tr a`; one wording, no spelled-out variants). Then `stdinStage("tr", readsStdin, redirects)`.

In `otherVerbEffects`, after the `READ_VERBS` lookup misses: `"tr"` goes to `trEffects`.

- [ ] **Step 1: Write the failing test**

```
node filtersInAPipe() {
  return [
    grepNames("git log | sort | uniq -c"),
    grepNames("cat one.txt | sort -u"),
    grepNames("cat one.txt | cut -d : -f 1"),
    grepNames("cat one.txt | tr a b"),
    grepNames("cat one.txt | tr -d x"),
    grepNames("cat one.txt | tr -s a b"),
    grepNames("cat one.txt | tr a"),
    grepNames("cat one.txt | sort two.txt"),
    grepNames("cat one.txt | sort -o out.txt"),
    grepNames("sort one.txt"),
    grepNames("git log | tee log.txt"),
    grepNames("git log | xargs echo"),
    grepNames("git log | sort > sorted.txt"),
    grepNames("git log | tac"),
    grepNames("cut -d, -f1 one.txt"),
  ]
}
```

`expectedOutput`: `[["std::git::log"],null]`, `[["std::read"],null]`, `[["std::read"],null]`, `[["std::read"],null]`, `[["std::read"],null]`, `[["std::read"],null]`, `[["std::bash"],{"kind":"unrecognized","detail":"tr takes 2 to 2 sets here"}]`, `[["std::read","std::read"],null]`, ``[["std::bash"],{"kind":"unrecognized","detail":"sort does not take `-o`"}]``, `[["std::read"],null]`, ``[["std::bash"],{"kind":"unrecognized","detail":"no rule for `tee`"}]``, ``[["std::bash"],{"kind":"unrecognized","detail":"no rule for `xargs`"}]``, `[["std::git::log","std::write"],null]`, `[["std::git::log"],null]`, `[["std::bash"],{"kind":"unparseable","detail":<the parser's message, pinned from one run>}]`.

The last row pins the comma limit: `cut -d, -f1`, `sort -t, -k2`, and `sort -k2,2n` are unparseable today (checked against the built parser on 2026-10-31; the space-separated `cut -d : -f 1` parses as flag, literal, flag, literal).

- [ ] **Step 2: Run to see it fail.** Rows 4 through 7 come back ``no rule for `tr` ``.

- [ ] **Step 3: Implement. `make`. Run; all pass. Commit**

```bash
git commit -F /tmp/msg.txt   # "safeBash: tr is a filter in a pipe"
```

---

### Task 5: End to end: one question, no shell for the question, the right payload

**Files:**
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

No production change. These nodes run `safeBash` and check the interrupts, following `loneGrepAsksOneQuestion`, `grepUnderRecommendedNeedsNoPrompt`, and `grepOutsideTheLaunchDirIsUndecided`.

- [ ] **Step 1: Write the tests**

```
node readUnderRecommendedNeedsNoPrompt() {
  // wc -l one.txt && git status under recommended: both approved, output is the count then the status.
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
- Modify: `stdlib/safeBash/actions.agency` (`Execution` gains `ReadExec`, `runRead`), `stdlib/safeBash.agency` (`tryShellFreeRead`, `planFor`, `outcomeOf`, the `agency-lang/stdlib-lib/...` import line for the new helper)
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
  view: ReadView
}
// Execution gains ReadExec.

@capabilities(fileRead)
export def runRead(exec: ReadExec, command: string): Result<string>
```

`runRead` calls `try _read(exec.payload.dir, exec.payload.filename)` with no offset or limit, which returns the raw text (`sliceLines` returns the text untouched when both are unset, `lib/stdlib/builtins.ts:198`; the parity test proves it). A failure is returned as it came, the way `runGrep` returns `_grep`'s failure (`actions.agency:258`): the plan refused a missing file or a folder before anything ran, so only a race or a permission error reaches here, and `_read`'s own message says which. On success it returns `keepOutput(_renderReadView(text, exec.view), 0, command)`.

In `lib/stdlib/readDialect.ts`, pure, no host access:

```ts
export type ReadView = { kind: "whole" } | { kind: "numbered" } | { kind: "head"; lines: number } | { kind: "tail"; lines: number };
/** What cat, cat -n, head -n, or tail -n prints for `text`. */
export function _renderReadView(text: string, view: ReadView): string;
```

The rules the function follows, each pinned by a `readDialect.test.ts` case:

- `whole`: the text as is.
- `numbered`: every line, including a final line with no newline, prefixed by its 1-based number right-aligned in 6 columns and a tab (`%6d\t`), the format GNU and BSD share. An empty file prints nothing. A line is a run ending in `\n`; a final run with no `\n` is a line that keeps no `\n`.
- `head`: the first `lines` lines, each with its `\n` if it had one.
- `tail`: the last `lines` lines. A file whose last byte is not `\n` has a final partial line that counts as one.

`lines` is always at least 1 here; `tryShellFreeRead` refuses 0 (below).

In `stdlib/safeBash.agency`, `tryShellFreeRead(command, cwd): Result<Plan>`, called from `planFor`'s lone-command branch after `tryShellFreeGrep`:

- The verb is `cat`, `head`, or `tail`; no assignments; no redirects; otherwise "not a lone read".
- `readFileVerb` with the verb's `READ_VERBS` row, matched through a helper def. `{ kind: "stdin" }` is a failure ("a lone read with no path reads stdin"). More than one path is a failure ("the shell-free path reads one file").
- The flags allowed here are narrower than the row: `cat` with no flag is `whole`, `cat -n` is `numbered`, `cat -b` or `-s` is a failure ("not rendered shell-free"); `head -c` and `tail -c` are failures for the same reason. `head` and `tail` read their count from `split.values` (the `n` entry), 10 when absent. A count of 0 is a failure ("a count of 0 is refused shell-free"): BSD `head -n 0` prints `head: illegal line count -- 0` and exits 1 while GNU prints nothing, so no one rendering is right everywhere; the bash path runs whichever head is installed.
- The plan: `effects: [readEffect(payload)]`, `execution: { kind: "read", payload, view }`, `broadReason: null`, `verbs: verbNames([command])`.

`outcomeOf` gains `"read" => "shellFree"`. `safeBash`'s dispatch gains `{ kind: "read" } => runRead(exec, command)`.

- [ ] **Step 1: Write the failing unit test** for `_renderReadView` in `lib/stdlib/readDialect.test.ts`: whole; numbered on `"a\nb\n"` gives `"     1\ta\n     2\tb\n"`; numbered on `"a\nb"` gives `"     1\ta\n     2\tb"`; numbered on `""` gives `""`; head 1 of `"a\nb\n"` gives `"a\n"`; head 5 of `"a\n"` gives `"a\n"`; tail 1 of `"a\nb\n"` gives `"b\n"`; tail 1 of `"a\nb"` gives `"b"`; tail 2 of `"a\r\nb\r\n"` gives `"a\r\nb\r\n"`; tail 5 of `"a\n"` gives `"a\n"`.

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
    outcomeOf(planFor("head -c 5 one.txt", FIXTURES)),
    outcomeOf(planFor("head -n 0 one.txt", FIXTURES)),
    outcomeOf(planFor("cat one.txt two.txt", FIXTURES)),
    outcomeOf(planFor("cat one.txt > copy.txt", FIXTURES)),
    outcomeOf(planFor("cat one.txt | head", FIXTURES)),
    outcomeOf(planFor("wc -l one.txt", FIXTURES)),
    outcomeOf(planFor("cat nope.txt", FIXTURES)),
  ]
}
```

`expectedOutput`: `["shellFree","shellFree","shellFree","shellFree","narrow","narrow","narrow","narrow","narrow","narrow","narrow","broad"]`.

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

Add three fixtures: `noeol.txt` (two lines, no final newline), `empty.txt` (zero bytes), `crlf.txt` (two lines ending `\r\n`). Put them in a new `tests/agency/stdlib/read-fixtures/` with a copy of `one.txt`, and point `readParityOf` there, so no grep parity row's output changes.

`expectedOutput`: fourteen `true`.

```
node loneReadAsksOneQuestion() {
  // As loneGrepAsksOneQuestion: one std::read, no std::bash, success with the file's text.
}
```

- [ ] **Step 4: Run to see them fail.** `loneReadIsShellFree` rows 1 through 4 are `narrow`; the parity rows are `"NOT SHELL-FREE: ..."`.

- [ ] **Step 5: Implement. `make`. Run; all pass.** Then `pnpm vitest run lib/stdlibCapabilities.test.ts`; if `tryShellFreeRead` or `runRead` is reported, add it to the allow list the way `bashParser` is.

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/readDialect.ts lib/stdlib/readDialect.test.ts stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json tests/agency/stdlib/read-fixtures docs/site/stdlib/safeBash.md
git commit -F /tmp/msg.txt   # "safeBash: a lone cat, head, or tail runs the read tool's read"
```

---

### Task 7: Docs, the spec's departures, checks, PR

**Files:**
- Modify: `docs/dev/stdlib/safe-bash.md`, `docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, `CLAUDE.md` (the `safe-bash.md` index line), `.claude/skills/agency-stdlib-docs/SKILL.md` (the same line; the file is tracked but gitignored, so `git add -f` it in a command of its own)

- [ ] `docs/dev/stdlib/safe-bash.md`, mechanism and rule only, no dates and no "departure" language: a new section after "Outcomes", "In process when it translates", stating the rule from this plan's second paragraph, with the grep and read rows as the two instances and the reasons (the approval is the action; one output everywhere; hosts with no shell), and one sentence saying what it is not (a defense against a trojaned binary; the bash path still runs the user's `PATH`). Then a section "The read family": the `READ_VERBS` table and what each left-out flag would have meant; why a path must be a regular file (the `diff -r` and FIFO cases); `readFileVerb` and `FileRead`; the bash path's one `std::read` per path and why `recommended` already approves it; `< file`; the filters as read verbs, `tr` as the one set-taking verb, that `tac` is missing on macOS, that `sort` may spill to `$TMPDIR`, and that the comma forms are unparseable; the shell-free rows (`cat`, `cat -n`, `head`, `tail`, one file, count at least 1) and `readDialect.ts` with the four rendering rules; the "left out" list from this plan; and the resolve-before-run note from the grep section, which now covers reads too.
- [ ] The spec, Part 5: a "Departures for the read family (ADI-244)" note after the existing grep departures, with the four bullets from this plan's header, in the same style.
- [ ] Update the "Files and tests" list and the `CLAUDE.md` and skill index lines for `safe-bash.md` to mention the read family and `readDialect.ts`.
- [ ] A tarsec ticket for a comma inside a flag value or a bare word (`sort -t, -k2`, `cut -d, -f1`, `sort -k2,2n`), under M6, blocking nothing. Linear writes may be refused in auto mode; if so, put the ticket text in the PR body for the owner.
- [ ] Run `pnpm run typecheck`, `pnpm run lint:structure`, `pnpm vitest run lib/stdlib/readDialect.test.ts lib/stdlibCapabilities.test.ts`, each saved to a file. Run `/anti-pattern-check` on the diff. Open the PR against `main` with the body in a file; the owner merges.
