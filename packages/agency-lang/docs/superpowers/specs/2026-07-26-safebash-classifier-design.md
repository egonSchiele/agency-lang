# safeBash v3: classify the command, don't reimplement it

## Status

Design, not yet built. Replaces the mapping design described in
[the v2 spec](./2026-07-26-safebash-design.md), which shipped and is on
`main`. That spec stays as the record of how we got here; this one
describes what the module becomes.

An integration test plan exists in draft and is deliberately **not** part
of this spec. It targets the shape described here, so it is written after
this settles.

## Background: what this module is for

An agent gets file, git, search and http tools, and a prompt telling it to
prefer them over the shell. It reaches for the shell anyway.

That costs autonomy, not safety. The read-only tools are pre-approved and
run without asking. `bash()` cannot be, because there is no way to say in
advance what an arbitrary command string will do, so it raises an
interrupt on every call. A run that could have gone unattended turns into
a human approving a stream of `ls`, `cat` and `git status` by hand.

`safeBash` exists to close that gap: look at the command the agent
actually wrote, and if we can tell what it does, ask a narrower question
than "may I run a shell command?"

## How v2 tried to do it, and what went wrong

v2 parsed the command and, when it recognized one, **called an equivalent
Agency tool instead of the shell**. `echo hi` became `print("hi\n")`.
`git status` became `gitStatus()`. Anything unrecognized fell back to
`bash()`.

The appeal was that the tool's own interrupt policy applied. `print`
raises nothing, so `echo` became free. `write` raises `std::write`, so a
redirect asked a narrower question than `std::bash`.

The problem is that a substituted tool has to produce the same output as
the command it replaced, and for anything more complicated than `echo`
that turns out to be very hard.

`std::git` was where this became clear. It does not run the command a user
types. It runs machine-readable variants and deletes environment
variables before spawning:

| tool | actual argv |
|---|---|
| `gitStatus` | `git status --porcelain=v2 --branch -z` |
| `gitLog` | `git log --format=%H␟%an␟%ae␟%aI␟%s␟%b␞ --end-of-options` |
| `gitDiff` | `git diff --patch -M --end-of-options` |

All of that is deliberate and good: machine formats parse reliably, and
scrubbing the environment stops it influencing what git does. But it means
there is no raw text lying around that matches what `git status` prints.

To match `bash -c 'git status'` byte for byte you would have to reproduce
everything that shapes git's human output: the same arguments, the user's
locale (git translates status output), the user's `~/.gitconfig` (the
advice hints and untracked-file handling are configurable), and the user's
git version (hint wording changes between releases). Which is to say: the
only way to produce exactly what bash produces is to run exactly what bash
runs, in the environment bash runs it in.

Measured, v2 does not match. Two examples:

```
safeBash("echo hi && echo bye")  →  "hi\n\nbye\n"
bash     "echo hi && echo bye"   →  "hi\nbye\n"
```

The extra blank line comes from joining outputs that already end in a
newline. And the shape of the return value depends on which path ran —
raw text for `echo`, one JSON object for git, a different JSON envelope
for the bash fallback — so an agent can tell which decision safeBash made
by looking at what it got back. The v2 spec had explicitly decided it
should not be able to.

## The idea

Stop reproducing the command. Identify it, raise the interrupt that
describes it, and then run it through bash.

```
parse → classify each command → raise its effects → run it → return bash's output
```

The insight is that **substituting a tool was never what made this safe**.
`gitStatus` spawns `git` either way. What made it safe was the narrower
interrupt — `std::git::status` instead of `std::bash`, so a policy can say
"git reads are fine, arbitrary shell is not". That benefit survives
without the substitution, and fidelity comes free, because the thing
producing the output *is* bash.

## Three outcomes

Classification produces one of three results.

### Refuse

Some commands we decline to run at all, even if a human approves. This is
not a gate; it is a wall. `rm`, `rmdir`, `dd`, `shred`, `mkfs`,
`truncate`, and the destructive git subcommands (`git clean`,
`git reset --hard`, `git checkout -- .`, `git restore`).

The reason for a wall rather than a prompt: an approval is a judgment made
in a hurry, often by an automated policy rather than a person, and the
cost of getting it wrong for this set is unrecoverable. A refusal is
recoverable — the human can run the command themselves.

### Substitute a constraining tool

For a small set of commands, call an Agency tool instead of the shell.

The rule for when this is worth doing:

> **Substitute a tool when the tool can enforce a constraint the shell
> cannot. Relabel the effect when the tool is only another way to run the
> same program.**

Substitution buys enforcement and costs fidelity — a tool's output is its
own, not the command's — so the rule is really about whether the
enforcement is worth that.

Which stdlib tools can enforce something, checked against their
signatures:

| tool | constraint parameter |
|---|---|
| `fetch` | `allowedDomains` |
| `mkdir`, `copy`, `applyPatch` | `allowedPaths` |
| `ls`, `grep` | `allowedPaths` |
| `write` | `dir` only — no `allowedPaths` |
| `read` | `dir` only — no `allowedPaths` |
| `gitStatus`, `gitLog`, `gitDiff`, `gitShow` | none |

This is the language's own capability story. A developer who writes
`readFile.partial(dir: "/tmp")` has built a tool that *cannot* read
elsewhere. Relabelling an effect cannot participate in that: it asks "may
I write?", where a bound tool enforces "you may only write here."

**The clear cases.** `curl` and `wget` substitute to `fetch`: the domain
allowlist is the whole point, and curl is not really a network command
anyway — it writes files with `-o` and reads local ones through `file://`,
so `std::bash` is closer to honest than any single narrower effect would
be. `mkdir -p`, `cp`, `patch` and `git apply` substitute for the same
reason: their tools take `allowedPaths` and their output is uninteresting.

Git reads clearly do **not** qualify. `gitStatus` shells out to git and
enforces nothing a shell would not, so substituting buys no constraint and
costs exact output.

**The genuinely contested cases are `ls` and `grep`.** Both tools take
`allowedPaths`, which by the rule argues for substitution. Both also
return structured results that look nothing like what the commands print,
which argues for relabelling. The rule does not settle it, because the
trade is real in both directions: a developer running an agent over one
directory wants the path constraint enforced, and a developer whose agent
parses command output wants the output to be the command's.

**So the substitution table should be the developer's, not ours.** Rather
than picking for everyone, `safeBash` takes a map of bound tools:

```
safeBash.partial(tools: {
  curl: fetch.partial(allowedDomains: ["api.example.com"]),
  ls:   ls.partial(allowedPaths: [projectRoot]),
})
```

A command with an entry substitutes to that tool; a command without one
relabels and runs. This puts the constraint-versus-fidelity decision with
the person who knows which they need, and it means the enforcement is a
tool *they* bound rather than a default we chose. The built-in default
table stays small — `curl`, `wget`, `mkdir`, `cp`, `patch`, `git apply` —
and `ls`, `grep`, `cat` and redirects relabel unless a developer says
otherwise.

One thing to confirm during implementation: `write` takes a `dir` but no
`allowedPaths`, so binding `dir` sets a base directory without checking
whether `filename` climbs out of it with `../`. If that is right, a
redirect substituted to `write` is a weaker enforcement point than it
looks, and `write` either needs the parameter or needs the containment
check doing somewhere. `read` has the same shape and the same question.

### Relabel and run

Everything else we recognize. Raise the effect that describes the command,
then hand the command to bash.

| command shape | effects raised |
|---|---|
| `echo …` | *(none)* |
| `git status`, `git log`, `git diff`, `git show` | `std::git::status`, `std::git::log`, `std::git::diff`, `std::git::show` |
| `cat f` | `std::read` |
| `ls [dir]` | `std::ls` |
| `grep …` | `std::grep` |
| anything recognized but not listed | `std::bash` |
| anything unrecognized | `std::bash` |

Effects **compose**. `git status > out.txt` raises `std::git::status`
*and* `std::write` — two precise questions about one command. v2 could not
express that and fell back to a single `std::bash`.

The default is always `std::bash`. Classification is an allowlist: a
command earns a narrower effect by matching a rule, and everything else
gets the widest one. There is no shape that gets a narrower effect by
failing to match something.

## Two hard rules

These are the reason the design is defensible, and neither is negotiable.

### Bash receives a string re-rendered from the validated AST

Never the agent's original text. The module parses, classifies the tree,
and then renders that same tree back to shell source with `astToBash`.

Why it matters: it means a **parser** bug degrades to "we ran what we
thought we read" rather than to arbitrary execution. If the parser
misreads `rm -rf / ; echo hi` as just `echo hi`, the renderer produces
`echo hi` and that is what runs. What is left is **classification** bugs —
the effect table being wrong about a command it did read correctly — which
is a much smaller and more reviewable surface than "the shell did
something we did not see".

This makes `astToBash` security-critical, which it was not before. It
earns a property test: for every command in the corpus, re-parsing the
rendered string must produce the same tree.

Checked before adopting this design, `astToBash` preserves quoting on
every hostile input tried:

```
echo "a; rm -rf /tmp/x"   →  echo "a; rm -rf /tmp/x"
echo 'a; b'               →  echo 'a; b'
echo "a\"b"               →  echo "a\"b"
echo hi > "my file.txt"   →  echo hi > "my file.txt"
```

so the obvious injection route — losing the quotes and turning one command
into two — does not open. The property test is what keeps it that way.

### The command word must be a literal

`$CMD status` with `CMD=git` must never classify as a git read. The
command name has to be a literal word in the source: not a variable
expansion, not a path, not a quoted string that happens to expand to one.

This changed status between v2 and v3. In v2, expansion fed the *argument
list*, so getting it wrong was a correctness problem — the wrong text got
printed. In v3, expansion could feed *classification*, so getting it wrong
is a safety problem: the wrong question gets asked about the command that
runs.

The current code already requires the command word to be a `literal` tag,
which rejects both expansions and path words. This rule records why that
line has to stay.

## Execution model

**Per command.** The parser produces a list of commands; each one is
classified, gated and run separately. That preserves the property that
each command's approval is about that command, and it preserves the
partial-failure report from v2: when a sequence stops, the model is told
which command failed, what already ran and what it produced, and what
never ran.

The cost is that **shell state does not carry between commands**, because
each runs in its own bash process:

- `cd sub && ls` will not see the directory change
- `FOO=1; echo $FOO` will not see the assignment

Neither works today either — `cd` is not in the parser's supported subset,
and a leading assignment already falls back. But under v3 bash is the
executor for everything, so the limitation becomes much more visible and
needs stating plainly rather than being discovered.

The handling is to fall back: a command sequence that needs shell state to
persist is not something we classify per command, so it goes to bash as
one string, under one `std::bash` approval. That is the honest trade —
less precise gating, correct behavior.

## What happens to the v2 machinery

`Action` and its executors go away. `stdlib/safeBash/actions.agency`
mostly disappears; what survives is the substitution set (`fetch`,
`write`, `mkdir`, `copy`, `applyPatch`), which is much smaller.

`makeAction` becomes `classify`, returning a plan rather than an
instruction:

```ts
type Plan = {
  command: string      // re-rendered from the AST, never the original text
  effects: string[]    // the interrupts this command must raise
  outcome: "run" | "substitute" | "refuse"
}
```

The testing seam is unchanged in shape and slightly better in substance:
`plansFor(source) → Plan[]` is pure, takes a string, and returns data,
exactly as `makeActions` did. The existing tests move across nearly
one-for-one, asserting effects where they asserted action types.

Two pieces of v2 die usefully rather than being fixed:

- `joinOutput`'s extra-newline bug disappears, because we no longer join
  outputs — bash produces one stream.
- The return-shape inconsistency disappears, because every path returns
  bash's stdout.

## What is checked, and when

1. **Parse time.** The parser either reads a command correctly or rejects
   it; it never silently mis-parses. Globs, tilde, command substitution,
   pipelines, background commands and file-descriptor redirection are all
   rejected rather than represented, so they never reach classification.
2. **Classification time.** The command word is checked for being a
   literal, the refuse list is checked first, and effects are computed.
   Nothing has run.
3. **Approval time.** Each effect is raised as an interrupt. Handlers and
   policies decide.
4. **Run time.** The re-rendered command goes to bash, or to the
   substituted tool.

## What is weaker than v2, honestly

v2's gate was **structural**. `echo hi` called `print`, and `print` has no
capability to write a file or reach the network. If the analysis was
wrong, the blast radius was bounded by what `print` could do, which is
nothing.

v3's gate is **analytical**. We parse, conclude the command is harmless,
and hand it to a shell that can do anything. If the analysis is wrong, the
blast radius is whatever the string does.

The two hard rules narrow this most of the way back — a parser bug
degrades safely, and the command word cannot be smuggled in through an
expansion — and the measured behavior of `astToBash` closes the obvious
injection route. But it is a real change in the kind of guarantee being
made, and anyone reviewing this should know they are trading a structural
bound for a reviewable analysis.

The judgment is that the trade is worth it: v2's structural bound only
applied to the handful of commands it could faithfully reimplement, and
the reimplementation was itself a source of divergence. A correct
classifier over many commands is more useful than a structural guarantee
over three.

## Open questions

- **Does `write` need `allowedPaths`?** See the substitution section. If
  binding `dir` does not prevent `../` traversal, the write substitution
  is weaker than it looks.
- **How big is the default substitution table?** The design says
  developers supply their own map and keeps the built-in set to the
  commands where substitution is uncontested. Whether `ls` and `grep`
  should be in that default set, given they have `allowedPaths` but very
  different output, is the specific call to make.
- **Is `echo` really effect-free?** Raising nothing means an agent can
  spawn a shell unattended on the strength of the classifier alone. The
  alternative is a very low-friction effect that a policy blanket-approves
  once. Currently resolved as: raise nothing, because the residual risk is
  a classifier bug rather than an injection, and a classifier bug is
  reviewable.
- **Still not wired in.** `shellTools()` remains untouched. Whether to put
  this in an agent's approval path is a separate decision.

## Follow-on

The integration test plan targets this design and is written separately.
Its shape, in brief: a pure layer asserting classification (`plansFor`),
which is cheap enough for every pull request; a property test that
`astToBash` round-trips; and a small sandboxed layer, gated behind an
acknowledgement environment variable and restricted to an allowlist of
command names, that runs real commands in a temporary directory and
compares against real bash.

## Related

- [`docs/superpowers/specs/2026-07-26-safebash-design.md`](./2026-07-26-safebash-design.md) —
  the v2 mapping design this replaces
- [`docs/superpowers/ideas/2026-07-24-safebash-command-to-tool-matching.md`](../ideas/2026-07-24-safebash-command-to-tool-matching.md) —
  the original reasoning
- `docs/site/guide/interrupts.md`, `handlers.md`, `effects.md`,
  `policies.md` — the approval machinery this works with
- `stdlib/shell.agency` — `bash()` and its interrupt
- `stdlib/git.agency`, `lib/stdlib/gitCore.ts` — the machine-format argv
  and environment scrubbing described above
