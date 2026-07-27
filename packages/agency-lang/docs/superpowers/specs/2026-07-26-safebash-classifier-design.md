# safeBash v3: classify the command, don't reimplement it

## Status

Design, not yet built. Revised 2026-07-27 after
[review](./2026-07-26-safebash-classifier-design-REVIEW.md).

Replaces the mapping design in
[the v2 spec](./2026-07-26-safebash-design.md), which shipped and is on
`main`. That spec stays as the record of how we got here.

Scope for this change is deliberately narrow: **no new commands**. The
classification table covers exactly what v2 covers — `echo` and four git
reads — and everything else keeps falling back. This is a change to *how*
safeBash decides and executes, not to *what* it recognizes.

The integration test plan targets this design and is written separately,
after this settles.

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
locale (git translates status output), the user's `~/.gitconfig` (advice
hints and untracked-file handling are configurable), and the user's git
version (hint wording changes between releases). Which is to say: the only
way to produce exactly what bash produces is to run exactly what bash
runs, in the environment bash runs it in.

Measured, v2 does not match:

```
safeBash("echo hi && echo bye")  →  "hi\n\nbye\n"
bash     "echo hi && echo bye"   →  "hi\nbye\n"
```

and the shape of the return value depends on which path ran — raw text for
`echo`, one JSON object for git, a different JSON envelope for the bash
fallback — so an agent can tell which decision safeBash made by looking at
what it got back. The v2 spec had explicitly decided it should not be able
to.

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
without the substitution, and output fidelity comes free, because the
thing producing the output *is* bash.

## Three outcomes

Classification produces one of three results.

### Refuse

Some commands we decline to run at all, even if a human approves: `rm`,
`rmdir`, `dd`, `shred`, `mkfs`, `truncate`, and the destructive git
subcommands (`git clean`, `git reset --hard`, `git checkout -- .`,
`git restore`).

The reason for a wall rather than a prompt: an approval is a judgment made
in a hurry, often by an automated policy rather than a person, and the
cost of getting it wrong for this set is unrecoverable. A refusal is
recoverable — the human can run the command themselves.

**What the wall actually reaches.** It matches the command word, so it
catches the common spelling and a path whose basename matches
(`/bin/rm`, `./rm` — v3 checks the basename of a path word for exactly
this reason). It does **not** catch `find . -delete`, `xargs rm`,
`python -c "os.unlink(...)"`, or `env rm`. Those classify as unrecognized,
raise `std::bash`, and are approvable like any other shell command.

So the wall is friction against the obvious spelling, not a guarantee. The
guarantee for everything else is that it asks for `std::bash` approval
first. This is worth stating plainly because the rationale above — "the
cost of getting it wrong is unrecoverable" — would otherwise read as a
promise the mechanism does not make.

### Substitute a tool

For a small set of commands, call an Agency tool instead of letting bash
do the work. The rule:

> **Substitute a tool when the tool can enforce a constraint the shell
> cannot. Relabel the effect when the tool is only another way to run the
> same program.**

Substitution buys enforcement and costs fidelity — a tool's output is its
own, not the command's — so the rule is about whether the enforcement
earns that.

Which stdlib tools can enforce something, checked against their
signatures:

| tool | constraint parameter |
|---|---|
| `fetch` | `allowedDomains` |
| `mkdir`, `copy`, `applyPatch` | `allowedPaths` |
| `ls`, `grep` | `allowedPaths` |
| `write`, `read` | `dir` only — no `allowedPaths` |
| `gitStatus`, `gitLog`, `gitDiff`, `gitShow` | none |

Git reads clearly do not qualify: `gitStatus` shells out to git and
enforces nothing a shell would not, so substituting buys no constraint and
costs exact output.

**In this change, the table has one member: output redirection.**

Every other command where substitution would help — `curl` to `fetch`,
`mkdir -p` to `mkdir`, `cp` to `copy`, `patch` to `applyPatch` — is a
command safeBash does not recognize today, and adding them is out of
scope. The mechanism is specified here so that adding one later is a table
entry rather than a shape change.

**How a redirect substitutes without reimplementing anything.** For
`echo hi > f`, producing the content ourselves would be reimplementing
`echo`, which is the v2 trap. Instead, invert it:

1. Run the left-hand command through bash with the redirect stripped, and
   capture stdout. Bash produces the bytes, so fidelity holds.
2. Hand those bytes to `write`, which performs the write.

This keeps what v2's redirect handling was actually good at: `write`
enforces its `dir`, and the `std::write` interrupt carries **`content`**,
so a policy that inspects what is being written still can.

The ordering constraint: the command runs before the write is approved, so
a rejected write means the left-hand command already ran. That is only
acceptable when the left-hand command has no effects of its own. Today
that means **`echo` and nothing else** — any other command with a redirect
relabels and lets bash do the whole thing. A future command added to the
"effect-free" set must be justified on that basis specifically.

**Deferred: a developer-supplied substitution table.** The natural
extension is handing `safeBash` a map of bound tools, so a developer who
built `fetch.partial(allowedDomains: [...])` routes `curl` to *their*
constrained tool. Two reasons it is not in this change: there are no
commands to route yet, and the shape overlaps an existing design thread
for tool rebinding (`provide { tool: impl }`). Before building it, check
whether it should be that mechanism rather than a second one, since two
ways to swap an implementation under a name will eventually disagree about
scoping and precedence.

**One policy for whenever substitution grows:** when a tool cannot express
something the command asked for — a curl flag with no `fetch` parameter —
the command **falls back to relabel-and-run under `std::bash`**. It never
drops the flag and calls the tool anyway. That is v2's `git log --graph`
mistake, and it is the one failure mode this module must not have.

### Relabel and run

Everything else we recognize. Raise the effects that describe the command,
then hand the re-rendered command to bash.

| command shape | effects raised |
|---|---|
| `echo …` | `std::echo` |
| `echo … > f`, `>> f` | `std::echo`, then `std::write` (substituted — see above) |
| `git status` | `std::git::status` |
| `git diff` | `std::git::diff` |
| `git diff --staged` | `std::git::diff` (with `staged: true` in the payload) |
| `git log` | `std::git::log` |
| anything else, recognized or not | `std::bash` |

Effects **compose**: a command can raise more than one, and each is a
separate question. v2 could not express that, so a redirected git read
fell back to a single `std::bash`.

The default is always `std::bash`. Classification is an allowlist — a
command earns a narrower effect by matching a rule, and everything else
gets the widest one. No shape gets a narrower effect by failing to match
something.

**`std::echo` is new, and it is why every shell spawn is auditable.** It
would be tempting to let `echo` raise nothing, since it is harmless. But
v2's `echo` never spawned a shell and v3's does, so a silent `echo` would
be the one path where an agent reaches a shell with no effect raised. That
breaks an invariant worth keeping: *every shell spawn was preceded by a
raised effect*, which is what makes a statelog of effects a complete audit
of shell invocations.

**How `std::echo` costs an unattended run nothing.** There is no default
policy file — `lib/runtime/builtinPolicies.ts` defines named policies
(`recommended`, `minimal`, `with-writes`, `approve-all`) but none applies
unless `--policy` is passed. So "ships approved by default" has to be a
mechanism, not a file. The mechanism already exists: **an inner
`with approve` is non-authoritative.** Every handler up the chain runs,
and any rejection wins, so safeBash raising `std::echo` under
`with approve` means approved-unless-someone-says-otherwise — an
unattended run is never prompted, and a policy or handler that wants to
see echoes still overrides it. `std::echo` should also be added to the
`recommended` built-in policy, so the effect is discoverable to anyone
reading what that policy allows.

## How an effect actually gets raised

This is the part that constrains the implementation, and v3 has to be
built around it rather than discovering it.

**An effect is raised at a named raise site**, not by name-as-data:
`interrupt std::read("...", { dir, filename })`. There is no "raise this
string" primitive, and if there were, safeBash's effects would be
invisible to `getEffects` and to the effect-propagation walk, which read
raise sites out of the source.

Two consequences:

**The dispatch is closed.** The implementation is a `match` over the
effect enum with one `interrupt std::x(...)` arm per effect, and
`safeBash`'s signature grows a wide clause:

```
raises <std::bash, std::echo, std::write,
        std::git::status, std::git::diff, std::git::log>
```

That clause is a feature — it is how an agent author discovers which
handlers to write — but it also means **adding a row to the
classification table changes safeBash's public effect signature.** Anyone
adding a command has to expect that.

**Effects carry typed payloads, so a plan cannot hold bare names.** The
contracts are enforced at the raise site:

```
effect std::read           { dir, filename }
effect std::write          { dir, filename }
effect std::git::status    { cwd }
effect std::git::log       { cwd, ref, path }
effect std::git::diff      { cwd, ref, ref2, staged, path }
```

Classification is where `filename`, `cwd` and `staged` are known, so the
plan carries them.

## The plan type, and why Action stays

v2's `Action` was a plain data object describing what would happen, with
nothing having happened yet. That is what made the module testable — hand
in a string, look at what comes out — and it stays for exactly that
reason. What changes is what it describes.

```ts
type Action = {
  command: string        // re-rendered from the AST, never the original text
  effects: Effect[]      // what this command asks permission for
  outcome: Outcome
}
```

`Effect` and `Outcome` are **discriminated unions, not bags of `any`**.
The effect set is a closed enum — that is forced by the raise mechanism
above — so the payloads can be typed, and typing them is what makes the
raise-site `match` arms check that each payload satisfies its effect's
contract:

```ts
type Effect =
  | { name: "std::echo" }
  | { name: "std::bash",        payload: { command: string, cwd: string } }
  | { name: "std::write",       payload: { dir: string, filename: string, content?: string } }
  | { name: "std::git::status", payload: { cwd: string } }
  | { name: "std::git::log",    payload: { cwd: string, ref: string, path: string } }
  | { name: "std::git::diff",   payload: { cwd, ref, ref2, staged, path } }

type Outcome =
  | { kind: "run" }
  | { kind: "substitute", tool: "write", args: WriteArgs }
  | { kind: "refuse", reason: string }
```

Naming the tool and its arguments in `substitute` is also what keeps the
testing seam's "look at what comes out" property — an action that said
only "substitute" would hide the interesting half.

The interrupts alone would not be enough for testing, which answers the
question directly: an interrupt is raised at run time and is not an
inspectable artifact, whereas `actionsFor(source) → Action[]` is pure and
returns data. The action is strictly richer than v2's, because it now
carries the effects and their payloads — so the testing seam gets better,
not worse.

`stdlib/safeBash/actions.agency` keeps its executors. The set shrinks:
`bashAction` for the `run` outcome and `writeAction` for the one
substitution, with `printAction` and the git executors deleted because
those commands now relabel.

## Execution model

**Per command.** The parser produces a list of commands; each one is
classified, gated and run separately, in its own bash process. That keeps
each approval about the command it belongs to, and it keeps the
partial-failure report: when a sequence stops, the model is told which
command failed, what already ran and what it produced, and what never ran.

**Effects are raised lazily**, immediately before their command runs — not
up front for the whole sequence. For `a && b`, `b`'s interrupt is raised
only if `a` succeeded. Up-front approval would ask a human about effects
that may never happen, and would have to be revoked when the chain
short-circuits.

**Output is concatenated, and this is a joining policy we own.** The
review caught a contradiction in an earlier draft, which claimed the v2
extra-newline bug "disappears because bash produces one stream". It does
not: with per-command processes, bash produces one stream per command and
the module joins them. So the policy has to be stated rather than assumed:

> Concatenate the raw streams. Add nothing, strip nothing. Bash's output
> already carries its own trailing newline.

That is what fixes the v2 bug — `joinOutput` inserted a separator between
strings that already ended in one. It is a fix, not an absence.

**Shell state does not carry between commands**, because each runs in its
own process:

- `cd sub && ls` will not see the directory change
- `FOO=1; echo $FOO` will not see the assignment

Neither works today either — `cd` is outside the parser's supported
subset, and a leading assignment already falls back. But v3 makes bash the
executor for everything, so the limitation is more visible and needs
stating. The handling is to fall back: a sequence that needs shell state
to persist goes to bash as one string under one `std::bash` approval. Less
precise gating, correct behavior.

## The return contract

One of the two bugs motivating v3 was that the return *shape* depended on
which path ran. "Every path returns bash's output" fixes the
inconsistency, but it does not by itself say what the shape is, and the
v2 code shows how much is packed into that: `bashAction` returns a JSON
envelope of `{ command, stdout, stderr, exitCode }` with both streams
truncated to `MAX_STDOUT_LEN`, while the echo path returned raw text.

The v3 contract:

**On success, the value is bash's stdout, raw.** Nothing added, nothing
stripped, concatenated across commands in a sequence. That is the whole
point of the redesign, and it is what makes safeBash's output
indistinguishable from bash's.

**stderr is discarded on success and reported on failure.** Two captured
pipes cannot faithfully interleave the way a terminal does, so this is a
policy either way and the choice should be deliberate. Discarding it on
success keeps the success value exactly equal to bash's stdout, which is
the property we are buying; including it on failure is what a model needs
to debug the command it just ran.

**A non-zero exit is a failure**, carrying the command, the exit code and
stderr. This is required rather than aesthetic: `&&` and `||` are defined
in terms of it.

The known cost: **exit status is not the same as "went wrong"** for every
command. `grep` exits 1 when it finds nothing and `diff` exits 1 when
files differ, and neither is an error. Both fall back to `std::bash`
today, so both get the blanket rule, and an agent will see a failure where
bash would have shown it an empty result. Fixing that means per-command
exit-code semantics, which is a table this change deliberately does not
grow.

**Output is capped.** Raw concatenated streams with no bound is a
context-window hazard that the v2 envelope quietly protected against.
The cap stays, and truncation is marked in the returned text rather than
silent — a visible loss of fidelity is a much better failure than an
invisible one.

**The substituted redirect returns the empty string on success**, which
is what bash's stdout for `echo hi > f` is. The indistinguishability
invariant holds there, but by construction rather than by accident, so it
is worth stating.

## Expansion: bash does it now

v2 expanded variables itself. `expandVariable` read the environment,
refused an unquoted value containing whitespace because bash would
word-split it, and `stringifyArg` refused an unquoted expansion that came
out empty because bash would pass no argument at all. Those rules existed
because v2 had to reconstruct argv, and each of them was a place where
safeBash and bash could disagree — one of them shipped as a bug.

**Under v3's relabel path all of that goes away.** The re-rendered command
contains `$FOO`, and the bash child expands it: real word-splitting, real
empty-drop, real `IFS`. Fidelity is perfect because the shell is doing its
own job. A whole class of refusal rules, and the divergence bugs that came
with them, is deleted rather than fixed.

What it costs is a decision the spec has to record, because it is a safety
boundary one position to the right of the literal-command-word rule:

> **Classification matches on literal and flag words only.** If any word
> in a *matched* position is an expansion, the command falls back to
> `std::bash`.

`git status $X` must not classify as `std::git::status` on the strength of
us expanding `$X` — for the same reason `$CMD status` must not classify as
git. An expansion in an *unmatched* argument position is fine to pass
through untouched, because the effect does not depend on it: `echo $HOME`
is still `std::echo`, since the approval is of the question, not the
bytes.

**One edge needs its own rule.** A redirect whose target contains an
expansion — `echo hi > $F` — cannot be substituted, because `write` needs
a known filename at approval time and `std::write`'s payload requires
`filename`. Fall back to `std::bash` and let bash do the redirect.

The one place expansion still gets resolved by us is a redirect target
that is *not* an expansion, because the filename has to go into the
`std::write` payload and the `write` call.

## Working directory

`cwd` reaches everything, resolved once:

> The caller's `cwd` if non-empty, otherwise `getAgentCwd()`. Resolved at
> the top of `safeBash` and stamped into every action.

From there it flows to the bash invocation, to substituted tool calls, and
into effect payloads that require it — `std::git::status { cwd }` and the
other git effects all do.

This gets its own section because it is precisely what silently regressed
in the v2 pull request: `cwd` was honoured only when the command failed to
parse, so the same call behaved differently depending on whether the
string parsed. One resolution rule, applied once, prevents the repeat.

## Two hard rules

These carry the safety argument, and neither is negotiable.

### Bash receives a string re-rendered from the validated AST

Never the agent's original text. The module parses, classifies the tree,
and renders that same tree back to shell source with `astToBash`.

This means a **parser** bug degrades to "we ran what we thought we read"
rather than to arbitrary execution. If the parser misreads
`rm -rf / ; echo hi` as just `echo hi`, the renderer produces `echo hi`
and that is what runs. What is left is **classification** bugs — the
effect table being wrong about a command it read correctly — which is a
far smaller and more reviewable surface.

This makes `astToBash` security-critical, which it was not before. It
earns a property test: for every command in the corpus, re-parsing the
rendered string must produce the same tree, and the corpus must include
every command family in the classification table.

**The substitution path renders a second form**, and it needs the same
coverage. For `echo hi > f`, bash is handed the command *with the redirect
stripped* — which is not a new rendering mode in `astToBash`, but a render
of a modified tree: the same `SimpleCommand` with an empty `redirects`
list. That rendered string is one of the ones bash actually receives, so
the round-trip corpus has to include redirect-stripped forms too.

Checked before adopting this design, `astToBash` preserves quoting on
every hostile input tried:

```
echo "a; rm -rf /tmp/x"   →  echo "a; rm -rf /tmp/x"
echo 'a; b'               →  echo 'a; b'
echo "a\"b"               →  echo "a\"b"
echo hi > "my file.txt"   →  echo hi > "my file.txt"
```

so the obvious injection route — losing the quotes and turning one command
into two — does not open. The property test is what keeps it closed.

### The command word must be a literal — and v3 has to add this

`$CMD status` with `CMD=git` must never classify as a git read. The
command name has to be a literal word in the source: not a variable
expansion, not a path.

**This check does not exist today.** An earlier draft of this spec claimed
the current code enforces it; it does not. `tokenize` reads
`command.command` and uses `name.text` with no tag check, and `ScriptName`
is `LiteralWord | PathWord`, so a path word is accepted and classified by
its text. Safety currently holds *incidentally* — a path word contains a
`/`, so it cannot spell `git` — rather than because anything checks.

That incidental safety is fine while classification only affects which
tool gets called. It is not fine once classification decides which
interrupt gets raised. So v3 **adds** the check, and the test plan pins
it, because a rule the spec believes already exists is a rule nobody
implements.

**The wall and the classifier match differently, on purpose.** The refuse
wall looks at path words (it checks a basename, so `/bin/rm` is refused)
and at flag and path arguments (`git reset --hard`, `git checkout -- .`).
Classification refuses to look at anything that is not a literal or a
flag. The asymmetry is sound because the two matchers can only fail in
opposite directions: a wall match can only ever cause a *refusal*, so
looking at more is free, while a classification match causes a *narrower
effect*, so looking at anything the shell could reinterpret is dangerous.

This is worth stating because the natural implementation instinct is to
share one matcher between them, and sharing it would either blind the wall
or widen the classifier.

## What approval means here

A relabeled effect asks a **narrower question**, but not always the *same*
question the corresponding tool would ask.

The clearest case is a write. When the `write` tool raises `std::write`,
its payload includes `content` — a policy can inspect the bytes. The
declared contract only requires `{ dir, filename }`, so a relabeled raise
without content is legal, but any policy reading content would silently
see a thinner payload.

For redirects this is why the substitution above exists: running the
command first and handing the bytes to `write` keeps `content` in the
payload. For anything that relabels rather than substitutes, the general
shape holds and should be stated to handler authors:

> A relabeled effect is approval of the *question*, not of the bytes. It
> says what kind of thing is about to happen and to what target, not what
> the result will contain — because bash has not run yet.

## What is checked, and when

1. **Parse time.** The parser either reads a command correctly or rejects
   it; it never silently mis-parses. Globs, tilde, command substitution,
   pipelines, background commands and file-descriptor redirection are
   rejected rather than represented, so they never reach classification.
   This is a claim about tarsec, not about this module — the round-trip
   property test is what keeps us honest about relying on it.
2. **Classification time.** The command word is checked for being a
   literal, the refuse list is checked first, effects and payloads are
   computed. Nothing has run.
3. **Approval time.** Each effect is raised, lazily, immediately before
   its command runs. Handlers and policies decide.
4. **Run time.** The re-rendered command goes to bash, or to a substituted
   tool.

## What is weaker than v2, honestly

v2's gate was **structural**. `echo hi` called `print`, and `print` has no
capability to write a file or reach the network. If the analysis was
wrong, the blast radius was bounded by what `print` could do, which is
nothing.

v3's gate is **analytical**. We parse, conclude what the command is, and
hand it to a shell that can do anything. If the analysis is wrong, the
blast radius is whatever the string does.

The two hard rules narrow this most of the way back — a parser bug
degrades safely, and the command word cannot be smuggled in through an
expansion — and `astToBash`'s measured behavior closes the obvious
injection route. But it is a real change in the kind of guarantee being
made.

The second weakness is the refuse wall: it stops the common spelling of a
destructive command, not the concept. `find . -delete` and `xargs rm`
reach the approvable path. The wall is friction, and `std::bash` approval
is the actual control.

The judgment is that both trades are worth it. v2's structural bound only
applied to the handful of commands it could faithfully reimplement, and
the reimplementation was itself a source of divergence. A correct
classifier over many commands is more useful than a structural guarantee
over three.

## Open questions

- **Does `write` need `allowedPaths`?** It takes `dir` but, unlike
  `mkdir`, `copy` and `applyPatch`, has no path allowlist, so binding
  `dir` sets a base without checking whether `filename` climbs out with
  `../`. If that is right, the redirect substitution enforces less than it
  appears to. `read` has the same shape and the same question.
- **Should the substitution map be `provide { tool: impl }`?** See the
  deferred note above. Worth settling before building a second rebinding
  mechanism.
- **Still not wired in.** `shellTools()` remains untouched. Whether to put
  this in an agent's approval path is a separate decision, and the thing
  that review should weigh is the analytical-versus-structural trade
  above.

## Follow-on

The integration test plan targets this design and is written separately.
Its shape, in brief: a pure layer asserting classification
(`actionsFor`), cheap enough for every pull request; a property test that
`astToBash` round-trips across every command family in the table; and a
small sandboxed layer, gated behind an acknowledgement environment
variable and restricted to an allowlist of command names, that runs real
commands in a temporary directory and compares against real bash.

## Related

- [`2026-07-26-safebash-classifier-design-REVIEW.md`](./2026-07-26-safebash-classifier-design-REVIEW.md) —
  the review this revision answers
- [`2026-07-26-safebash-design.md`](./2026-07-26-safebash-design.md) —
  the v2 mapping design this replaces
- [`../ideas/2026-07-24-safebash-command-to-tool-matching.md`](../ideas/2026-07-24-safebash-command-to-tool-matching.md) —
  the original reasoning
- `docs/site/guide/interrupts.md`, `handlers.md`, `effects.md`,
  `policies.md` — the approval machinery this works with
- `stdlib/shell.agency` — `bash()` and its interrupt
- `stdlib/git.agency`, `lib/stdlib/gitCore.ts` — the machine-format argv
  and environment scrubbing described above
