# Review: tarsec glob words and a leading tilde (ADI-240)

Plan reviewed: `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-reads/packages/agency-lang/docs/superpowers/plans/2026-10-30-tarsec-bash-globs-and-tilde.md`

Checked against `/Users/adityabhargava/tarsec` (`main` at ef1ba83).

## Verdict

The parser side is sound. I traced every row in the plan's test lists
through `wordParser`'s alternatives and they come out as the plan says.
The gap is on the rendering side: `astToBash.ts` has two character tables
that mirror the parser's, and Task 3 does not list that file, so a tilde
path would round-trip to a quoted string and change its meaning. There is
also a safety hole in how a glob is rendered. Both are a few lines. One
more small thing: `]` should not by itself make a word a glob.

## Blocking: Task 3 must update `astToBash.ts` too

`astToBash.ts` keeps its own copy of the parser's character sets:

```ts
const BARE_WORD_CHARS = new Set(LETTERS + DIGITS + "_-.=:+/");
const BARE_WORD_START_CHARS = new Set(LETTERS + DIGITS + "_.=:+/");
```

`isBareWord` uses them to decide whether a literal or path can be emitted
unquoted. After Task 3 the parser accepts `~/x` as a path, but
`isBareWord("~/x")` is false because `~` is not in
`BARE_WORD_START_CHARS`, so `quoteIfNeeded` emits `'~/x'`. That is a
different command: bash expands an unquoted `~` and does not expand a
quoted one, so `cat ~/x` becomes `cat './~/x'` in effect. The round-trip
test in the plan would catch it (the re-parse gives a `singleQuoted`
node, not a `path`), but the plan's file list for Task 3 names only
`parsers.ts` and `index.ts`, so the builder would be surprised.

This matters more than a test failure, because safeBash runs the rendered
text when every command was recognized. Rendering must never change what
bash does.

Add `~` to `BARE_WORD_START_CHARS` in `astToBash.ts` in Task 3, and add
`astToBash.ts` to the Files list. The comment on those two constants
already says they mirror `parsers.ts`; this is the drift it warns about.
A cheap guard against the next drift: export the two character strings
from `parsers.ts` and build both the `oneOf` parsers and the `Set`s from
them, so there is one table. That is optional for this slice but is the
"one place to edit" the anti-pattern catalog asks for.

## Blocking: a glob is rendered with no safety check

Task 1 Step 4 renders a glob as `word.text`, unquoted and unchecked. Every
other word in `wordToBash` goes through `quoteIfNeeded` or throws
`AstToBashError`. The module header's one guarantee is that the output is
always safe to hand to bash, whatever a consumer put in the node. A
hand-built `{ tag: "glob", text: "*; rm -rf /" }` would be emitted raw.

A glob cannot be rescued by quoting (quoting stops it being a glob), so
this is the `AstToBashError` case, like a bad variable name:

```ts
case "glob":
  if (!isGlobText(word.text)) {
    throw new AstToBashError(`Not a valid glob: ${JSON.stringify(word.text)}`);
  }
  return word.text;
```

where `isGlobText` checks every character is in the bare-word set, `/`,
or a glob character, and at least one glob character is present. The
parser can never produce anything else, so for parser output this is a
no-op, which is the same relationship `isVariableName` has to
`varNameParser`.

## Should fix: `]` alone is not a glob character

Task 1 sets `GLOB_CHARS = "*?[]"` and `hasGlobChar` tests against it. In
bash a lone `]` is ordinary text: `echo a]b` prints `a]b`, no expansion.
With `]` as a trigger, `a]b` becomes a `GlobWord`, and under ADI-241
`literalWordText` would refuse it, so `cat a]b` would ask the broad
question for a plain filename. Rare, but wrong, and the fix is to split
the two roles:

- Characters a glob word may contain: bare word characters, `/`, `*`,
  `?`, `[`, `]`.
- Characters that make it a glob: `*`, `?`, `[`.

`[abc` with no closing bracket is still a glob by this rule, which is what
the Review Focus wants.

## Verified rows

I traced these through `wordParser`'s `or` in order (flag, interpolated,
single quoted, double quoted, variable, then path and literal, with the
new glob parser placed before path and literal):

- `*.ts`, `src/*.md`, `src/**/*.md`, `file?.txt`, `[abc`: the
  interpolated parser fails on the `*` or `[` (its literal run uses
  `bareWordChars`, which lacks them), and for `src/*.md` it gets one part
  and refuses because it needs two. The glob parser then matches. Good.
- `echo '*.ts'` and `echo "*.ts"`: quoted alternatives come before the
  glob parser and the quotes are not glob characters. Good.
- `*.sh arg` as a command: `scriptNameParser` is unchanged and fails on
  `*`, so `command` is null, then `args` would take `*.sh` and `arg`, and
  `simpleCommandParser` rejects a command with no name and no assignment.
  Rejected, as the plan says.
- `echo > *.txt`: `redirectParser` captures `wordParser` as its target
  today, so the plan is right that a `redirectTargetParser` without the
  glob alternative is needed. Building it from the same list minus one
  entry is the right way.
- `ls -*`: the flag parser fails (`*` is not a flag character), the glob
  parser must refuse a leading `-`. The plan's "first element is the start
  set" rule does that. Good.
- `--include=*.ts` today: the name-and-value parser fails on `*`, the
  name-only parser matches `--include` and then `wholeWord` fails because
  `=` is not a word-end character. So the whole word is rejected today,
  and Task 2's change to the value parser is what makes it parse. Good.
- `~`, `~/x`, `ls ~/.ssh`: with `~` in `bareWordStartChars` and a start
  set on `pathWordParser`, these come out literal, path, path. `a~b`: the
  literal parser takes `a`, the boundary check sees `~`, which is not a
  word-end character, and fails. Rejected. Good.
- `~user/x` comes out as a path, since `user` is bare-word text and `/x`
  follows. The plan says to pin whatever the sets give and name it in the
  header. Agreed; say in the header that `~user` is accepted and kept as
  written, since that is what will happen.

## Smaller points

- **Task 2 Step 3, keeping `valueIsGlob` absent.** Adding the key only
  when true is right for the existing `toEqual` assertions. Write it as an
  `if` that assigns the field, not a conditional spread; the catalog has
  an entry for that. The plan does not show the code, so this is a note
  for the builder.
- **Task 1 Step 3, the `globWordParser` body.** It is written as a hand
  function around `seqC` with a post-check, the same shape as
  `literalWordParser` and `pathWordParser`. That is the local convention,
  so it is fine, but the post-check `hasGlobChar` is cheaper as a parser:
  put a `peek`-style requirement in, or keep the post-check and say in the
  comment that it matches the two neighbors. Either way, not blocking.
- **Interaction with ADI-239.** The two plans both edit `wordParser`,
  `index.ts`, and the test files. The plan says they are independent and
  can ship in one release. They are independent in meaning, but they will
  conflict textually in `index.ts` and the unsupported-syntax list. Say
  which lands first, or that the second rebases.
- **Task 4** says "same three steps as ADI-239's Task 3". Fine, but
  the anti-pattern and prose check should name the glob render check
  above as something to look for, since it is the one place a reviewer
  would otherwise miss.

## Anti-pattern pass

Checked against `~/.claude/skills/anti-pattern-check/anti-patterns.md`
and tarsec's `anti-patterns.md`.

- **Duplicating existing code.** `astToBash.ts` already duplicates the
  parser's character tables, and this plan adds a third place (the glob
  set) without touching the second. The blocking item above is the
  symptom. Sharing the strings between the two files fixes the class of
  bug rather than this one instance.
- **Inconsistent patterns.** Rendering a glob without the check every
  other word gets. Covered above.
- **Conditional spreads.** A risk in Task 2 Step 3 depending on how the
  builder writes it. Noted above.
- Nothing else applies.

## What I did not check

I did not run the tarsec suite or the type check. The traces above are
from reading `parsers.ts` and `astToBash.ts` on `main`.
