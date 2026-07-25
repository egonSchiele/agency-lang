# safeBash: rewrite a bash command into an equivalent tool call

## Status (2026-07-24)

Idea, with the main design decisions already made (see Decisions below).
Blocked on three pattern-matching items; do them in this order:

1. [Object pattern crashes on a null intermediate](2026-07-24-object-pattern-crashes-on-null-intermediate.md)
2. [`is` in a match-arm guard is not lowered](2026-07-24-match-arm-guard-is-expression-not-lowered.md)
3. [Nested `: Type` suffix in patterns](2026-07-24-nested-type-suffix-in-patterns.md)

Work in progress lives in `stdlib/safeBash.agency` and
`lib/stdlib/safeBash.ts`; `foo.agency` is the scratch driver.

## The Problem

The coding agent (`stdlib/agents/coding.agency`) is given file, git,
search, and http tools, and its prompt tells it to prefer them over bash
in as many words:

> **Avoid using them if at all possible**. These tools should be a last
> resort. […] every time you use bash or exec, it will require human
> approval

It reaches for bash anyway. The prompt is not load-bearing enough.

The cost is autonomy, not safety. Read-only tools are pre-approved, so
they run without a prompt. `bash` cannot be: `bash()`
(`stdlib/shell.agency:133`) raises `interrupt std::bash(...)` on every
call, because there is no way to say in advance what an arbitrary command
string will do. So a run that could have been unattended becomes one that
has to be watched, and the human approves a stream of `ls`, `cat`, and
`git status` by hand.

## The Idea

Parse the command string the agent wrote. If it maps onto a tool the
agent already has, call that tool instead. The tool's own interrupt
policy then applies — which for the read-only ones means no approval at
all.

The bash parser is already in tarsec and re-exported through
`lib/stdlib/safeBash.ts`. It is deliberately incomplete; anything it
cannot parse falls through to real bash, so incompleteness costs an
approval rather than correctness.

## Decisions

- **v1 scope: one simple command, plus `>` and `>>` redirects.** No
  pipes, no `&&`/`||`, no background, no `;`. Anything else is unmatched
  and falls through to bash approval.
- **Where it lives: a `safeBash` tool that replaces `bash` in the
  agent's tool list.** Not a handler on `std::bash`, and not inside
  `bash()` itself — a tool keeps `bash()` honest (it always runs bash)
  and makes the behavior opt-in per agent and easy to test.
- **Words that need shell evaluation: expand `$VAR` from the
  environment, refuse the rest.** Command substitution, arithmetic
  expansion, and globs are unmatched. See the word-splitting caveat
  below.
- **`echo` maps to `print`** (`stdlib/index.agency:53`), which raises no
  interrupt, so it costs nothing. `echo … > f` maps to `write`.
- **Lowered shape: an object with an optional redirect field** (shape C
  below).

## The Lowered Shape

`simplify` reduces the parser's AST to:

```ts
type Redirect = { op: string, path: string }
type Cmd = { words: string[], redirect: Redirect | null }
```

so the matcher reads as one table:

```ts
match (c) {
  { words: ["echo", ...rest], redirect: null }                  => print(join(rest))
  { words: ["echo", ...rest], redirect: { op: ">",  path } }    => write(path, join(rest))
  { words: ["echo", ...rest], redirect: { op: ">>", path } }    => append(path, join(rest))
  { words: ["git", sub, ...flags], redirect: null }             => runGit(sub, flags)
  _                                                             => realBash(original)
}
```

This is why item 1 blocks: `redirect: { op: ">" }` against a `null`
redirect throws today instead of falling through.

The AST the parser produces is deeply nested (`list` → `listItem` →
`andOr` → `pipeline` → `simpleCommand` → `word` → parts), and matching on
it directly is unreadable. `simplify` exists to collapse that to the two
fields above; `stringifyWordPart` collapses a word's parts to one string.

## stringifyWordPart

Returns `Result<string>`:

- `literal`, `singleQuoted` → the text
- `doubleQuoted` → concatenate the parts, recursively
- `variable`, `paramExpansion` → the environment value; unset is the
  empty string, matching shell semantics
- `commandSubstitution`, `arithmeticExpansion` → `failure`

One failure anywhere makes the whole command unmatched. That keeps "can
safeBash handle this?" a single yes/no per command.

### The word-splitting caveat

Bash splits an *unquoted* expansion on whitespace, so with `F="a b"`,
`cat $F` is two arguments and `cat "$F"` is one. Expanding without
splitting would make safeBash and bash disagree about what a command
means — the exact class of divergence this feature must not have.

Rule: expand an unquoted `$VAR` only when its value contains no
whitespace. Otherwise refuse the command. Inside double quotes, expand
unconditionally (no splitting applies there). A refusal costs one
approval; a wrong expansion costs correctness.

Also: a `simpleCommand` carries `assignments` (`FOO=1 cmd`). Those affect
what `$FOO` means for that command only. v1 should refuse any command
with assignments rather than model shell scoping.

## Candidate Command Table (v1)

Start with `echo`; the rest is the intended shape, to be confirmed per
command against the actual tool signature.

| Command | Tool | Notes |
|---|---|---|
| `echo …` | `print` | no interrupt at all |
| `echo … > f` / `>> f` | `write` | mode overwrite / append |
| `cat f` | `read` | single file only |
| `ls [dir]` | `ls` | |
| `grep pat files` | `grep` | flag translation needed |
| `find . -name g` | `glob` | narrow subset |
| `git status\|log\|diff\|show\|…` | `gitStatus` etc. | `std::git` has one tool per subcommand |
| `curl url` | `fetch` | |

Flags are the hard part, not the verb: `ls -la`, `grep -ri`, and
`git log --oneline -n 5` all need a decision about which flags are
representable and what to do with the rest. Default to refusing on any
unrecognized flag.

## Return Contract

`safeBash` replaces `bash`, so it returns `ExecResult`
(stdout / stderr / exitCode) whatever path it takes. A matched command
synthesizes that from the tool's result. The agent should not be able to
tell which path ran, except by the absence of an approval prompt.

Open question: should a matched command be *reported* to the user
(`whatIAmDoing`-style) so the rewrite is visible? Leaning yes — silent
rewriting of a command into something else is exactly the kind of thing
that should be observable.

## Touch Points

- `stdlib/safeBash.agency` — `simplify`, `stringifyWordPart`, the match
  table, the `safeBash` tool itself.
- `lib/stdlib/safeBash.ts` — the tarsec re-export (currently just
  `bashParser as _bashParser`).
- `stdlib/agents/lib/toolkits.agency:91` `shellTools()` — where `bash` is
  handed out; safeBash either replaces it there or gets its own bundle.
- `docs/site/stdlib/safeBash.md` — generated by `agency doc`, so write
  the docstrings, not the markdown.

## Tests

Agency execution tests (`tests/agency/`), no LLM calls:

- `echo "Hello, world!"` → `print`, no interrupt raised.
- `echo hi > out.txt` / `>> out.txt` → `write` with the right mode.
- `echo $FOO` with `FOO=bar` → expands; with `FOO="a b"` unquoted →
  refuses; `echo "$FOO"` with a space → expands.
- `echo $(date)` → refuses, falls through to bash.
- `FOO=1 echo hi` → refuses (assignments).
- `a && b`, `a | b`, `a &` → all fall through.
- Unparseable input → falls through, no crash.
- The fall-through path really does raise `std::bash` (assert the
  interrupt), and the matched path really does not.

## Open Questions

- Does `safeBash` keep the name `bash` when handed to the LLM? Renaming
  it changes what the model writes; keeping the name means the tool
  description should still say "prefer the dedicated tools".
- Should the match table be extensible by the user (a list of rules
  passed in) or fixed in the stdlib? Fixed for v1.
- Does the prompt guidance in `stdlib/agents/coding.agency` change once
  this exists? It should probably stay — safeBash is a safety net, not a
  license to write bash.

## Related

- `docs/site/guide/interrupts.md`, `handlers.md`, `effects.md`,
  `policies.md` — the approval machinery this is working around.
- `docs/site/guide/pattern-matching.md`,
  `type-validation.md`,
  `value-parameterized-types.md` — the matching features used.
- `stdlib/shell.agency:133` — `bash()` and its interrupt.
