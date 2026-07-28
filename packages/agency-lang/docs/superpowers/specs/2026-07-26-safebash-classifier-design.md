# safeBash v3: ask a better question, then let bash do the work

## Status

**Implemented.** See
[the implementation plan](../plans/2026-07-27-safebash-v3-classifier.md).
Rewritten 2026-07-27 around whole-string execution, after two rounds of
[review](./2026-07-26-safebash-classifier-design-REVIEW.md) and a design
discussion that changed the execution model.

Replaces the mapping design in
[the v2 spec](./2026-07-26-safebash-design.md), which shipped and is on
`main`.

Scope is deliberately narrow: **no new commands.** The classification
table covers exactly what v2 covers, and everything else keeps falling
back. This changes *how* safeBash decides and runs, not *what* it
recognizes.

## Background: what this module is for

An agent gets file, git, search and http tools, and a prompt telling it to
prefer them over the shell. It reaches for the shell anyway.

That costs autonomy, not safety. The read-only tools are pre-approved and
run without asking. `bash()` cannot be, because a command is a string and
a string could do anything, so it raises an interrupt every time. A run
that could have gone unattended becomes one you have to sit through,
approving `ls`, `cat` and `git status` by hand.

`safeBash` exists to close that gap: read the command the agent wrote,
and if we can tell what it is, **ask a more specific question** than "may
I run a shell command?" A specific question is one a policy can answer in
advance. The generic one never is.

## How v2 tried to do it, and why it broke

v2 parsed the command and, when it recognized one, **called an equivalent
Agency function instead of the shell.** `echo hi` became `print("hi\n")`.
`git status` became `gitStatus()`.

The appeal was that the function's own interrupt policy applied. The
problem is that a substituted function has to produce the same output as
the command it replaced, and past `echo` that is very hard.

`std::git` is where it became obvious. It does not run the command a user
types. It runs machine-readable variants, and deletes environment
variables before spawning:

| function | actual argv |
|---|---|
| `gitStatus` | `git status --porcelain=v2 --branch -z` |
| `gitLog` | `git log --format=%H␟%an␟%ae␟%aI␟%s␟%b␞ --end-of-options` |
| `gitDiff` | `git diff --patch -M --end-of-options` |

All of that is deliberate and good — machine formats parse reliably, and
scrubbing the environment stops it influencing git. But it means there is
no text lying around that matches what `git status` prints. Matching bash
byte for byte would mean matching the user's locale (git translates status
output), their `~/.gitconfig` (advice hints are configurable), and their
git version (hint wording changes between releases).

Measured, v2 does not match:

```
safeBash("echo hi && echo bye")  →  "hi\n\nbye\n"
bash     "echo hi && echo bye"   →  "hi\nbye\n"
```

and the *shape* of the return value depended on which path ran — raw text
for `echo`, one JSON object for git, a different envelope for the bash
fallback — so an agent could tell which decision safeBash had made by
looking at what came back. The v2 spec had decided it should not be able
to.

## The idea

Stop reproducing commands. Identify them, raise the interrupts that
describe them, and hand the whole thing to bash.

```
parse → classify every command → raise the effects → run the whole string in bash
```

The insight is that **substituting a function was never what made this
safe.** `gitStatus` spawns `git` either way. What made it safe was the
narrower question — `std::git::status` instead of `std::bash`, so a policy
can say "git reads are fine, arbitrary shell is not." That survives
without the substitution, and output fidelity comes free, because the
thing producing the output *is* bash.

## Execution: one bash call for the whole string

This is the centre of the design, and everything else follows from it.

```
1. Parse the string into commands.
2. Classify every command.
3. If any command is refused        → refuse the whole string. Nothing runs.
4. If any command needs std::bash   → raise ONE std::bash for the whole string.
5. Otherwise                        → raise every narrow effect, up front.
6. If everything was approved       → run the WHOLE string in one bash call.
```

Nothing executes until everything is approved.

### Why up front rather than command by command

The alternative is to approve and run each command in turn. It sounds more
precise and it is worse in three ways.

**It creates a half-executed state.** Approve the first command, reject
the second, and the first has already happened. There is no way to undo
it, and the model has to be told a complicated story about what did and
did not run.

**It asks silly questions.** `cd foo && git status` splits into an
unrecognized `cd` and a recognized `git status`. Command by command, a
human gets asked to approve a bare `cd`, which tells them nothing about
what is actually going on.

**It breaks the shell.** Each command in its own process means `cd` does
not persist, and neither do variable assignments. `cd foo && git status`
would run `git status` in the wrong directory.

Up front avoids all three. The cost is that we ask about effects that may
never happen: `git status && git log` raises both questions before
anything runs, even though the second command only runs if the first
succeeds. That is a much smaller problem than a half-run sequence.

(The example has to be an all-recognized chain to make the point.
Something like `false && git status` never gets there — `false` is
unrecognized, so the whole string collapses to one `std::bash` and the
narrow question is never asked.)

### Why one bash call

Because once everything is approved, splitting execution buys nothing and
costs a lot.

**Bash does the control flow.** We do not implement `&&`, `||` or `;`.
That is not a simplification for its own sake: our implementations of them
were where the divergences lived.

**There is nothing to join.** One process produces one stream, so the
extra-newline bug from v2 has nowhere to live. It is deleted rather than
fixed.

**Shell state works.** `cd foo && git status` behaves the way it does in a
terminal, because it *is* one shell.

**Fidelity is exact by construction.** The output is bash's, because bash
produced it in one go.

### If any part needs plain bash approval, the whole string does

`git status; curl evil.com` classifies as one recognized command and one
unrecognized one. Rather than raising `std::git::status` and then
`std::bash`, it raises **one** `std::bash` for the whole string.

The reasoning: we have to ask the broad question anyway, so asking the
narrow one first adds a prompt without adding information. And a human
approving `std::bash` should see the entire command, not a fragment of it.

## The two shell-free paths

Two cases never invoke a shell at all. Both apply **only when the whole
input is one command**, and both require **every argument to be fully
literal** — a plain word, a single-quoted string, or a double-quoted
string with no variables inside.

Both rest on one claim: `echo` prints its arguments joined by single
spaces followed by a newline, and we can compute that ourselves, exactly.
That is a small enough behavior to be provable and is already what the
existing code produces.

**A bare `echo` computes its own output.**

```
safeBash("echo hello")     → returns "hello\n"    no shell, no interrupt
safeBash("echo -n hi")     → flags change what echo prints  → bash
safeBash("echo $HOME")     → not fully literal             → bash
safeBash("echo hi; ls")    → a sequence                    → bash
```

This is the one place v2's structural safety was free, and it is worth
keeping: nothing here can write a file or reach the network no matter how
wrong the classifier is, because all it does is build a string.

Note it **returns** the text rather than printing it. `bash()` captures
stdout into its result, so safeBash does too; a shell-free path that wrote
to the console would be an observable seam between the two paths, and the
whole point is that an agent cannot tell them apart.

**A single redirected `echo` computes its content, then writes it.**

```
safeBash("echo hi > out.txt")
   compute "hi\n"
   raise std::write { dir, filename: "out.txt", content: "hi\n" }
   if approved → write
```

No shell is spawned here either. An earlier draft ran `echo hi` through
bash with the redirect stripped and only then raised `std::write` — a
shell spawn with nothing raised before it, contradicting the audit rule
below, and forcing an awkward argument about why running before approval
was tolerable.

Computing the content instead makes the path strictly better: the bytes
are in the approval payload **before** anyone approves, which is more
than v2 managed, and nothing runs if the write is rejected. It also
resolves an inconsistency — if the provable-equivalence claim is good
enough to generate what `echo` prints, it is good enough to generate what
`echo` writes. The earlier draft trusted it in one place and not the
other.

Everything else with a redirect goes to bash, under the redirect rules
below.

## Three outcomes

### Refuse

Some commands we decline to run at all, even with approval: `rm`, `rmdir`,
`dd`, `shred`, `mkfs`, `truncate`, and the destructive git subcommands
(`git clean`, `git restore`, `git reset --hard`, `git checkout .`).

An earlier draft listed `git checkout -- .` here. **It cannot be
refused**, because the parser rejects a bare `--` outright, so that string
never reaches classification and falls through as unparseable — under an
approvable `std::bash`. Checked against the parser rather than assumed.
Only the destructive *spellings* are refused, so `git checkout main` and
`git reset HEAD~1` are ordinary commands.

A refusal anywhere in the string refuses the **whole string**.

The reason for a wall rather than a prompt: an approval is a judgment made
quickly, often by an automated policy rather than a person, and for this
set the cost of getting it wrong cannot be undone. A refusal can be — the
human can run the command themselves.

**What the wall actually reaches.** It matches the command word, including
the last part of a path, so `rm`, `/bin/rm` and `./rm` are all refused. It
does **not** catch `find . -delete`, `xargs rm`, `python -c "os.unlink(…)"`
or `env rm`. Those classify as unrecognized, raise `std::bash`, and are
approvable like any other shell command.

So the wall is friction against the obvious spelling, not a guarantee. The
guarantee for everything else is that it asks first. This is worth saying
plainly, because the rationale above would otherwise read as a promise the
mechanism does not make.

### Ask, then delegate to bash

Everything recognized that is not refused and not shell-free.

| command | effect raised |
|---|---|
| `git status` | `std::git::status` |
| `git diff` | `std::git::diff` |
| `git diff --staged` | `std::git::diff` (with `staged: true`) |
| `git log` | `std::git::log` |
| `echo …` in a sequence | *(contributes nothing on its own)* |
| anything else | `std::bash` |

Effects **compose**: a string raises the union of what its commands
contribute, and each is a separate question. `git status > out.txt` asks
about the git read and the write separately, which v2 could not express at
all.

The default is always `std::bash`. Classification is an allowlist — a
command earns a narrower question by matching a rule, and everything else
gets the broad one.

### Redirects contribute on their own

A command's *verb* is not the only thing that decides what it can do. A
redirect writes a file whatever the verb is, so it has to contribute
independently of the table above. Without this rule there is a hole:

```
echo pwned >> .bashrc; git status
```

`echo` contributes nothing on its own and `git status` contributes a git
read, so the string would classify as `{ std::git::status }` — and a
policy that blanket-approves git reads would have silently approved
appending to a shell startup file. That must not be a possible reading.

Three rules:

1. **Any `>` or `>>` on any command contributes `std::write`**, with
   `{ dir, filename }` filled from the parse tree, regardless of what the
   command itself contributes.
2. **A redirect whose target contains a variable demotes the whole string
   to `std::bash`.** `std::write` cannot be raised without a filename, and
   the filename is not known without expanding the variable ourselves —
   which is exactly what the classification rule forbids. This is the same
   restriction the shell-free write path has, one level up.
3. **Any other redirect demotes the whole string to `std::bash`.** Input
   redirects (`< in.txt`) and explicit file descriptors (`2> err.txt`,
   `&>`) both reach classification, because the parser represents them.
   `< secret.txt` on an otherwise-recognized command is a read that the
   effect set would never otherwise mention, and rather than growing a
   table row per redirect kind, anything that is not a plain `>`/`>>`
   asks the broad question.

### The rule that closes the audit hole

`echo` contributes no effect. So a string of nothing but echoes —
`echo hi; echo bye` — would classify as fully recognized, raise nothing,
and spawn a shell unwatched. That is the one hole worth closing:

> **Spawning a shell always raises at least one effect.** If
> classification produced none and we are going to bash, raise
> `std::bash`.

This keeps the invariant that *every shell spawn was preceded by a raised
effect*, which is what makes a log of effects a complete audit of shell
invocations.

An earlier draft solved this with a new `std::echo` effect. That was the
wrong shape: a new effect needs an entry in
`lib/runtime/builtinPolicies.ts`, a decision about where it sits in
`std::capabilities` (and there is no good home — `Shell` is documented as
"the sharpest edge, grant with care", which `echo` is not), and every node
declaring `raises <FileRead, Network>` would break the moment it echoed.
A lot of blast radius for the most harmless command there is.

## Original text or rebuilt text?

The module parses the command, so it can hand bash either the agent's
original string or one rendered back out of the parse tree. Which it uses
depends on which question was asked:

> **If we asked narrow questions, run the string rebuilt from the parse
> tree.** We claimed the command is `git status`. We must run what we
> classified, not text we only assumed matched it.
>
> **If we asked for plain bash approval, run the original.** That is the
> text the human read and approved. Running something else — even a
> harmlessly re-spaced version — means they approved one string and we ran
> another.

Unparseable input is already in the second case, since there is no tree to
render.

This is why the rebuilt string matters where it matters: a **parser** bug
degrades to "we ran what we thought we read" rather than to arbitrary
execution. If the parser misread `rm -rf / ; echo hi` as just `echo hi`,
the renderer produces `echo hi` and that is what runs. What is left is
**classification** bugs — the table being wrong about a command it read
correctly — which is a much smaller and more reviewable surface.

This makes `astToBash` security-critical, which it was not before. It
earns a property test: for every command in the corpus, re-parsing the
rendered string must produce the same tree, and the corpus must cover
every command family in the table. (An earlier draft also rendered a
redirect-stripped form, for a write path that ran `echo` through bash.
That path is gone, and so is the extra rendering mode it needed.)

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

## The command word must be a plain word, and v3 has to add this

`$CMD status` with `CMD=git` must never classify as a git read. The
command name has to be a literal word in the source: not a variable, not a
path.

**This check does not exist today.** An earlier draft of this spec claimed
it did. `tokenize` reads `command.command` and uses `name.text` with no
tag check, and `ScriptName` is `LiteralWord | PathWord`, so a path word is
accepted and classified by its text. Safety currently holds
*incidentally* — a path contains a `/` so it cannot spell `git` — rather
than because anything checks.

That is fine while classification only picks a function to call. It stops
being fine once classification picks which question a human gets asked.
So v3 **adds** the check, and the test plan pins it, because a rule the
spec believes already exists is a rule nobody implements.

## Expansion: bash does it now

v2 expanded variables itself. `expandVariable` read the environment and
refused an unquoted value containing whitespace because bash would
word-split it; `stringifyArg` refused an unquoted expansion that came out
empty because bash would pass no argument at all. Those rules existed
because v2 had to reconstruct arguments, and each was a place where
safeBash and bash could disagree. One of them shipped as a bug.

**All of it goes away.** The string handed to bash contains `$FOO`, and
bash expands it: real word-splitting, real empty-drop, real `IFS`. A whole
class of refusal rules, and the divergence bugs that came with them, is
deleted rather than fixed.

What it costs is one rule, and it is a safety boundary one position to the
right of the plain-command-word rule:

> **Classification looks only at literal and flag words.** If a word in a
> position the table matches on is a variable, the command is not
> recognized and the string falls to `std::bash`.

`git status $X` must not become a git read on the strength of us expanding
`$X`. A variable in a position the table does *not* match on is fine to
pass through untouched — `echo $HOME` is still an echo, because the
question we are asking does not depend on what it expands to.

**The shell-free paths need the same rule, more strictly.** They never
invoke bash, so nothing else is there to expand anything: for
`safeBash("echo $HOME")` we would have to produce the text ourselves, with
machinery this section just deleted. So a shell-free path requires every
argument to be **fully literal** — a plain word, a single-quoted string,
or a double-quoted string containing no variables. An `echo` with any
expansion in it is not a shell-free path; as a single command it goes to
bash, and by the audit rule that raises `std::bash`.

The cost is that a bare `echo $HOME` now needs one broad approval. That is
honest: we genuinely do not know what it prints without expanding it, and
expanding it ourselves is where the divergence bugs lived.

We therefore never resolve a variable anywhere. Not for classification,
not for a payload, not for content.

**The wall and the classifier match differently, on purpose.** The refuse
wall looks at path words and at flag and path arguments (`git reset
--hard`). Classification refuses to look at anything but literals and
flags. The asymmetry is sound because the two can only fail in opposite
directions: a wall match causes a *refusal*, so looking at more is free,
while a classification match causes a *narrower question*, so looking at
anything the shell could reinterpret is dangerous. Worth stating, because
the instinct is to share one matcher, and sharing it would either blind
the wall or widen the classifier.

## How an effect actually gets raised

An effect is raised at a **named raise site**, not by name-as-data:
`interrupt std::git::status("…", { cwd })`. There is no "raise this
string" primitive, and if there were, safeBash's effects would be
invisible to `getEffects` and to the effect-propagation walk, both of
which read raise sites out of the source.

Two consequences:

**The dispatch is closed.** One `interrupt std::x(…)` arm per effect, and
`safeBash` grows a wide clause:

```
raises <std::bash, std::write,
        std::git::status, std::git::diff, std::git::log>
```

That clause is a feature — it is how an agent author discovers which
handlers to write — but it also means **adding a row to the table changes
safeBash's public effect signature.**

**Effects carry typed payloads.** The contracts are enforced at the raise
site:

```
effect std::write          { dir, filename }
effect std::git::status    { cwd }
effect std::git::log       { cwd, ref, path }
effect std::git::diff      { cwd, ref, ref2, staged, path }
```

Classification is where `filename`, `cwd` and `staged` are known, so the
plan carries them.

**Every payload also carries the full original string.** A payload may
have fields beyond its contract, and it should: a human approving
`std::git::status` for one part of `echo hi; git status` needs to see the
whole command, not the fragment. The prompt should read as "here is what
is about to run, and here is the part I need you to approve."

## The plan type, and why Action stays

v2's `Action` was a plain data object describing what would happen with
nothing having happened yet. That is what made the module testable — hand
in a string, look at what comes out — and it stays for that reason.

Interrupts alone would not be enough, which answers the question directly:
an interrupt is raised at run time and is not an inspectable artifact,
whereas `actionsFor(source)` is pure and returns data.

```ts
type Plan = {
  commands: Action[]     // one per parsed command — classification stays per command
  effects: Effect[]      // the union, which is what actually gets raised
  execution: Execution   // what happens if it is all approved
}

type Action = {
  command: string        // this command, rendered from the tree
  effects: Effect[]
  refused: boolean
}

type Execution =
  | { kind: "bash",      command: string }   // rebuilt or original, per the rule above
  | { kind: "print",     content: string }   // single bare echo
  | { kind: "write",     args: WriteArgs }   // single redirected echo
  | { kind: "refuse",    reason: string }
```

`Effect` is a discriminated union, not a bag of `any` — the effect set is
closed, so the payloads can be typed, and typing them is what makes the
raise-site arms check that each payload satisfies its contract.

**Classification stays per command even though execution does not.** That
is deliberate: it is what keeps the door open (see below), and it is what
the tests assert against.

`stdlib/safeBash/actions.agency` keeps `bashAction`, `printAction` and
`writeAction`. The git executors go, because git commands now relabel.

## What gets deleted

The runner. `runCommands`, `runCommand`, `andCommand`, `orCommand`,
`parensCommand`, `commandsToStr`, `failureReport`, `joinOutput` — all of
it. Bash does control flow, so we do not.

The expansion rules: `expandVariable`'s whitespace and empty-value
refusals, and `stringifyArg`'s whole-word emptiness check. Bash expands
now.

The v2 output-joining bug, which had no separate fix because the code that
caused it is gone.

The partial-failure report, and with it the "what ran, what didn't"
message. There is no half-executed state to report on any more.

## Executing without asking twice

There is a trap here that defeats the whole design if it is missed.

`bash()` in `std::shell` raises `std::bash` itself, every time, and then
calls an internal `_bash`. `write()` does the same with `std::write`. So
if safeBash raises `std::git::status`, gets approval, and then calls
`bash()`, the human is asked "are you sure you want to run this shell
command?" anyway — and the narrow question they just answered bought them
nothing. On the broad path they would be asked twice.

So after every effect in the plan is approved, safeBash executes through
the **non-raising internals**: `_bash` from
`agency-lang/stdlib-lib/shell.js`, and `_write` from
`agency-lang/stdlib-lib/builtins.js`. These are the same functions
`shell.agency` and `index.agency` call themselves once their own
interrupts return.

**This needs saying loudly, because bypassing a tool's interrupt is
normally forbidden.** Handlers are safety infrastructure and must never be
skipped by accident. Here it is not an accident, and the reasoning is
specific:

> The narrow interrupt **replaces** the broad one rather than preceding
> it. The only path to `_bash` runs through a raise of every effect in the
> plan, and any rejection returns before execution. So the command is
> never less gated than `bash()` would have made it — it is gated by a
> question that describes it better.

Two things have to hold for that argument to be true, and both are
testable:

1. **Every plan raises at least one effect before reaching `_bash`.** That
   is the audit rule above, and it is what stops a classification bug
   turning into an ungated shell call.
2. **Exactly one question is asked per effect.** A test has to *approve* a
   narrow effect and assert the command ran, not merely reject it — a test
   that only ever rejects the first interrupt passes whether or not a
   second one would have appeared.

## Leading assignments are not recognized

A command may carry variable assignments that apply to it alone:
`GIT_DIR=/elsewhere git status`. The assignment changes which repository
git reads, so classifying that as `std::git::status { cwd }` would
describe one read while bash performs another — the payload would lie.

Rather than model what each assignment might mean, **any command with a
leading assignment is not recognized** and the string falls to
`std::bash`. Bash applies the assignment itself, correctly, and the human
sees the whole command including the assignment.

## The return contract

One of the two motivating bugs was that the return shape depended on which
path ran. With one bash call the shape is simple, but it still has to be
stated:

**On success, the value is bash's stdout, raw.** Nothing added, nothing
stripped, nothing joined. This is the property the whole redesign buys.

**stderr is discarded on success and reported on failure.** Two captured
pipes cannot interleave the way a terminal does, so this is a policy
either way. Discarding on success keeps the success value exactly equal to
bash's stdout; including it on failure is what a model needs to debug what
it just ran.

**A non-zero exit is a failure**, carrying the command, the exit code and
stderr.

The known cost: **exit status is not the same as "went wrong"** for every
command. `grep` exits 1 when it finds nothing, `diff` exits 1 when files
differ, and neither is an error. Both fall back to `std::bash`, so both
get the blanket rule, and an agent sees a failure where bash would have
shown an empty result. Fixing that needs per-command exit semantics, which
is a table this change deliberately does not grow.

**Output is capped**, and truncation is marked in the returned text rather
than silent. Raw output with no bound is a context-window hazard that v2's
envelope quietly protected against; a visible loss of fidelity is a much
better failure than an invisible one.

**The shell-free write path returns the empty string on success**, which is
what bash's stdout for `echo hi > f` is. The invariant holds there by
construction, not by accident.

**A rejected approval is not a failed command.** Nothing ran, and the
message should say so rather than implying the command was attempted.

## Working directory

Resolved once:

> The caller's `cwd` if non-empty, otherwise `getAgentCwd()`. Resolved at
> the top of `safeBash` and used for the bash call, the fast-path function
> calls, and every effect payload that requires it.

This gets its own section because it is exactly what silently regressed in
the v2 pull request: `cwd` was honoured only when the command failed to
parse, so the same call behaved differently depending on whether the
string parsed.

## What approval means here

A narrower question is not always the *same* question the corresponding
function would ask.

The clearest case is a write. When the `write` function raises
`std::write`, its payload includes `content`, so a policy can inspect the
bytes. The shell-free write path preserves that, because it computes the
content before raising anything. But a `std::write` raised for a redirect
that goes to bash cannot: bash has not run, so the content does not exist
yet.

> A relabeled effect is approval of the **question**, not of the bytes. It
> says what kind of thing is about to happen and to what target, not what
> the result will contain, because bash has not run.

### Approving `std::write` can authorize a shell spawn

This one is easy to miss, and policy authors should learn it here rather
than from a test fixture.

A redirect contributes `std::write` whatever the verb is. So a command
that is *recognized* but not shell-free raises `std::write` alone — and
then runs through bash:

```
echo $HOME > out.txt
   the variable means this is not shell-free …
   … but echo is recognized, and the redirect contributes std::write
   → raises std::write ONLY, then runs the string in bash
```

That is within the rules, and the audit invariant holds: an effect was
raised before the shell started. But it means **a policy that
blanket-approves `std::write` is also approving shell execution of any
recognized command carrying a redirect.**

If that is not what you want, approve `std::write` conditionally on its
payload rather than wholesale. The payload names the directory and the
file, so a rule matching on `dir` is the natural way to bound it.

## What is weaker than v2

v2's gate was **structural**. `echo hi` called `print`, and `print` cannot
write a file or reach the network no matter how wrong the analysis was.

v3's gate is **analytical**. We read the command, decide what it is, and
hand it to a shell that can do anything. If the analysis is wrong, the
blast radius is whatever the string does.

Three things narrow this: the rebuilt-string rule means parser bugs
degrade safely, the plain-command-word rule stops a variable smuggling in
a different command, and the shell-free `echo` path keeps the structural
bound exactly where it was free.

The second weakness is the refuse wall, which stops the common spelling of
a destructive command and not the idea of one.

The third is small but real, and it is the one case where v3 asks a
*broader* question than v2 did. In v2, `echo a; echo b` was two `print`
calls and cost nothing. In v3 the shell-free path only covers a single
command, so a sequence of echoes goes to bash, and the audit rule means it
raises `std::bash`. Two harmless echoes now need an approval that used to
be free. That is the right trade — the alternative is a shell spawn with
no effect raised — but it is a regression and belongs on this list rather
than being discovered.

The judgment is that both are worth it. v2's structural bound only applied
to the handful of commands it could faithfully reimplement, and the
reimplementation was itself a source of divergence.

## What this design forecloses, and what it keeps open

Whole-string execution means safeBash is an **approval optimizer**: bash
executes everything, and what we contribute is deciding which question to
ask first. It is not a **capability layer** — it cannot route a command
inside a sequence to a constrained implementation, so it cannot make an
agent structurally unable to do something.

That is consistent with what the module has always been for. Every version
has been trying to fix prompting, not capability; the v1 spec's own
framing was "the cost is autonomy, not safety."

**What stays open.** Classification remains per command, so the
information a future per-command executor would need is already produced.
Going the other way later is additive:

> If every command is independently executable — no `cd`, no assignment
> feeding a later command — and at least one has a constrained
> implementation worth routing to, run per-command instead.

We would be adding a runner back knowing exactly which cases need it,
rather than building one now on the guess that we will.

**When to revisit.** If the goal becomes pointing safeBash at untrusted
output and relying on it to constrain what runs, that is the capability
layer, it needs per-command routing, and this design is the wrong
foundation for it.

## Open questions

- **Does `write` need `allowedPaths`?** It takes `dir` but, unlike
  `mkdir`, `copy` and `applyPatch`, has no path allowlist, so binding
  `dir` sets a base without checking whether `filename` climbs out with
  `../`. If that is right, the shell-free write path enforces less than it
  appears to.
- **A developer-supplied function table** — letting someone route a
  command to *their* bound tool — is deferred. It overlaps an existing
  design thread for tool rebinding (`provide { tool: impl }`), and two
  mechanisms for swapping an implementation under a name will eventually
  disagree about scoping. Settle that before building a second one.
- **Still not wired in.** `shellTools()` remains untouched. Whether to put
  this in an agent's approval path is a separate decision, and the thing
  that review should weigh is the analytical-versus-structural trade
  above.

## Follow-on

The integration test plan targets this design and is written separately.
Its shape: a pure layer asserting classification (`actionsFor`), cheap
enough for every pull request; a property test that `astToBash`
round-trips across every command family and the redirect-stripped form;
and a small sandboxed layer, gated behind an acknowledgement environment
variable and restricted to an allowlist of command names, that runs real
commands in a temporary directory and compares against real bash.

## Related

- [`2026-07-26-safebash-classifier-design-REVIEW.md`](./2026-07-26-safebash-classifier-design-REVIEW.md) —
  the two review rounds this answers
- [`2026-07-26-safebash-design.md`](./2026-07-26-safebash-design.md) —
  the v2 mapping design this replaces
- [`../ideas/2026-07-24-safebash-command-to-tool-matching.md`](../ideas/2026-07-24-safebash-command-to-tool-matching.md) —
  the original reasoning
- `docs/site/guide/handlers.md`, `effects-and-raises.md`, `policies.md` —
  the approval machinery this works with
- `stdlib/capabilities.agency`, `lib/runtime/builtinPolicies.ts` — the
  effect sets and named policies a new effect would have to join
- `stdlib/git.agency`, `lib/stdlib/gitCore.ts` — the machine-format argv
  and environment scrubbing described above
