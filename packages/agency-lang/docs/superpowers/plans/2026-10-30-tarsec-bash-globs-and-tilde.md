# tarsec: glob words and a leading `~` in the bash parser (ADI-240) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tarsec bash parser accepts an unquoted glob (`*.ts`, `src/*.md`, `--include=*.ts`) as its own `GlobWord` node, and a word starting with `~` as an ordinary literal or path word.

**Architecture:** A `GlobWord` joins the `Word` union. It is a word made of path characters plus `*`, `?`, `[`, `]`, containing at least one of the four, and it is tried before the path and literal word parsers so `*.ts` does not fail as a literal. A flag's value may be a glob, recorded with a `valueIsGlob` boolean. `~` becomes an allowed first character of a literal or path word and nothing else changes about those words.

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
- `~` alone, `~/x`, and `~user/x`: the first two parse; `~user/x` is the one bash form this plan does not promise, so pin whichever the character sets give and name it in the header. Pinned in Task 3.
- `echo ~` after Task 3 round-trips to the same text, not an expanded home. Pinned in Task 3.

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
const GLOB_CHARS = "*?[]";
const globChars: Parser<string> = label("a glob character", oneOf(GLOB_CHARS));

/** A bare or path word containing at least one glob character. Tried
 * before the literal and path words, which would fail on the `*`. */
export const globWordParser: Parser<GlobWord> = wholeWord((input: string) => {
  const result = trace("globWordParser", seqC(
    set("tag", "glob"),
    capture(many1WithJoin(or(bareWordChars, char("/"), globChars)), "text"),
  ))(input);
  if (result.success && !hasGlobChar(result.result.text)) {
    return failure("Not a glob.", input);
  }
  return result;
});
```

`hasGlobChar` is a one-line helper over `GLOB_CHARS`. The leading-`-` rule comes free if the first element is `bareWordStartChars`-or-`/`-or-glob rather than `bareWordChars`; write it that way. Add `globWordParser` to the `or` in `wordParser` ahead of `pathWordParser` and `literalWordParser`. `scriptNameParser` is unchanged, so a glob command word is rejected; `redirectParser` captures `wordParser` as its target, so add a check there or narrow the target to a non-glob word; the "glob redirect target" test decides which is simpler. Prefer narrowing: a `redirectTargetParser` that is `wordParser` minus the glob alternative, built from the same list.

- [ ] **Step 4: Render and document**

`wordToBash` gets `case "glob": return word.text;`. In `index.ts`, move globs to the supported list with the sentence "an unquoted word containing `* ? [ ]`, kept unexpanded as a `glob` word; never a command word or redirect target".

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

The value parser becomes `many1WithJoin(or(wordChars, globChars))`, and the capture is followed by a `map` on the whole `seqC` result that adds `valueIsGlob: true` when `hasGlobChar(flagValue)`. Keep the key absent otherwise so existing `toEqual` assertions on flags do not change.

- [ ] **Step 4: Run, commit**

```bash
git add lib/parsers/bash tests/parsers/bash
git commit -F /tmp/msg.txt   # "bash parser: a glob as a flag value"
```

---

### Task 3: A leading `~`

**Files:**
- Modify: `lib/parsers/bash/parsers.ts` (`bareWordStartChars`, `pathWordParser`)
- Modify: `lib/parsers/bash/index.ts` (header)
- Test: both test files

**Interfaces:**
- Produces: `~` parses as `{ tag: "literal", text: "~" }`; `~/x` as `{ tag: "path", text: "~/x" }`; `~/.ssh/config` as a path; `a~b` rejected.

- [ ] **Step 1: Failing tests**

- `cat ~/notes.txt` → arg `{ tag: "path", text: "~/notes.txt" }` (and remove the `tilde expansion` row from the unsupported list)
- `echo ~` → arg literal `~`
- `cd ~` → literal
- `ls ~/.ssh` → path
- rejected: `echo a~b`
- Corpus: `"cat ~/notes.txt"`, `"echo ~"`.

- [ ] **Step 2: Run to see them fail**

- [ ] **Step 3: Implement**

`bareWordStartChars` gains `~`. `pathWordParser` is `many1WithJoin(or(bareWordChars, char("/")))` with no distinct start set, so give it one: `seqR(or(bareWordStartChars, char("/")), manyWithJoin(or(bareWordChars, char("/"))))` joined, which admits a leading `~` and `/` and keeps `a~b` out because `~` is not in `bareWordChars`. Confirm the existing path tests (`/`, `src/`, leading slash) still pass; the "paths" describe covers them.

- [ ] **Step 4: Header, run, commit**

`index.ts`: `~` at the start of a word is accepted and kept as written; `~user` is whatever the character sets give, stated plainly.

```bash
git add lib/parsers/bash tests/parsers/bash
git commit -F /tmp/msg.txt   # "bash parser: a leading tilde"
```

---

### Task 4: Whole suite, build, type-check, PR

Same three steps as ADI-239's Task 3. Title: `bash parser: glob words and a leading tilde (ADI-240)`.
