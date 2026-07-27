# safeBash: run a bash command through an equivalent tool

## Status (2026-07-26, revised)

v2 implemented and tested, **not wired into any agent**.

The module is now built around an `Action`: deciding what a command means
and actually doing it are separate steps. `echo` and three `git`
subcommands are mapped; everything else falls back to bash. 19 execution
tests cover it.

This replaces the v1 design, which reduced a command to a `Cmd` record
(`{ command, args, redirect }`) and ran it inline. The rewrite of the bash
parser in tarsec 0.5.2/0.5.3 changed the AST underneath, and rather than
re-fit the old shape to it we changed what the module produces.

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

## Actions: the seam

Every command is first translated into an **`Action`** — a plain data object
saying what should happen, with nothing having happened yet:

```ts
type Action = PrintAction | WriteFileAction | GitAction | BashAction
```

`makeAction` turns one parsed command into an `Action` and does nothing else.
`runAction` takes an `Action` and does it. All the interesting decisions —
which tool answers this command, what its arguments mean, whether a flag
changes the answer — live in `makeAction`, which has no effects at all.

That split is why the module is testable. A test hands in a string and
looks at the actions that come out:

```
makeActions("echo hi; ls -la")
  → [ { type: "print", content: "hi\n" },
      { type: "bash", command: "ls -la", cwd: "" } ]
```

Nothing ran, no approval was raised, and the assertion is on the decision
rather than on its output. `makeActions` is the whole deciding half of the
module in one call.

One caveat worth knowing: for a `&&` or `||` chain, `makeActions` lists the
actions for **both** sides. It reports what each command would do, not what
will actually run, because which side runs is decided at run time by the
exit status. That is right for testing and wrong for previewing; if a
preview use ever appears it needs its own function.

## bash is an action too

The fallback is a `BashAction`, so a command with no mapping is a decision
rather than a hole in the model. It carries the command **re-rendered from
its own AST**, not the caller's original string. That matters in a
sequence: if the second of three commands falls back, bash must be handed
the second command, not all three.

This is also what makes the failure story below coherent. In v1 a command
that could not be mapped was a failure that fell back to bash. Once a
sequence is running, "fall back" has no meaning — some commands have
already had their effects, and re-running the whole string would repeat
them. Making bash an action means falling back is a decision taken per
command, before anything runs.

## Falling back is not the same as refusing

Two different things happen to a command safeBash will not map, and the
distinction is worth keeping straight:

- **Falling back** — the command is understood but has no better tool.
  It becomes a `BashAction` and still runs, with the approval that implies.
  `ls`, `FOO=1 echo hi`, `echo -n hi`, `git log --graph`.
- **Refusing** — `makeAction` cannot produce any action at all. This
  should be rare, and today only happens when a command cannot be rendered
  back to bash source, which would leave nothing to run.

Unparseable input is a third case, handled a level up: `safeBash` hands the
whole original string to bash, because nothing has run yet and repeating
nothing is safe.

## Word splitting

The subtle rule, and the one that makes this feature safe or not.

```bash
F="a b"
cat $F      # TWO arguments to bash
cat "$F"    # one
```

An unquoted expansion whose value contains whitespace falls back rather
than being expanded. Expanding it without splitting would make safeBash and
bash disagree about what a command means, which is the one failure mode
this feature must not have. Inside double quotes no splitting applies, so
it expands normally.

Unset is the empty string, as in bash.

### Empty is a whole-word question

An unquoted expansion that comes out **empty** produces zero arguments in
bash, where treating it as `""` would produce one argument bash never
passed. The check belongs to the whole word, not to each expansion inside
it, and quoting is what decides:

| written | bash passes | safeBash |
|---|---|---|
| `echo $A` (unset) | no argument | falls back |
| `echo $A$B` (both unset) | no argument | falls back |
| `echo $A/bin` (unset) | `/bin` | maps |
| `echo "$A"` (unset) | one empty argument | maps |
| `echo ""` | one empty argument | maps |

The `$A$B` row is why the check cannot live inside the expansion: each half
is legitimately empty, and only the concatenated word is. v1 checked each
expansion and got this row wrong.

## Flags

The parser now returns flags as structured nodes (`{ tag: "flag",
flagName, flagValue }`) rather than as literal text, and `makeAction`
matches on them rather than around them. Both directions matter:

- `git diff --staged` is a **different tool call** from `git diff`. A rule
  that dropped the flag would answer one question with the other.
- `echo -n hi` is **not** `echo hi` — `-n` drops the trailing newline and
  `-e` interprets backslash escapes. A rule that treated the flag as text
  would print `-n hi`, which bash never does.

The standing rule is to fall back on any flag not explicitly translated. A
fallback costs an approval; a wrong translation costs correctness.

## Failure in a sequence

`runCommands` stops at the first failing command and reports, in one
message to the model:

- which command failed, and why
- the commands that already ran
- the output so far
- the commands that never ran

The unrun commands are rendered back to bash source with `astToBash`, since
by that point they are `Command` objects rather than strings. Telling the
model exactly how far it got is what replaces v1's "fall back to bash",
which cannot work once part of a sequence has already happened.

`&&` and `||` short-circuit as bash does, and both are one precedence
level, left-associative: `a || b && c` is `((a || b) && c)`. An `||` whose
two sides both fail reports both messages — a report naming only the second
would hide why the first was tried.

## Not wired in

`shellTools()` (`stdlib/agents/lib/toolkits.agency:91`) is untouched. No
agent's tool list changes, so nothing regresses.

Whether to trust it in the approval path is a different question and deserves
its own review with the risk in isolation. It is a one-line change to
`shellTools()` when we want it.

### The approval changes, and that is the point

When `echo hi > f` maps, the approval the user sees is `std::write`, not
`std::bash`. This is intended, and it is most of the value of the feature
rather than a side effect of it.

`std::write` is the more accurate gate. It says a file is being written and
names which one, where `std::bash` says only that a shell is involved and
leaves the reader to work out the rest from a command string. A policy is
written against effects, so a narrower effect is a policy that can be
written precisely: "writes under this directory are fine, shell commands
are not" becomes expressible for a command that previously could only be
described as shell.

The honest consequence is that a blanket approval of `std::write` now
covers redirects that used to land under `std::bash`. That is the correct
direction — those redirects really are writes, and were only ever shell
commands because nothing had looked at them.

## Next: the command table

Mapped today: `echo` (to `print`, or to `write` when redirected), and
`git status` / `git diff` / `git diff --staged` / `git log`.

The intended shape for the rest, to be confirmed per command against the
actual tool signature:

| command | tool | notes |
|---|---|---|
| `cat f` | `read` | single file only |
| `ls [dir]` | `ls` | |
| `grep pat files` | `grep` | flag translation needed |
| `find . -name g` | `glob` | narrow subset |
| `git show` / `git blame` / … | `gitShow` etc. | one tool per subcommand |
| `curl url` | `fetch` | |

Flags are still the work, but less of it than v1 expected: they arrive
already parsed, with `--name=value` split for us, so what is left is
deciding which ones are representable rather than parsing them first.

A redirected command is a separate decision per verb. `echo … > f` maps
because writing text to a file is what `write` does. `git status > f` falls
back, because the git tools return a structured result to us rather than to
a file, and honouring `>` would mean inventing a serialization bash never
produces.

## Open questions

- **Does a rewritten command get reported to the user?** Silently running
  something other than what was asked for is the kind of thing that should
  be observable. Leaning yes, via `whatIAmDoing`. The `Action` makes this
  easier than it was — it is a data object that can be rendered.
- **Does `safeBash` keep the name `bash` when handed to the LLM?** Renaming
  changes what the model writes.
- **Should the coding agent's prompt change once this exists?** Probably not —
  safeBash is a safety net, not a license to write bash.

### Settled since v1

- **Shape lock-in.** v1 flagged `Cmd` as a possible mistake whose test would
  be the first real change. The parser rewrite was that change, and the
  answer was to stop reducing to a record and produce an `Action` instead.
  `Action` is a better thing to freeze: it is what the module is *for*,
  where `Cmd` was an intermediate step that happened to be public.

## Parser gaps: resolved

v1 recorded two gaps in the bash parser — no node for glob patterns and
none for tilde expansion — which forced safeBash to scan literal text for
`*`, `?`, `[` and a leading `~` to work out what bash would rewrite.

The rewritten parser **rejects** both outright rather than emitting a
literal indistinguishable from ordinary text, so the scan is gone. The same
is true of command substitution, arithmetic expansion, pipelines,
background commands and `2>&1`. Rejecting is the right answer for a parser
whose consumers must never act on a wrong parse.

The cost is that four cases moved from "refused by safeBash with a specific
message" to "unparseable". Both paths end at bash, so no command changes
hands — only the reason reported.

## Found while building

Language and tooling issues hit by this module, all pre-existing, recorded
here rather than fixed in the same change.

- **A match arm does not narrow the scrutinee.** Writing
  `match (action) { { type: "print" } => printAction(action) … }` fails to
  typecheck, because inside the arm `action` still has the full union type.
  A chain of `if (action.type == "print")` narrows correctly. This affects
  every discriminated-union dispatch, which is the common case for an AST.
- **`if … then … else` cannot be an object field.** It is allowed only as a
  variable initializer or a return, so building a record with one
  conditional field needs a temporary, or two whole returns.
- **A method cannot be called on a comprehension.** `[x for x in xs].join()`
  does not parse; the comprehension has to be assigned first. (Already in
  `TODO.md`.)
- **A function's declared return type does not describe a rejected
  interrupt.** `bash()` is declared to return `ExecResult`, but rejecting
  its approval halts it and returns a `Failure`, which the declared type
  cannot express — so correct code has to go through `any` to check for it.
  This is a sharp edge: the obvious code typechecks, and crashes the first
  time a human says no.
- **The `Command` type-alias collision is gone.** v1 needed `any` on three
  locals because a field named `command` resolved to the type alias
  `Command` instead of the field's declared type. It no longer reproduces
  on the new types.
- **A blank line between match arms fails to parse when lowering is off.**
  `agency tc` accepts it, `agency fmt` rejects it, so a blank line between
  arms breaks the corpus round-trip gate. Still worked around by removing
  the blank lines.
- **A call inside a match-arm guard is invisible to the effects walk**
  (a known walker gap, tracked as issue 668). A call reachable only from a
  guard contributes no effects, which matters because effects are how the
  language reasons about what a function may do. Still avoided here by
  deciding before the match rather than in a guard on every arm.

## Related

- `docs/site/guide/interrupts.md`, `handlers.md`, `effects.md`, `policies.md` —
  the approval machinery this works around.
- `stdlib/shell.agency:133` — `bash()` and its interrupt.
- `stdlib/safeBash/actions.agency` — the action types and the executors.
- `tests/agency/safeBash.agency` — string in, actions out.
- PRs #674, #676, #677, #695, #698, #700, #701 — the pattern-matching work that
  made the match table expressible.
