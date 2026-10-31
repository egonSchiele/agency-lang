# safeBash: `grep` raises `std::grep` (ADI-242) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When safeBash can describe a bash `grep` exactly, it asks the same `std::grep` question the grep tool asks. The `recommended` policy's read rules then approve it under the launch directory, and the model's most common shell habit stops prompting.

**The rule above all others:** safeBash must never misread a command. When there is any doubt about what a `grep` will read or do, the command is unrecognized and asks the broad `std::bash` question. Asking the user one more question is acceptable. Asking a narrow question about a command that does something else is a security hole, because a policy approves what the payload describes, and the command would do something different.

## Background

There are two different things called grep, and this plan uses both.

- **The grep tool** (`grep` in `stdlib/shell.agency`) does not run a program. Agency walks the directory itself and tests each line against a JavaScript regex (`_grep` in `lib/stdlib/shell.ts`). The walk skips `node_modules`, `.git`, `dist`, `build`, `.next`, `.cache` (`SKIP_DIRS`, `lib/stdlib/shell.ts:365`), and by default anything `.gitignore` ignores. It never follows a symlink below the path. It raises `std::grep` before it searches.
- **The grep program** is whatever `grep` the shell finds. That is GNU grep on Linux and CI, ugrep on recent macOS (`/usr/bin/grep` on the owner's machine is ugrep 7.8.4), and BSD grep on older macOS. `grep -r` reads every file under the path, including `.git/config`, which can hold a token in a remote URL. ugrep also has flags that run programs (`--filter`) and write files (`--save-config`).

Both raise `std::grep` with the same `dir`, so a policy cannot tell them apart. A policy author who approves `std::grep` under the launch directory is approving what the tool does. So safeBash handles a `grep` in one of two ways.

1. **A lone `grep` runs through the grep tool's own search.** A lone grep is the whole command line, with no pipe, no `&&`, and no redirect. This applies when its flags and pattern translate exactly. No shell starts, and the approval means what it means for the tool. This is the same move safeBash already makes for a lone `echo`, which it computes without a shell.
2. **Any other `grep` runs through bash**, and gets a narrow question only when its path is one file. A file named on the command line is read the same way by the program and the tool. A directory search through bash reads files the tool skips, so it asks `std::bash`.

Everything else asks `std::bash`.

| Command | What happens |
|---|---|
| `grep -rn hello src` | lone, translates: the grep tool's search, `std::grep` with `dir: <cwd>/src` |
| `grep -n hello one.txt` | lone, translates: the grep tool's search, `std::grep` with `file: "one.txt"` |
| `grep -rn "a+b" src` | lone, but `+` means different things in grep and JavaScript, so it does not translate; a directory through bash: `std::bash` |
| `grep -n "a+b" one.txt` | does not translate; one file through bash: `std::grep` with `file: "one.txt"`, then real grep runs |
| `grep -c hello one.txt` | the tool has no `-c`; one file through bash: `std::grep`, then real grep runs |
| `grep -rn hello src \| head -20` | not lone; a directory through bash: `std::bash` |
| `git status \| grep hello` | not lone; no path and no `-r`: `std::bash` (the follow-up plan narrows this) |
| `grep -R hello .`, `grep --filter=x hello .` | the flag is not in the table: `std::bash` |

**Architecture:** One flag table says which flags `grep` may carry. One helper, `splitFlags`, checks a command against it and returns the flags, their values, and the remaining positional words, or a failure. `readGrep` turns that into the pattern and one resolved path, using the same split the grep tool uses: a directory gives `dir`, and a file gives its parent as `dir` and its name as `file`. Two rules use `readGrep`:

- `tryShellFreeGrep`, for a lone grep. It translates the flags and pattern, and returns a plan that raises `std::grep` and runs `_grep`. Both sides of the plan are built from one payload, the way `writeEffect` and `writeExecution` are.
- `grepEffects`, the `effectsFor` arm for every other grep. It raises `std::grep` only for a file target.

Two pure TypeScript helpers do the parts that need careful unit testing: translating a grep pattern into a JavaScript regex, and rendering matches the way grep prints them.

**Tech Stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), TypeScript (`lib/stdlib/shell.ts`, a new `lib/stdlib/grepDialect.ts`), vitest, Agency execution tests.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-242/packages/agency-lang/docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 5 (the `grep`/`rg` row) and Part 6 (ownership). Linear: ADI-242. ADI-238 and ADI-241 have merged.

**Reviews this plan answers:**
- `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-242/packages/agency-lang/docs/superpowers/plans/2026-10-31-safebash-grep-std-grep-REVIEW.md`
- `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-242/packages/agency-lang/docs/superpowers/plans/2026-10-31-safebash-grep-std-grep-REVIEW-2.md`

**Follow-up plan:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-242/packages/agency-lang/docs/superpowers/plans/2026-10-31-safebash-filter-stages.md` teaches safeBash that a `grep` with no path at the end of a pipe reads only its stdin. It runs after this plan.

## Departures from the spec

The owner decided these on 2026-10-31. Task 7 writes them into the spec.

- A lone grep runs through the grep tool's search, and is not passed to bash. The spec had every recognized grep run through bash.
- A grep that runs through bash gets a narrow question only for a file path. A directory search through bash reads files the tool skips.
- `rg` stays unrecognized in this slice. Its letters mean different things from grep's (`-r` is `--replace` and takes a value, `-E` is `--encoding`, `-h` is `--help`). With no path, it reads stdin or the working directory depending on what stdin it was given. It reads extra flags from the file named by `RIPGREP_CONFIG_PATH`, which can add `--pre=COMMAND`.
- The payload's `flags` is `""`, and the table takes neither `R` nor `m`.
- The table takes none of the file filters (`--include`, `--exclude`, `--exclude-dir`). The shell-free path cannot carry them out, and the bash path is narrow only for one named file, where a filter changes nothing. A grep that uses one asks `std::bash`. The slice that first narrows a directory search can add them, with a test that gives them a use.
- The rejection hint does not claim the tools need no approval. safeBash cannot see the policy.

## Global Constraints

- Every plan raises at least one effect before anything runs, and the executors are reachable only after `raiseAll` succeeds. `runGrep` calls `_grep`, not the `grep` tool, for the same reason `runBash` calls `_bash`: the tool would raise `std::grep` a second time. Put the same justification comment on it.
- The payload tells the truth. For the shell-free path, the payload and the execution are built from one `GrepPayload`, so they cannot disagree. Its `pattern` is the JavaScript regex the search uses. With `-F`, that is the escaped text, which is exactly what the tool will match.
- The flag table is an allowlist. It must hold for GNU grep, ugrep, and BSD grep, because the bash path runs whichever one the shell finds.
- On the bash path, every flag comes before the first positional word. GNU grep reorders its arguments, so `grep -n hello one.txt -s` means the flag `-s` there. BSD grep stops reading options at the first operand, and so does GNU grep when `POSIXLY_CORRECT` is set. For them, `-s` is a second file to search, which the payload would not name. The shell-free path never runs real grep, so it reads flags anywhere, as GNU does.
- `keepOutput` is changing on another branch. The tool trace display plan (`/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-tool-trace-display/packages/agency-lang/docs/superpowers/plans/2026-10-31-agent-tool-trace-display.md`) adds a parameter to it and updates its safeBash callers. This plan adds a caller in `runGrep`. Whichever branch merges second must update the other's call. The compiler reports the mismatch, so it cannot slip through.
- safeBash never expands anything. A pattern or path that is not a literal word (a variable, an interpolated word, an unquoted glob) makes the command unrecognized.
- The effect declaration travels with an import. Add `grep` to the existing `import { bash, ExecResult } from "std::shell"` at `stdlib/safeBash.agency:8`, and name `std::grep` in the comment at lines 1-5.
- Push logic that needs careful testing into TypeScript, as pure functions: the pattern translation and the rendering. Keep the decisions in Agency, where the rest of safeBash's rules live.
- `make` after `.agency` changes; `pnpm run build` after `.ts` changes; `pnpm run typecheck`, `pnpm run lint:structure`, and prettier on named `.ts` files; absolute paths inside any script; never force-push.
- Test fixtures: `tests/agency/stdlib/grep-fixtures/` already exists (from PR #1309). `one.txt` holds `hello world`, `foo bar baz`, `hello again`. `two.txt` holds `goodbye cruel world`, `HELLO uppercase`. Use `__dirname + "/stdlib/grep-fixtures"` from `tests/agency/safeBash.agency`, because the Agency test runner's cwd is not the test file's directory. Do not add files there: the parity test in Task 5 depends on the directory holding no ignored or skipped files.

## How the parser hands grep's arguments over

I checked these against the bash parser (tarsec). They decide the rules in Task 2.

| Source | Words |
|---|---|
| `grep -A 3 foo src` | flag `-A`, literal `3`, literal `foo`, literal `src` |
| `grep -m5 foo .` | flag `-m5` (one flag; the letter and digits are not split) |
| `grep -rni "foo bar" src` | flag `-rni`, doubleQuoted `foo bar`, literal `src` |
| `grep --color=never x .` | flag with `flagName: "--color"`, `flagValue: "never"` |
| `grep -rn x --include=*.ts src` | flag `--include` with `flagValue: "*.ts"`, `valueIsGlob: true` (not in the table, so unrecognized) |
| `grep -rn x --include='*.ts' src` | an `interpolatedVariable` word, NOT a flag (a positional that is not literal, so unrecognized) |
| `grep -nA3 foo src` | flag `-nA3` (one word; `A` takes the rest, `3`, as its value) |
| `grep -e a -e b .` | flag `-e`, literal `a`, flag `-e`, literal `b`, literal `.` |
| `grep "-R" src` | doubleQuoted `-R`, literal `src` (bash strips the quotes, so grep sees the option `-R`) |
| `grep foo -` | parse failure |

## Review Focus

- The translation table in Task 3: every character it accepts must mean the same thing to grep and to a JavaScript regex. The parity test in Task 5 runs real grep beside the shell-free path on the same commands and compares the output.
- `grep -rn hello src | head`: not lone, and a directory through bash, so it asks `std::bash`.
- `grep "-R" src`, `grep -R`, `grep -e a -e b`, `grep -e "-x"`, `grep --filter=x`, `grep --save-config`, `grep --include=*.ts`: each is unrecognized.
- `git status && grep -n hello one.txt -s`: a flag after the first positional is a file name to BSD grep, so the bash path refuses it. A lone `grep -n hello one.txt -s` runs shell-free, where no real grep reads the arguments.
- `grep -rnw " world" .`: `-w` with a pattern that starts or ends with a non-word character matches different lines in JavaScript, so it does not run shell-free.
- `grep -rn foo /etc`: the shell-free path raises `std::grep` with the real path of `/etc`, and `recommended` leaves it undecided.
- `grep -rn foo missing-dir`: unrecognized. `planFor` does not throw.

---

### Task 1: A search target resolved against a given cwd

**Files:**
- Modify: `lib/stdlib/prepareContainedPath.ts` (extract `resolveAgainstCwd`)
- Modify: `lib/stdlib/shell.ts` (new `_searchTargetIn` beside `_searchTarget`)
- Test: `lib/stdlib/shell.test.ts`; the existing redirect tests must still pass unchanged

**Interfaces:**
- Consumes: `_searchTarget(given, tool)` (`lib/stdlib/shell.ts:479`); `resolveRedirectTarget` and `TildeMode` (`lib/stdlib/prepareContainedPath.ts:33-55`).
- Modify `lib/stdlib/prepareContainedPath.ts`. `resolveRedirectTarget` opens with three steps that a grep path needs too: refuse an empty cwd, resolve the cwd with `resolveCwdPath`, and expand a leading `~` only in `"expand"` mode. Move them into two exported functions, so there is one copy of the tilde rule:
  - `expandTilde(target: string, tildeMode: TildeMode): string` is the path as bash hands it to the program: `expandPath` in `"expand"` mode, unchanged in `"literal"` mode.
  - `resolveAgainstCwd(target: string, cwd: string, tildeMode: TildeMode, refusal: string): string` refuses an empty cwd with `"${refusal} refused: cwd must not be empty."`, and returns `expandTilde(...)` resolved against the cwd. `resolveRedirectTarget` calls it with `refusal: "redirect"`, so its message stays the same.
- Produces, in `lib/stdlib/shell.ts`:

```ts
/** A grep path resolved for safeBash. `argument` is the path as bash hands
 *  it to grep, with `~` expanded. grep prints file names starting from
 *  it, so the shell-free path renders names from it too. */
export type GrepTarget = { dir: string; file: string | null; argument: string };

export async function _searchTargetIn(
  given: string,
  cwd: string,
  tildeMode: TildeMode,
): Promise<GrepTarget>;
```

  It returns `_searchTarget(resolveAgainstCwd(given, cwd, tildeMode, "grep"), "grep")` with `argument: expandTilde(given, tildeMode)`. `expandPath` throws on `~user`, and that throw stays a failure.

- [ ] **Step 1: Write the failing tests**

In `lib/stdlib/shell.test.ts`, add `describe("_searchTargetIn resolves a grep path against a cwd")`, using the temp-directory setup the `_searchTarget` tests at line 428 already use:

- a relative directory under `cwd` gives `{ dir: <root>/sub, file: null, argument: "sub" }`
- a relative file under `cwd` gives `{ dir: <root>, file: "notes.md", argument: "notes.md" }`
- `"."` gives `{ dir: <root>, file: null, argument: "." }`
- a missing path rejects with `/No file or directory at/`
- `"~"` in `"literal"` mode resolves to a directory named `~` under `cwd` (create it first), with `argument: "~"`. `"~"` in `"expand"` mode resolves to `os.homedir()`, compared after `fs.realpathSync`, with `argument` equal to `os.homedir()`.
- `"~root"` in `"expand"` mode rejects
- an empty cwd rejects with `"grep refused: cwd must not be empty."`

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run lib/stdlib/shell.test.ts -t _searchTargetIn > /tmp/242-t1-red.txt 2>&1; tail -5 /tmp/242-t1-red.txt`

- [ ] **Step 3: Implement, run to see them pass, then `pnpm run build`**

Compose the existing pieces. Do not add any new walking. Run: `pnpm vitest run lib/stdlib/shell.test.ts > /tmp/242-t1.txt 2>&1; tail -3 /tmp/242-t1.txt; pnpm run build > /tmp/242-build.txt 2>&1; tail -1 /tmp/242-build.txt`

- [ ] **Step 4: Commit**

```bash
git add lib/stdlib/prepareContainedPath.ts lib/stdlib/shell.ts lib/stdlib/shell.test.ts
git commit -F /tmp/msg.txt   # "shell: a search target resolved against a given cwd"
```

---

### Task 2: `splitFlags` and the flag table

**Files:**
- Modify: `stdlib/safeBash.agency` (the types, `splitFlags`, `GREP_FLAGS`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

```
/** Which flags a verb takes. Short letters are listed one per entry, so a
 *  combined `-rn` is checked letter by letter. A long flag that takes no
 *  value is listed as written (`--color=never`). */
export type FlagSpec = {
  /** Flags that stand alone. */
  plain: string[];
  /** Flags that take a value, from the rest of the word (`-A3`), after
   *  `=` (`--regexp=x`), or from the next word (`-A 3`). Each may appear
   *  once. */
  valued: string[];
  /** Every flag must come before the first positional word. True for a
   *  command real grep will run: BSD grep reads a later `-s` as a file. */
  optionsFirst: boolean
}

export type FlagValue = {
  flag: string;
  value: string
}

export type SplitArgs = {
  plain: string[];
  values: FlagValue[];
  positionals: Word[]
}

def splitFlags(verb: string, command: SimpleCommand, spec: FlagSpec): Result<SplitArgs>
```

`splitFlags` walks `command.args` in order. `verb` is used only in failure messages. The walk follows these rules:

1. **A `flag` word whose name starts with `--`.** If `renderFlag(word)` is in `spec.plain`, add it to `plain`. Otherwise, if `flagName` is in `valued`, the value is `flagValue` when present, else the next word. A `flagValue` with `valueIsGlob` fails, because bash may expand it. Anything else fails with ``grep does not take `--name` ``.
2. **A `flag` word with one dash.** Take the letters after the dash, one at a time. A letter in `plain` is added. A letter in `valued` takes the rest of the word as its value when the rest is non-empty (`-A3`), else the next word. Any other letter fails with ``grep does not take `-z` ``. A one-dash flag with a `flagValue` fails.
3. **A value taken from the next word** must pass `literalWordText`, and rule 5 applies to it too. So `grep -e "-x" one.txt` is refused, even though grep would search for `-x`. A refusal here only costs one question, and it keeps one rule for every quoted word.
4. **A missing value.** A valued flag with nothing after it fails with ``grep's `-A` needs a value``.
5. **A repeat.** A valued flag that appears twice fails with ``grep takes `-e` only once``. For `grep -e a -e b`, a payload with one pattern would misdescribe the search.
6. **A quoted word that starts with `-`.** When `literalWordText(word)` succeeds and the text starts with `-`, fail with ``a quoted `-R` is still an option to grep``. Bash strips the quotes, so `grep "-R" src` runs `grep -R src`.
7. **A flag after a positional.** When `spec.optionsFirst` is true and a flag word comes after a positional word, fail with ``an option after the first argument is a file name to some greps``.
8. Every other word is a positional, including words that are not literal. `readGrep` checks those.

```
static const GREP_FLAGS: FlagSpec = {
  plain: ["n", "r", "i", "w", "l", "v", "E", "F", "c", "h", "H", "o", "s", "--color=never"],
  valued: ["e", "A", "B", "C"],
  optionsFirst: true
}
```

What the table leaves out on purpose:

- `-R`, which follows every symlink below the path.
- `-f`, `--exclude-from`, `--include-from`, which read another file.
- `--include`, `--exclude`, `--exclude-dir`, which no path in this slice can use (see "Departures from the spec").
- `-m`, which grep counts per file.
- `-P`, which BSD grep lacks.
- `-z`, `-d`, `-D`, which mean different things in different greps.
- ugrep's `--filter`, which runs a program, and `--save-config`, which writes a file.
- Every long spelling of a short flag (`--recursive`, `--ignore-case`).

Each of these is unrecognized and asks `std::bash`. Put this list in a comment above `GREP_FLAGS`, one line per flag with its reason. I checked the table's letters in GNU grep's manual and in ugrep 7.8.4's `--help`, and each means the same thing in both. Check them against BSD grep's `man grep` during execution, and record the result in the dev doc.

- [ ] **Step 1: Write the failing test**

`splitFlags` is not exported. Import it with `import test { splitFlags, GREP_FLAGS } from "std::safeBash"`, as `tests/agency-js/data-wikidata/agent.agency:1` does.

```
def split(source: string): any {
  const parsed = bashParser(source)
  if (parsed is failure(why)) {
    return "UNPARSEABLE"
  }
  const result = splitFlags("grep", parsed.value[0], GREP_FLAGS)
  if (result is failure(why)) {
    return why
  }
  const args = result.value
  const values = [entry.flag + "=" + entry.value for entry in args.values]
  return [args.plain, values, args.positionals.length]
}

node splitGrepFlags() {
  return [
    split("grep -rni hello ."),
    split("grep -A 3 hello ."),
    split("grep -A3 hello ."),
    split("grep -e hello ."),
    split("grep --color=never hello ."),
    split("grep -nA3 hello ."),
    split("grep -z hello ."),
    split("grep -R hello ."),
    split("grep -e a -e b ."),
    split("grep \"-R\" hello"),
    split("grep -A"),
    split("grep --filter=x hello ."),
    split("grep --save-config hello ."),
    split("grep --include=*.ts -rn hello ."),
    split("grep -e \"-x\" one.txt"),
    split("grep -n hello one.txt -s"),
  ]
}
```

`expectedOutput`, row by row:

1. `[["r","n","i"],[],2]`
2. `[[],["A=3"],2]`
3. `[[],["A=3"],2]`
4. `[[],["e=hello"],1]`
5. `[["--color=never"],[],2]`
6. `[["n"],["A=3"],2]`
7. ``"grep does not take `-z`"``
8. ``"grep does not take `-R`"``
9. ``"grep takes `-e` only once"``
10. ``"a quoted `-R` is still an option to grep"``
11. ``"grep's `-A` needs a value"``
12. ``"grep does not take `--filter`"``
13. ``"grep does not take `--save-config`"``
14. ``"grep does not take `--include`"``
15. ``"a quoted `-x` is still an option to grep"``
16. ``"an option after the first argument is a file name to some greps"``

- [ ] **Step 2: Run to see it fail.** Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/242-t2-red.txt 2>&1; grep -n "splitGrepFlags" -A4 /tmp/242-t2-red.txt | head`

- [ ] **Step 3: Implement** the three types, `splitFlags`, and `GREP_FLAGS`, with the comment.

- [ ] **Step 4: `make`; run to see it pass.** Run: `make > /tmp/242-make2.txt 2>&1; tail -2 /tmp/242-make2.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/242-t2.txt 2>&1; tail -3 /tmp/242-t2.txt`

- [ ] **Step 5: Commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: a flag table and the split that checks a command against it"
```

---

### Task 3: Translating a grep pattern, and printing matches the way grep does

**Files:**
- Create: `lib/stdlib/grepDialect.ts`, `lib/stdlib/grepDialect.test.ts`

This file holds two pure functions, with no file access and no host. One file, one concept: what a grep command means in terms of the grep tool's search.

**Interfaces:**

```ts
export type GrepSyntax = "basic" | "extended" | "fixed";

/** The JavaScript regex source that matches exactly what grep would match
 *  for `pattern`, or null when the pattern uses anything whose meaning
 *  differs between grep and JavaScript. `wholeWord` is grep's -w, which
 *  the tool carries out as `\b(?:pattern)\b`. A null sends the command
 *  to the bash path, never to a guess. */
export function _grepPatternToRegex(
  pattern: string,
  syntax: GrepSyntax,
  wholeWord: boolean,
): string | null;

/** grep's output for these matches: `name:line:text` lines, or names
 *  alone for a files-only search, each ending in a newline. */
export function _renderGrepOutput(results: GrepResults, render: GrepRender): string;
```

`GrepRender` is defined in Agency, in `stdlib/safeBash/actions.agency` beside `GrepPayload` (Task 5), because no `.agency` file imports a type from `agency-lang/stdlib-lib`. `grepDialect.ts` declares a type with the same four fields for its parameter, and a comment on each says the other must change with it:

```
/** What the command said about printing. The rules that turn this into
 *  grep's output all live in `_renderGrepOutput`, so no caller decides
 *  any part of the format. */
export type GrepRender = {
  /** `-n` was given. */
  lineNumbers: boolean;
  /** `-H` gives "always", `-h` gives "never", neither gives "default". */
  fileNames: "default" | "always" | "never";
  /** The path as bash hands it to grep (`GrepTarget.argument`), or ""
   *  when none was written. */
  argument: string;
  /** The path names one file, not a directory. */
  oneFile: boolean
}
```

**The translation table.** A character is accepted only when grep and a JavaScript regex give it the same meaning. Everything else returns null.

| Syntax | Accepted | Why the rest is refused |
|---|---|---|
| `fixed` (`-F`) | any printable text; the result escapes every regex character with `escapeRegex`, which already exists in `lib/stdlib/shell.ts:647` for globs (export it, do not write a second one) | a newline: grep reads `a<newline>b` as two patterns, and a JavaScript regex containing a newline matches no line |
| `basic` (no `-E`) | ASCII letters and digits; space; `_ - / : , = # @ % & ~ ' " < > ; !`; `.` (any one character in both); `*` after a letter, digit, `.`, or another accepted literal; `^` only as the first character; `$` only as the last character | in basic grep, `+ ? \| ( ) { }` are plain text, while JavaScript treats them as operators; brackets, backslashes, and non-ASCII characters have meanings that differ between greps and locales |
| `extended` (`-E`) | everything `basic` accepts, plus `+ ?` with the same rule as `*`, plus `\|`, and `( )` when balanced | the same, minus the operators extended grep shares with JavaScript |

`*`, `+`, and `?` must follow a character or `)`. JavaScript rejects `a**` and `(*a)`, and grep reads a leading `*` as plain text, so those forms return null.

**Every syntax refuses a newline and every other control character.** A double-quoted word can hold a real newline, and grep splits the pattern there.

**With `wholeWord`, only a pattern of word characters translates.** Word characters are ASCII letters, digits, and `_`. With `extended`, `|` between alternatives of word characters is also accepted. grep's `-w` checks the characters on either side of the matched text, while `\b` checks the boundary between the pattern's own edge character and its neighbour. The two agree only when the pattern starts and ends with a word character. For example, `grep -w " world"` finds nothing in `hello world`, because `o` comes before the space, but `\b(?: world)\b` matches.

Unit tests, one `it` per row, each with an example:

- `basic`: `hello` gives `hello`; `h.l*o` gives `h.l*o`; `^hello` and `world$` pass through; `a+b`, `a\|b`, `a(b)`, `[0-9]`, `\bword`, `a{2}`, `héllo`, `*a`, `a**`, and `a$b` each give null.
- `extended`: `hello|goodbye` and `colou?r` and `(ab)+` pass through; `(ab`, `a|*b`, and `[0-9]` give null.
- `fixed`: `a+b` gives `a\+b`; `(x)` gives `\(x\)`; `a.b` gives `a\.b`; `a<newline>b` gives null.
- every syntax: a tab or a newline gives null.
- `wholeWord`: `hello` and `foo_1` translate; `" world"`, `h.llo`, and `a-b` give null; with `extended`, `foo|bar` translates and `foo|b r` gives null.

**The rendering rules.** These match GNU grep.

- Names are printed with `"always"`, left out with `"never"`, and with `"default"` printed for a directory search and left out for one file.
- A line is `name:` when names are printed, then `line:` when `lineNumbers`, then the text.
- For a directory search, `name` is the match's file joined to `argument` with one `/`. When `argument` is `"."`, that gives `./a.txt`. When `argument` is `""`, the name is the bare relative path, as with `grep -rn foo` and no path. A trailing `/` on `argument` is stripped first. For one file, `name` is `argument`. Because `argument` has `~` expanded, `grep -rn foo ~/notes` prints `/Users/me/notes/a.txt`, as grep does.
- A files-only search prints names only, one per line.
- The output ends in a newline when it is non-empty.

The same file also exports `_skippedDirsNote(): string`, the line `runGrep` adds after a directory search. It is built from `SKIP_DIRS` (`lib/stdlib/shell.ts:365`, exported for this), so the note cannot drift from the list the walk actually skips.

Unit tests cover each rule with a two-match input.

- [ ] **Step 1: Write the failing tests.** Run: `pnpm vitest run lib/stdlib/grepDialect.test.ts > /tmp/242-t3-red.txt 2>&1; tail -5 /tmp/242-t3-red.txt`
- [ ] **Step 2: Implement.** The translation is one table, keyed by syntax, that says which characters are literals, which are quantifiers, and which are anchors. One loop applies it. Adding a character is then one entry in the table. Do not use a regex to validate a regex. Run the tests, then `pnpm run build` and `npx prettier --check lib/stdlib/grepDialect.ts lib/stdlib/grepDialect.test.ts lib/stdlib/shell.ts`.
- [ ] **Step 3: Commit**

```bash
git add lib/stdlib/grepDialect.ts lib/stdlib/grepDialect.test.ts lib/stdlib/shell.ts
git commit -F /tmp/msg.txt   # "grepDialect: translate a grep pattern exactly, or refuse"
```

---

### Task 4: Reading a grep command, and the bash path

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`GrepPayload`, the `Effect` variant)
- Modify: `stdlib/safeBash.agency` (the import, `GrepCall`, `readGrep`, `grepEffects`, the `effectsFor` arm, the `raiseOne` arm, the `raises` clause on `safeBash`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- In `actions.agency`:

```
export type GrepPayload = {
  pattern: string;
  dir: string;
  file: string | null;
  flags: string;
  maxResults: number;
  ignoreCase: boolean;
  wholeWord: boolean;
  filesOnly: boolean;
  invert: boolean
}

export def grepEffect(payload: GrepPayload): Effect
```

  Also add `| { name: "std::grep"; payload: GrepPayload }` to `Effect`.

- In `safeBash.agency`:

```
/** A grep command checked against the table, with its one path resolved. */
type GrepCall = {
  split: SplitArgs;
  /** The pattern as the command wrote it. */
  pattern: string;
  /** The resolved path. Its `argument` is "" when -r searched "." because
   *  no path was written, since grep then prints bare names. */
  target: GrepTarget
}

@capabilities(fileRead)
def readGrep(command: SimpleCommand, cwd: string, spec: FlagSpec): Result<GrepCall>

/** The one place a grep command's flags become std::grep's fields. Both
 *  paths call it; they differ only in the pattern and the cap they pass. */
def grepPayload(call: GrepCall, pattern: string, maxResults: number): GrepPayload
```

`grepPayload` fills `dir` and `file` from the target, `flags: ""`, and `ignoreCase`, `wholeWord`, `filesOnly`, and `invert` from the letters `i`, `w`, `l`, and `v`.

`readGrep` does the following, in order:

1. `splitFlags("grep", command, spec)`. A failure is returned as it is. The bash path passes `GREP_FLAGS`, and the shell-free path passes `SHELL_FREE_GREP_FLAGS` (Task 5). So one walker checks both, and each path's flags are a list of data.
2. **The pattern.** When an `e` value is present, it is the pattern and every positional is a path. Otherwise the first positional is the pattern, and it must pass `literalWordText`, else fail with `"the grep pattern is not literal"`. The positionals after it are paths. With no `e` value and no positional, fail with `"grep with no pattern"`.
3. **Context values.** Each `A`, `B`, or `C` value must be digits only, else fail with ``the value of `-A` is not a number``.
4. **Paths.** There may be zero paths or one. With two or more, fail with `"grep with more than one path"`. With zero paths and `r`, resolve `"."` and then set the target's `argument` to `""`. With zero paths and no `r`, fail with `"grep with no path reads stdin"`. A path that fails `literalWordText` fails with `"the grep path is not literal"`.
5. **Resolve.** `try _searchTargetIn(text, cwd, tildeModeFor(word))`. A failure is returned as `failure("${why}")`.

`grepEffects(command: SimpleCommand, cwd: string): Result<Effect[]>` is the bash path. It calls `readGrep(command, cwd, GREP_FLAGS)`. When `target.file` is null, it fails with `"grep through bash would search a directory, and reads files the grep tool skips"`. Otherwise it returns `[grepEffect(grepPayload(call, call.pattern, 0))]`. The pattern is as written. A `maxResults` of 0 means no cap, which is true of grep without `-m`.

In `effectsFor`, the match gains a `"grep"` arm. It returns `[...grep.value, ...redirect.value]`, the way the git arm does. `rg` gets no arm.

In `raiseOne`, a `"std::grep"` arm raises `std::grep("Are you sure you want to search files with grep?", { ...the nine payload fields..., command: fullCommand })`, the grep tool's message. `safeBash`'s `raises` clause gains `std::grep`.

- [ ] **Step 1: Write the failing plan tests**

```
static const FIXTURES = __dirname + "/stdlib/grep-fixtures"

def grepNames(source: string): any {
  const plan = planFor(source, FIXTURES)
  const names = [effect.name for effect in plan.effects]
  return [names, plan.broadReason]
}

def grepPayloadOf(source: string): any {
  const plan = planFor(source, FIXTURES)
  for (effect in plan.effects) {
    if (effect.name == "std::grep") {
      return effect.payload
    }
  }
  return "NO GREP EFFECT"
}

node grepThroughBash() {
  // Not lone (a pipe or a redirect), or a flag the tool lacks: the
  // command runs through bash, narrow only for one file.
  return [
    grepNames("grep -c hello one.txt"),
    grepNames("grep -A 1 hello one.txt"),
    grepNames("grep -n \"a+b\" one.txt"),
    grepNames("grep -n hello one.txt > out.txt"),
    grepNames("git status && grep -n hello one.txt"),
  ]
}

node grepUnrecognized() {
  return [
    grepNames("grep hello"),
    grepNames("git status | grep hello"),
    grepNames("grep -z hello ."),
    grepNames("grep -R hello ."),
    grepNames("grep \"-R\" hello"),
    grepNames("grep -e a -e b ."),
    grepNames("grep --filter=x hello ."),
    grepNames("grep -rn $PAT ."),
    grepNames("grep -rn hello *.txt"),
    grepNames("grep -rn hello one.txt two.txt"),
    grepNames("grep -rn hello --include='*.txt' ."),
    grepNames("grep -c hello ."),
    grepNames("git status && grep -rn hello ."),
    grepNames("rg hello ."),
    grepNames("git status && grep -n hello one.txt -s"),
    grepNames("grep -e \"-x\" one.txt"),
    grepNames("grep --include=*.txt -rn hello ."),
  ]
}

node grepMissingPath() {
  // The detail names an absolute path, which differs per machine, so
  // only the kind is pinned.
  const reason = planFor("grep -rn hello missing-dir", FIXTURES).broadReason
  if (reason == null) {
    return null
  }
  return reason.kind
}

node grepBashPayload() {
  const payload = grepPayloadOf("grep -cin hello one.txt")
  return [payload.pattern, payload.file, payload.ignoreCase, payload.maxResults, payload.flags]
}
```

`expectedOutput`:

- `grepThroughBash`: `[["std::grep"],null]`, `[["std::grep"],null]`, `[["std::grep"],null]`, `[["std::grep","std::write"],null]`, `[["std::git::status","std::grep"],null]`
- `grepUnrecognized`: each row is `[["std::bash"],{"kind":"unrecognized","detail":D}]`, with `D` in order:
  1. `grep with no path reads stdin`
  2. `grep with no path reads stdin`
  3. ``grep does not take `-z` ``
  4. ``grep does not take `-R` ``
  5. ``a quoted `-R` is still an option to grep``
  6. ``grep takes `-e` only once``
  7. ``grep does not take `--filter` ``
  8. `the grep pattern is not literal`
  9. `the grep path is not literal`
  10. `grep with more than one path`
  11. `grep with more than one path` (the interpolated `--include='*.txt'` word is a positional, so `.` is a second path)
  12. `grep through bash would search a directory, and reads files the grep tool skips`
  13. the same message as row 12
  14. ``no rule for `rg` ``
  15. ``an option after the first argument is a file name to some greps`` (a lone `grep -n hello one.txt -s` runs shell-free instead; Task 5 pins that)
  16. ``a quoted `-x` is still an option to grep``
  17. ``grep does not take `--include` ``
- `grepMissingPath`: `"unrecognized"`
- `grepBashPayload`: `["hello","one.txt",true,0,""]`

No existing row plans a `grep`. `cat a.txt | grep x` in `planSummary` stays broad, because `cat` has no rule.

- [ ] **Step 2: Run to see them fail**, saving the output to `/tmp/242-t4-red.txt`.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: `make`; run to see all pass**, saving the output to `/tmp/242-t4.txt`.
- [ ] **Step 5: Commit** `stdlib/safeBash/actions.agency`, `stdlib/safeBash.agency`, and the two test files, with the message "safeBash: a grep through bash asks std::grep for one file".

---

### Task 5: A lone grep runs through the grep tool's search

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`GrepExec`, `grepExecution`, `runGrep`, `Execution`)
- Modify: `stdlib/safeBash.agency` (`tryShellFreeGrep`, the hook in `planFor`, `outcomeOf`, the dispatch in `safeBash`, the import of the Task 3 helpers)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- In `actions.agency`:

```
export type GrepRender = { ... }   // the four fields given in Task 3

export type GrepExec = {
  kind: "grep";
  payload: GrepPayload;
  render: GrepRender
}

export def grepExecution(payload: GrepPayload, render: GrepRender): GrepExec

@capabilities(fileRead)
export def runGrep(exec: GrepExec, command: string): Result<string>
```

  `Execution` gains `| GrepExec`. `GrepRender` is an Agency type, defined here beside `GrepPayload`, with the fields given in Task 3.

  `runGrep` calls `_grep(payload.dir, ".", query, payload.maxResults, [], true, payload.file)`, where `query` is built from the payload's six query fields. It does not call the `grep` tool, for the reason the comment on `runBash` gives. It renders with `_renderGrepOutput`. When the target is a directory, it adds the line `_skippedDirsNote()` returns (Task 3) to the output. When the number of results reached `payload.maxResults`, it adds `"(safeBash stopped after ${payload.maxResults} matches. Narrow the pattern or the path.)"`. With no results, it returns the same failure `runBash` returns for an exit code of 1. Move the JSON failure in `runBash` into a helper, `exitFailure(command, exitCode, stdout, stderr)`, that both executors call. For a directory search with no results, the skipped-folders note goes in `stderr`, so the model knows the miss might be in a skipped file. Return the output through `keepOutput(text, 0)`, as the echo path does.

- In `safeBash.agency`:

```
/** The flags the grep tool's search can carry out exactly. A lone grep
 *  that uses only these runs shell-free. -c, -o, -A, -B, and -C have no
 *  equivalent in the tool, so a grep using them runs through bash. No
 *  real grep runs here, so a flag may follow the pattern, as GNU allows. */
static const SHELL_FREE_GREP_FLAGS: FlagSpec = {
  plain: ["n", "r", "i", "w", "l", "v", "E", "F", "h", "H", "s", "--color=never"],
  valued: ["e"],
  optionsFirst: false
}

/** The most matches a shell-free grep returns; the output says so when it stops. */
static const SHELL_FREE_GREP_CAP = 1000

@capabilities(fileRead)
def tryShellFreeGrep(command: SimpleCommand, cwd: string): Result<Plan>
```

  `tryShellFreeGrep` fails, and the general path then decides, unless all of the following hold:
  1. The command word is the literal `grep`, with no assignments and no redirects.
  2. `readGrep(command, cwd, SHELL_FREE_GREP_FLAGS)` succeeds. A flag outside that table is a failure here, so it never reaches the payload.
  3. A directory target has `r`. Without `-r`, grep does not search a directory, and the tool would.
  4. `_grepPatternToRegex(pattern, syntax, wholeWord)` is not null, where `syntax` is `"fixed"` with `F`, `"extended"` with `E`, else `"basic"`, and `wholeWord` is whether `w` is present. Both `E` and `F` together fail, because GNU grep refuses that combination.

  When they hold, the payload is `grepPayload(call, regex, SHELL_FREE_GREP_CAP)`. The render is `{ lineNumbers: n present, fileNames: "always" with H, "never" with h, else "default", argument: call.target.argument, oneFile: call.target.file != null }`. It returns `{ effects: [grepEffect(payload)], execution: grepExecution(payload, render), broadReason: null, verbs: ["grep"] }`.

- `planFor`: in the single-simple-command block, after `trySeeIfShellFree`, try `tryShellFreeGrep(only, cwd)` and return its plan on success.
- `outcomeOf`: `"grep" => "shellFree"`.
- `safeBash`'s dispatch: `{ kind: "grep" } => runGrep(exec, command)`.

- [ ] **Step 1: Write the failing tests**

```
def executionKind(source: string): string {
  return planFor(source, FIXTURES).execution.kind
}

node loneGrepIsShellFree() {
  return [
    executionKind("grep -rn hello ."),
    executionKind("grep -rn hello"),
    executionKind("grep -n hello one.txt"),
    executionKind("grep -rniwl hello ."),
    executionKind("grep -rnF \"a+b\" ."),
    executionKind("grep -rnE \"hello|goodbye\" ."),
    executionKind("grep -c hello one.txt"),
    executionKind("grep -n \"a+b\" one.txt"),
    executionKind("grep hello ."),
    executionKind("grep -rn hello . | head"),
    outcomeOf(planFor("grep -rn hello .", FIXTURES)),
    executionKind("grep -rnw \" world\" ."),
    executionKind("grep -n hello one.txt -s"),
  ]
}

node shellFreePayloads() {
  const fixed = grepPayloadOf("grep -rnF \"a+b\" .")
  const dirSearch = grepPayloadOf("grep -rn hello .")
  const fileSearch = grepPayloadOf("grep -n hello one.txt")
  return [
    fixed.pattern,
    [dirSearch.file, dirSearch.maxResults],
    [fileSearch.file, fileSearch.dir == dirSearch.dir],
  ]
}
```

`expectedOutput`:

- `loneGrepIsShellFree`: `["grep","grep","grep","grep","grep","grep","bash","bash","bash","bash","shellFree","bash","grep"]`. For row 9, `grep hello .` without `-r` is a directory through bash, so it is broad. Its execution kind is still `"bash"`. Row 12 is `-w` with a pattern that starts with a space, which does not translate. Row 13 has a flag after the file name. That is fine on the shell-free path, where no real grep runs, and refused on the bash path (Task 4, row 15).
- `shellFreePayloads`: `["a\\+b",[null,1000],["one.txt",true]]`

**The parity test.** This test runs real grep beside the shell-free path and checks that both print the same lines. The fixtures directory holds no skipped or ignored files, so any difference is a translation or rendering bug.

```
import { bash } from "std::shell"

/** The output's lines in a fixed order, without safeBash's own note lines.
 *  grep and the tool's walk visit files in different orders. */
def sortedLines(text: string): string[] {
  const lines = text.split("\n")
  const matches = [line for line in lines if line != "" && !line.startsWith("(safeBash")]
  return matches.sort()
}

def parityOf(source: string): any {
  // Without this check, a row whose command fell back to the bash path
  // would compare real grep with itself and pass for no reason.
  if (planFor(source, FIXTURES).execution.kind != "grep") {
    return "NOT SHELL-FREE"
  }
  let ours = ""
  let theirs = ""
  handle {
    const shellFree = safeBash(source, cwd: FIXTURES)
    if (shellFree is success(out)) {
      ours = out
    }
    // bash returns an ExecResult, not a Result.
    const real = bash(source, cwd: FIXTURES)
    theirs = real.stdout
  } with approve
  return sortedLines(ours) == sortedLines(theirs)
}

node shellFreeMatchesRealGrep() {
  return [
    parityOf("grep -n hello one.txt"),
    parityOf("grep hello one.txt"),
    parityOf("grep -rn hello ."),
    parityOf("grep -rn hello"),
    parityOf("grep -rh hello ."),
    parityOf("grep -rl hello ."),
    parityOf("grep -rni hello ."),
    parityOf("grep -rnw hello ."),
    parityOf("grep -rnv hello ."),
    parityOf("grep -rnF \"o w\" ."),
    parityOf("grep -rnE \"hello|goodbye\" ."),
    parityOf("grep -rn \"^hello\" ."),
    parityOf("grep -rn \"world$\" ."),
    parityOf("grep -rn \"h.l*o\" ."),
    parityOf("grep -Hn hello one.txt"),
    parityOf("grep -n hello one.txt -s"),
  ]
}
```

`expectedOutput`: sixteen `true`s. CI runs GNU grep, and the rendering rules follow GNU. If a row fails only on macOS, where `grep` is ugrep, record the difference in the dev doc and do not bend the rendering to ugrep. `bash(command, cwd)` returns an `ExecResult` with `stdout`, `stderr`, and `exitCode` (`stdlib/shell.agency:150-158`). If a row is false, print both outputs, find out which side is wrong, and fix the translation or the rendering. Do not change the test. Arrays may not compare with `==` in Agency; if not, compare `JSON.stringify` of each.

- [ ] **Step 2: Run to see them fail**, saving the output to `/tmp/242-t5-red.txt`.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: `make`; run to see all pass**, saving the output to `/tmp/242-t5.txt`.
- [ ] **Step 5: Commit** with the message "safeBash: a lone grep runs through the grep tool's search".

---

### Task 6: End to end, and the policy

**Files:**
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `checkPolicy` and `recommendedAutoApprovePolicy` from `std::policy`, using the `{ effect, data }` interrupt shape `lib/agents/agency-agent/tests/readPolicy.agency` passes.

- [ ] **Step 1: Write the tests**

```
node loneGrepAsksOneQuestion() {
  // One std::grep approval, and no shell: a std::bash prompt would fail
  // the run, because the test file answers only the grep message.
  const result = safeBash("grep -rn hello .", cwd: FIXTURES)
  if (result is failure(why)) {
    return "FAILED: ${why}"
  }
  return [result.value.includes("./one.txt:1:hello world"), result.value.includes("skips node_modules")]
}

node bashGrepOfOneFile() {
  // -c has no tool equivalent, so real grep runs after one std::grep approval.
  const result = safeBash("grep -c hello one.txt", cwd: FIXTURES)
  if (result is failure(why)) {
    return "FAILED: ${why}"
  }
  return result.value
}

node shellFreeNoMatchFails() {
  const result = safeBash("grep -rn nothing-matches-this .", cwd: FIXTURES)
  if (result is failure(why)) {
    return [why.includes("\"exitCode\":1"), why.includes("skips node_modules")]
  }
  return "UNEXPECTEDLY MATCHED"
}

node grepUnderRecommendedNeedsNoPrompt() {
  // The launch directory is the package directory, so the fixtures are
  // inside it and recommended approves std::grep there. This test has no
  // interruptHandlers entry, so an unanswered interrupt fails the run.
  let found = false
  handle {
    const result = safeBash("grep -rn hello " + FIXTURES)
    if (result is success(text)) {
      found = text.includes("hello again")
    }
  } with (intr) {
    if (checkPolicy(recommendedAutoApprovePolicy, intr).type == "approve") {
      return approve()
    }
    return reject()
  }
  return found
}

node grepOutsideTheLaunchDirIsUndecided() {
  const plan = planFor("grep -rn root /etc", FIXTURES)
  const effect = plan.effects[0]
  const intr = { effect: effect.name, data: effect.payload }
  return checkPolicy(recommendedAutoApprovePolicy, intr).type
}
```

In `.test.json`:

- `loneGrepAsksOneQuestion`, `bashGrepOfOneFile`, and `shellFreeNoMatchFails` each get `interruptHandlers: [{ "action": "approve", "expectedMessage": "Are you sure you want to search files with grep?" }]`. Their outputs are `[true,true]`, `"2\n"`, and `[true,true]`.
- `grepUnderRecommendedNeedsNoPrompt` gets no handlers and outputs `true`.
- `grepOutsideTheLaunchDirIsUndecided` outputs `"\"propagate\""`. On macOS `/etc` resolves to `/private/etc`. Both are outside the launch directory, so the answer is the same on CI.

- [ ] **Step 2: Run, fix anything the real run turns up, commit** with the message "safeBash: grep end to end and under recommended".

---

### Task 7: The rejection hint, the docs, the checks

**Files:**
- Modify: `stdlib/safeBash.agency` (`broadExplanation`, `READ_TOOL_FOR_VERB`)
- Modify: `docs/dev/stdlib/safe-bash.md`, `docs/dev/agents/approval-policies.md`, the spec
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

- [ ] **Step 1: The hint the spec deferred from ADI-238**

Add a table from a bash verb to the tool that does the same job:

```
/** The tool to suggest when a broad command using only these verbs is
 *  rejected. ADI-244 adds cat, head, and tail, pointing at read. */
static const READ_TOOL_FOR_VERB: Record<string, string> = {
  grep: "grep"
}
```

When a broad plan is rejected and every entry of `plan.verbs` has an entry in the table, `broadExplanation`'s sentence gains ` Call the ${tools} tool instead: a policy can approve its question in advance.`, where `tools` is the distinct tool names joined with " or ". Adding a verb in a later slice is one line in the table. Test: `rejectedGrepNamesTheTool` runs `safeBash("grep -z hello .")` with a reject handler for `std::bash`, and expects the failure to end with that sentence. `rejectedBroadSaysWhy` (an `xargs` line) must not gain the hint. Write the test first, watch it fail, then implement.

- [ ] **Step 2: Docs**

`docs/dev/stdlib/safe-bash.md` gets a section, "grep". It covers:

- the two greps and why a lone one runs through the tool's search
- the table at the top of this plan
- the flag table and the list of flags left out, with the reason for each
- which greps the table was checked against
- the quoted-dash rule
- the translation table and the parity test
- the rendering rules
- the two notes added to the output, and why the skipped-folders note is built from `SKIP_DIRS`
- why a directory search through bash asks `std::bash`
- why `rg` stays broad
- the hint and its table
- that the payload's `pattern` is a JavaScript regex on the shell-free path and grep syntax as written on the bash path, so `a+b` means different things in the two; and that `maxResults: 0` on the bash path means no cap, while in the grep tool 0 means no results. `recommended` matches only on `dir`, but anyone writing a pattern or cap rule into a policy needs both facts.
- the assumption behind resolving the path when the plan is made: nothing that may run before the grep in a narrow line can change which file the path names. Today the narrow commands are git reads and redirects, and a redirect writes into a file but cannot turn it into a symlink. ADI-243 makes project scripts narrow, and then `pnpm build && grep -n x out.txt` could replace `out.txt` between the plan and the run. The ADI-243 plan must handle this.
- the output differences the parity test cannot see, because the fixtures are short ASCII text: a binary file (GNU prints `Binary file ./x matches`, the tool prints the decoded bytes); a character outside the Basic Multilingual Plane, such as an emoji, which a JavaScript `.` without the `u` flag matches only half of; and `-i` on non-ASCII text, where the case-folding rules differ. These change the output, not what is read.
- the flags-before-operands rule for the bash path, and why the shell-free path does not need it

`docs/dev/stdlib/grep-flags.md` gets one paragraph. safeBash translates a lone bash grep into this tool's search, and `lib/stdlib/grepDialect.ts` holds that translation.

`docs/dev/agents/approval-policies.md`, in "What `recommended` lets the agent read", gets one paragraph. A `std::grep` rule now also covers a bash `grep` that safeBash recognized. A lone grep runs the tool's own search. A grep in a longer line runs real grep on one named file. The same goes for `--approve std::grep`, the `FileRead` and `FileSystem` effect sets (`lib/runtime/effectSets.data.ts:14`), and an "approve always here" answer.

The spec gets the "Departures" list from this plan, on the `grep`/`rg` row.

The grep tool's docstring names four skipped folders, but `SKIP_DIRS` has six. Add `.next` and `.cache` to the docstring in `stdlib/shell.agency`. A docstring is fixed text and cannot be built from the list. Add a unit test in `lib/stdlib/grepDialect.test.ts` that reads the docstring from `stdlib/shell.agency` and checks that every name in `SKIP_DIRS` appears in it, so the next folder added to the list fails a test until the docstring names it.

- [ ] **Step 3: Checks, anti-pattern pass, PR**

Run:

```
pnpm run typecheck > /tmp/tc.txt 2>&1; tail -2 /tmp/tc.txt
pnpm run lint:structure > /tmp/lint.txt 2>&1; tail -2 /tmp/lint.txt
pnpm vitest run lib/stdlibCapabilities.test.ts lib/stdlib/safeBash.test.ts lib/stdlib/shell.test.ts lib/stdlib/grepDialect.test.ts > /tmp/242-unit.txt 2>&1; tail -4 /tmp/242-unit.txt
npx prettier --check lib/stdlib/shell.ts lib/stdlib/shell.test.ts lib/stdlib/grepDialect.ts lib/stdlib/grepDialect.test.ts
```

Then run `/anti-pattern-check` on the diff. Commit the docs together with the generated `docs/site/stdlib/` pages that `make` rewrote. Push and open the PR against `main`, titled `safeBash: grep asks std::grep (ADI-242)`, with the body in a file. The owner merges.
