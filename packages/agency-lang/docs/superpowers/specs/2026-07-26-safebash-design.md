# safeBash: run a bash command through an equivalent tool

## Status (2026-07-26)

v1 implemented — `simplify`, `stringifyWordPart`, and one rule (`echo`),
**not wired into any agent**. Later parts below are designed but unbuilt.

Grew out of [the idea doc](../ideas/2026-07-24-safebash-command-to-tool-matching.md),
which has the original reasoning and the decisions as they were made.

## The problem

The coding agent (`stdlib/agents/coding.agency`) is given file, git, search and
http tools, and its prompt tells it to prefer them over bash in as many words:

> **Avoid using them if at all possible**. These tools should be a last
> resort. […] every time you use bash or exec, it will require human approval

It reaches for bash anyway. The prompt is not load-bearing enough.

The cost is autonomy, not safety. Read-only tools are pre-approved and run
without a prompt. `bash` cannot be: `bash()` (`stdlib/shell.agency:133`) raises
`interrupt std::bash(...)` on every call, because there is no way to say in
advance what an arbitrary command string will do. So a run that could be
unattended becomes one that has to be watched, and the human approves a stream
of `ls`, `cat` and `git status` by hand.

## The shape of the fix

Parse the command the agent wrote. If it maps onto a tool the agent already
has, call that tool instead. The tool's own interrupt policy then applies —
which for the read-only ones means no approval at all.

The bash parser lives in tarsec, re-exported through `lib/stdlib/safeBash.ts`.
It is deliberately incomplete; anything it cannot parse falls through to real
bash, so incompleteness costs an approval rather than correctness.

## Decisions

- **v1 scope: one simple command, plus `>` and `>>`.** No pipes, no `&&`/`||`,
  no background, no `;`. Anything else falls through.
- **A `safeBash` tool, not a handler on `std::bash`.** A tool keeps `bash()`
  honest — it always runs bash — and makes the behavior opt-in per agent and
  easy to test.
- **Words that need shell evaluation: expand `$VAR` from the environment,
  refuse the rest.** Command substitution, arithmetic expansion and globs are
  unmapped.
- **`echo` maps to `print`** (`stdlib/index.agency:53`), which raises no
  interrupt, so it costs nothing. `echo … > f` maps to `write`.
- **Return `ExecResult`-shaped output** whichever path runs. The agent should
  not be able to tell which, except by the absence of a prompt.

## The lowered shape

```ts
type OutputRedirect = { op: string, path: string }
type Cmd = { words: string[], redirect: OutputRedirect | null }
```

The parser's AST is deeply nested — `list` → `listItem` → `andOr` → `pipeline`
→ `simpleCommand` → `word` → parts — and matching on it directly is
unreadable. `simplify` collapses that to the two fields above;
`stringifyWordPart` collapses a word's parts to one string.

Named `OutputRedirect` rather than `Redirect` because the AST already has a
`Redirect` node and the two are different things.

## Refusals are by name

Every shape v1 cannot collapse to a word list is refused with its own message:

| input | refusal |
|---|---|
| `cat a.txt \| grep x` | pipelines are not handled |
| `a && b` | `` `&&` and `\|\|` are not handled `` |
| `sleep 1 &` | background commands are not handled |
| `FOO=1 echo hi` | leading variable assignments are not handled |
| `echo $(date)` | `commandSubstitution` needs a shell to evaluate |
| `echo hi 2>&1` | redirect with an explicit file descriptor |
| `echo a; echo b` | expected a single command |

A fallthrough should be explainable, not mysterious. Refusing costs an
approval — which is what happened before safeBash existed. Guessing would cost
correctness.

## Word splitting

The subtle rule, and the one that makes this feature safe or not.

```bash
F="a b"
cat $F      # TWO arguments to bash
cat "$F"    # one
```

An unquoted expansion whose value contains whitespace is **refused**, not
expanded. Expanding it without splitting would make safeBash and bash disagree
about what a command means, which is the one failure mode this feature must
not have. Inside double quotes no splitting applies, so it expands normally.

Unset is the empty string, as in bash.

## Not wired in

`shellTools()` (`stdlib/agents/lib/toolkits.agency:91`) is untouched. No
agent's tool list changes, so nothing regresses, and v1 asks only "does the
machinery work".

Whether to trust it in the approval path is a different question and deserves
its own review with the risk in isolation. It is a one-line change to
`shellTools()` when we want it.

## Next: the command table

`echo` is the whole table today. The intended shape, to be confirmed per
command against the actual tool signature:

| command | tool | notes |
|---|---|---|
| `echo …` | `print` | no interrupt at all |
| `echo … > f` / `>> f` | `write` | overwrite / append |
| `cat f` | `read` | single file only |
| `ls [dir]` | `ls` | |
| `grep pat files` | `grep` | flag translation needed |
| `find . -name g` | `glob` | narrow subset |
| `git status\|log\|diff\|show\|…` | `gitStatus` etc. | `std::git` has one tool per subcommand |
| `curl url` | `fetch` | |

**Flags are the hard part, not the verb.** `ls -la`, `grep -ri` and
`git log --oneline -n 5` each need a decision about which flags are
representable and what to do with the rest. Default to refusing on any
unrecognized flag: a refusal costs an approval, a wrong translation costs
correctness.

## Open questions

- **Shape lock-in.** `Cmd` and `simplify` are this module's public API. If the
  shape turns out wrong once real rules exist, changing it is a breaking
  change to a shipped stdlib module. Sanity-checked against the table above on
  paper and it holds; the first real rule is the test of that.
- **Does a rewritten command get reported to the user?** Silently running
  something other than what was asked for is the kind of thing that should be
  observable. Leaning yes, via `whatIAmDoing`.
- **Does `safeBash` keep the name `bash` when handed to the LLM?** Renaming
  changes what the model writes.
- **Should the coding agent's prompt change once this exists?** Probably not —
  safeBash is a safety net, not a license to write bash.

## Parser gaps (separate from this module)

Two of the review findings are arguably the bash parser's, not safeBash's. The
AST records what was *written* but not the shell's intent to *transform* it,
so a consumer has to re-derive that by scanning literal text:

- **No node for glob patterns.** `echo *` arrives as `literal "*"`,
  indistinguishable from ordinary text except by scanning for `*`, `?` and
  `[`. safeBash now does that scan, which works — the parser does keep quoted
  and unquoted parts separate within a word, so `"a"*` is
  `[doubleQuoted "a", literal "*"]` and only the unquoted part is checked —
  but every consumer that wants "would bash expand this?" has to reimplement
  it. A `{ tag: "glob", pattern }` part would make it structural.
- **No node for tilde expansion.** `~/d` arrives as `literal "~/d"`. Same
  argument, plus tilde has a position rule (only at the start of a word) that
  a consumer has to know.

Neither blocks v1 — the scan is correct today. They are noted because the
workaround is a text scan for shell metacharacters, which is exactly the kind
of thing that goes subtly wrong as coverage grows.

## Two more found while building

Both pre-existing, both first hit by this file because nothing in stdlib had
these shapes before.

- **A blank line between match arms fails to parse when lowering is off.**
  Same file: `agency tc` accepts it, `agency fmt` rejects it with "expected
  match cases of the form `value => expression`". The formatter parses
  un-lowered, so a blank line between arms breaks the corpus round-trip gate.
  Worked around by removing the blank lines; the parser should take them.
- **A call inside a match-arm guard is invisible to the effects walk**
  (#668, already recorded as a known walker gap). A call reachable only from a
  guard contributes no effects, which matters because effects are how the
  language reasons about what a function may do. Avoided here by refusing
  flags before the match rather than in a guard on every arm — which reads
  better anyway — rather than by widening the walker inside this PR.

## Found while building

`item.command`, where the field is declared `AndOr`, resolves to the type
*alias* named `Command` — so every access below it reports a missing property.
Worked around with `any` on three locals, each commented. Reachable only when
a field name matches a type name; worth its own issue.

## Related

- `docs/site/guide/interrupts.md`, `handlers.md`, `effects.md`, `policies.md` —
  the approval machinery this works around.
- `stdlib/shell.agency:133` — `bash()` and its interrupt.
- PRs #674, #676, #677, #695, #698, #700, #701 — the pattern-matching work that
  made the match table expressible.
