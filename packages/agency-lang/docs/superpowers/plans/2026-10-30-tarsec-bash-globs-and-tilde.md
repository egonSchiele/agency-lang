# tarsec: glob words and a leading `~` in the bash parser (ADI-240) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tarsec bash parser accepts an unquoted glob (`*.ts`, `src/*.md`, `--include=*.ts`) as its own `GlobWord` node, and a word starting with `~` as an ordinary literal or path word.

**Architecture:** A `GlobWord` joins the `Word` union. It is a word made of path characters plus `*`, `?`, `[`, `]`, and it counts as a glob only when it contains `*`, `?`, or `[` (a lone `]` is ordinary text in bash: `echo a]b` prints `a]b`). It is tried before the path and literal word parsers so `*.ts` does not fail as a literal. A flag's value may be a glob, recorded with a `valueIsGlob` boolean. `~` becomes an allowed first character of a literal or path word. `astToBash.ts` keeps its own copy of the parser's character tables for deciding what can be emitted unquoted, so every character-set change here is made in both files; this plan also moves the two shared strings into one exported place so the next change cannot drift.

**Tech Stack:** tarsec, vitest. Repository `/Users/adityabhargava/tarsec`, files under `lib/parsers/bash/` and `tests/parsers/bash/`.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-reads/packages/agency-lang/docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 4 "The tarsec change" (glob and tilde bullets). Linear: ADI-240. Independent of ADI-239; the two can ship in one release.

## Global Constraints

- Same as ADI-239: combinators only, browser-safe `lib/`, the header in `index.ts` kept true, round-trip property for every new shape, whole suite and build green, `test:tsc` error count not above `main`'s 8, owner releases.
- A quoted `'*.ts'` or `"*.ts"` is not a glob. It stays a `singleQuoted` or `doubleQuoted` word; bash passes it through as text.
- A glob is never a command word and never a redirect target: `*.sh` as a command and `> *.txt` stay rejected.
- `~` only at the start of a word: `a~b` stays rejected.
- A glob word may not start with `-`; `-*` would otherwise shadow a flag. Reject it.

## Review Focus

- `[` without `]` (`ls [abc`) is still a glob character in bash; the parser accepts it as a glob word and does not try to balance brackets. Pinned in Task 1.
- `src/**/*.md`: `**` is just two asterisks here; one glob word. Pinned in Task 1.
- `--include=*.ts` and `--include='*.ts'`: the first has `valueIsGlob: true`, the second has `valueIsGlob` absent and `flagValue` `'*.ts'` kept as written. Check how `flagWordNameAndValueParser` treats a quoted value today and keep that behavior. Pinned in Task 2.
- `~` alone, `~/x`, and `~user/x`: all three parse (`user` is bare-word text), and the header says `~user` is accepted and kept as written. Pinned in Task 3.
- `echo ~` and `cat ~/x` after Task 3 round-trip to the same unquoted text. If `astToBash.ts`'s start-character table is not updated, `~/x` is emitted as `'~/x'`, which bash does not expand, so the rendered command reads a different file. Pinned in Task 3.
- A hand-built `{ tag: "glob", text: "*; rm -rf /" }` must throw from `astToBash`, not be emitted raw. Pinned in Task 1.

---

### Task 1: `GlobWord`

**Files:**
- Modify: `lib/parsers/bash/types.ts` (`Word` union, new type)
- Modify: `lib/parsers/bash/parsers.ts` (new `globWordParser`, its place in `wordParser`)
- Modify: `lib/parsers/bash/astToBash.ts` (`wordToBash`)
- Modify: `lib/parsers/bash/index.ts` (header)
- Test: `tests/parsers/bash/parsers.test.ts`, `tests/parsers/bash/astToBash.test.ts`

**Interfaces:**
- Produces: `export type GlobWord = { tag: "glob"; text: string }`; `Word` gains it; `export const globWordParser: Parser<GlobWord>`; `astToBash` renders a glob as its text.

- [ ] **Step 1: Write the failing tests**

A `describe("globs")` in `parsers.test.ts`, each through `parseFully(wordParser, ...)` or a whole command:

- `*.ts` → `{ tag: "glob", text: "*.ts" }`
- `src/*.md` → glob
- `src/**/*.md` → glob
- `file?.txt` → glob
- `[abc` → glob
- `ls *.txt` → command `ls` with one glob arg (and remove `["glob", "ls *.txt"]` from the unsupported list)
- `grep foo src/*.ts` → args: literal `foo`, glob `src/*.ts`
- `echo '*.ts'` → arg stays `singleQuoted`
- `echo "*.ts"` → arg stays `doubleQuoted`
- rejected: `*.sh` as a command word (`parsesFully(commandParser, "*.sh arg")` is false), `echo > *.txt`, `ls -*`

Corpus additions in `astToBash.test.ts`: `"ls *.txt"`, `"grep foo src/*.ts"`, `"cat src/**/*.md"`, `"echo '*.ts'"`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/parsers/bash > /tmp/tarsec-g1.txt 2>&1; tail -8 /tmp/tarsec-g1.txt`

- [ ] **Step 3: Add the type and the parser**

In `types.ts`, `GlobWord` with a comment: an unquoted word bash will expand; its own node so a consumer can tell it from quoted text. In `parsers.ts`:

```ts
/** Characters a glob word may contain beyond a path's. */
export const GLOB_WORD_CHARS = "*?[]";
/** The ones that make a word a glob. A lone `]` is ordinary text in bash. */
export const GLOB_TRIGGER_CHARS = "*?[";
const globChars: Parser<string> = label("a glob character", oneOf(GLOB_WORD_CHARS));

/** A bare or path word containing at least one glob character. Tried
 * before the literal and path words, which would fail on the `*`. The
 * post-check mirrors the one pathWordParser does for `/`. */
export const globWordParser: Parser<GlobWord> = wholeWord((input: string) => {
  const result = trace("globWordParser", seqC(
    set("tag", "glob"),
    capture(many1WithJoin(or(bareWordChars, char("/"), globChars)), "text"),
  ))(input);
  if (result.success && !isGlobText(result.result.text)) {
    return failure("Not a glob.", input);
  }
  return result;
});
```

`export function isGlobText(text: string): boolean` lives in `parsers.ts` and is true when every character is a bare-word character, `/`, or one of `GLOB_WORD_CHARS`, and at least one is in `GLOB_TRIGGER_CHARS`; `astToBash` uses the same function in Step 4. The leading-`-` rule comes free if the first element is `bareWordStartChars`-or-`/`-or-glob rather than `bareWordChars`; write it that way. Add `a]b` → literal (not a glob) to the test rows. `wordParser` today is one `or(...)` over the word alternatives. Name that list once, `const plainWordParsers = [...]` (the alternatives as they stand), and build two parsers from it: `wordParser = or(globWordParser, ...plainWordParsers)` and `redirectTargetParser = or(...plainWordParsers)`. `redirectParser` captures `redirectTargetParser` as its target, so a glob target fails to parse with no check written anywhere. `scriptNameParser` is unchanged, so a glob command word is rejected.

- [ ] **Step 4: Render and document**

`wordToBash` gets a `glob` case that throws `AstToBashError` when `!isGlobText(word.text)` and returns `word.text` otherwise. Every other word goes through `quoteIfNeeded` or throws; a glob cannot be quoted without ceasing to be a glob, so the throw is the only safe answer for a hand-built node, and for parser output the check is a no-op, the same relationship `isVariableName` has to `varNameParser`. Add the throw test from the Review Focus to `astToBash.test.ts`. In `index.ts`, move globs to the supported list with the sentence "an unquoted word containing `* ? [`, kept unexpanded as a `glob` word; never a command word or redirect target".

- [ ] **Step 5: Run, commit**

Run: `npx vitest run tests/parsers/bash > /tmp/tarsec-g1.txt 2>&1; tail -5 /tmp/tarsec-g1.txt`

```bash
git add lib/parsers/bash tests/parsers/bash
git commit -F /tmp/msg.txt   # "bash parser: glob words"
```

---

### Task 2: A glob as a flag value

**Files:**
- Modify: `lib/parsers/bash/types.ts` (`FlagWord`)
- Modify: `lib/parsers/bash/parsers.ts` (`flagWordNameAndValueParser`)
- Modify: `lib/parsers/bash/astToBash.ts` (flag rendering, if it inspects the value)
- Test: both test files

**Interfaces:**
- Produces: `FlagWord = { tag: "flag"; flagName: string; flagValue?: string; valueIsGlob?: boolean }`. `valueIsGlob` is present and `true` only when the value contains a glob character and was unquoted.

- [ ] **Step 1: Failing tests**

- `grep -rn x --include=*.ts src` → flag `{ flagName: "--include", flagValue: "*.ts", valueIsGlob: true }`
- `--include=foo.ts` → no `valueIsGlob` key
- `--include='*.ts'` → whatever today's parser gives for a quoted value, pinned as is (if it is rejected today, it stays rejected and the test is in the unsupported list)

Corpus: `"grep -rn x --include=*.ts src"`.

- [ ] **Step 2: Run to see them fail**

- [ ] **Step 3: Implement**

The value parser becomes `many1WithJoin(or(wordChars, globChars))`, and the `seqC` result goes through a `map` that sets `flag.valueIsGlob = true` inside an `if (isGlobText(flag.flagValue))`, not a conditional spread. The key stays absent otherwise so existing `toEqual` assertions on flags do not change.

- [ ] **Step 4: Run, commit**

```bash
git add lib/parsers/bash tests/parsers/bash
git commit -F /tmp/msg.txt   # "bash parser: a glob as a flag value"
```

---

### Task 3: A leading `~`, and one character table for both files

**Files:**
- Modify: `lib/parsers/bash/parsers.ts` (`bareWordStartChars`, `pathWordParser`; export the two character strings)
- Modify: `lib/parsers/bash/astToBash.ts` (`BARE_WORD_CHARS` and `BARE_WORD_START_CHARS` built from the exported strings)
- Modify: `lib/parsers/bash/index.ts` (header)
- Test: both test files

**Interfaces:**
- Produces: `~` parses as `{ tag: "literal", text: "~" }`; `~/x` as `{ tag: "path", text: "~/x" }`; `~/.ssh/config` and `~user/x` as paths; `a~b` rejected. `parsers.ts` exports `BARE_WORD_CHAR_STRING` and `BARE_WORD_START_CHAR_STRING`, and both the `oneOf` parsers in `parsers.ts` and the two `Set`s in `astToBash.ts` are built from them, so there is one table.

- [ ] **Step 1: Failing tests**

- `cat ~/notes.txt` → arg `{ tag: "path", text: "~/notes.txt" }` (and remove the `tilde expansion` row from the unsupported list)
- `echo ~` → arg literal `~`
- `cd ~` → literal
- `ls ~/.ssh` → path
- `cat ~user/x` → path
- rejected: `echo a~b`
- Corpus: `"cat ~/notes.txt"`, `"echo ~"`, `"ls ~/.ssh"`. The round trip is the test that catches a stale table in `astToBash.ts`: with `~` missing from its start set, `~/x` is emitted as `'~/x'` and re-parses as a `singleQuoted` word.

- [ ] **Step 2: Run to see them fail**

- [ ] **Step 3: Implement**

In `parsers.ts`, export the two strings the `oneOf` parsers are built from (`BARE_WORD_CHAR_STRING = LETTERS + DIGITS + "_-.=:+"`, `BARE_WORD_START_CHAR_STRING = LETTERS + DIGITS + "_.=:+~"`), and build `bareWordChars` and `bareWordStartChars` from them. `pathWordParser` is `many1WithJoin(or(bareWordChars, char("/")))` with no distinct start set, so give it one: `seqR(or(bareWordStartChars, char("/")), manyWithJoin(or(bareWordChars, char("/"))))` joined, which admits a leading `~` and `/` and keeps `a~b` out because `~` is not in `bareWordChars`. In `astToBash.ts`, replace the two literal strings in `BARE_WORD_CHARS` and `BARE_WORD_START_CHARS` with `new Set(BARE_WORD_CHAR_STRING + "/")` and `new Set(BARE_WORD_START_CHAR_STRING + "/")` (the renderer's sets include `/` today; keep that). Confirm the existing path tests (`/`, `src/`, leading slash) still pass; the "paths" describe covers them.

- [ ] **Step 4: Header, run, commit**

`index.ts`: `~` at the start of a word is accepted and kept as written, including `~user/x`.

```bash
git add lib/parsers/bash tests/parsers/bash
git commit -F /tmp/msg.txt   # "bash parser: a leading tilde"
```

---

### Task 4: Whole suite, build, type-check, PR

Same three steps as ADI-239's Task 3. In the anti-pattern pass, look for a word rendered without going through `quoteIfNeeded` or a check (the glob case) and for any character literal that appears in both `parsers.ts` and `astToBash.ts`. Title: `bash parser: glob words and a leading tilde (ADI-240)`. This plan and ADI-239 both edit `wordParser`, `index.ts`, and the test lists; whichever lands second rebases.
