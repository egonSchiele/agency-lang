# Approval policies: how rules match

The approval policy decides what an agent may do without asking. This page
covers the matching semantics in `lib/runtime/policy.ts`, because they have
surprised us more than once.

## Where policies come from

- With no `--policy` flag, `agency agent` loads the user's static file at
  `~/.agency-agent/policy.json`
  (`lib/agents/agency-agent/lib/policy.agency`, `getPolicyForAgent`).
- `--policy <name>` selects a built-in (`builtinPolicy` in
  `stdlib/policy.agency`) and **replaces** the static file for that run.
  There is no merging. If the name is not a built-in, `getPolicyForAgent`
  falls back to reading it as a policy file path, and exits with an error
  when that fails too.
- Built-ins like `with-writes` are constructed at launch with the process
  cwd baked into their dir rules.
- `--approve <effects>` / `--reject <effects>` (`agency run`,
  `agency test`, `agency remote call`, and
  `agency agent`) take comma- or whitespace-separated
  effect names and overlay blanket rules ahead of whatever base the run
  resolved — the saved file, a built-in, or a `--policy` path — with
  reject rules ahead of approve rules, so under first-match-wins the
  flags outrank the base and a reject outranks an approve for the same
  effect. A bare name that exactly matches a built-in capability set
  from `std::capabilities` (e.g. `FileRead`) expands to the set's member
  effects; any other bare name stays a plain effect name, since bare
  effect declarations are legal and the bare `interrupt("msg")` form
  raises the effect named `unknown`. A user effect whose bare name
  shadows a set is unreachable from the flags — namespace user effects.
  On the agent the overlay is session-only; the saved policy file is
  never written. Every command builds the overlay with
  `policyOverlayFromFlags` (`lib/runtime/policyFlags.ts`); the set table
  is parsed from `stdlib/capabilities.agency`
  (`lib/runtime/effectSets.ts`).

In a non-interactive run (`-p`), an effect no rule decides is
auto-rejected with an explanatory message (`stdlib/policy.agency`) — there
is no one to ask.

When a rule rejects in an interactive session, the handler prints one dim
line (`⏺ Policy rejected std::read (dir: /private/tmp, filename: …)`).
Without it a rejection is invisible: the only sign is the agent quietly
taking another route.

## A saved policy does not follow `recommended`

`policy.json` is written once, from the built-in the user picked on
their first run. After that `getPolicyForAgent` reads the file and
nothing else, so a rule added to `recommended` later never reaches
anyone who already has a file.

`/policy` in the agent
(`lib/agents/agency-agent/lib/slashCommands/policy.agency`) lists the
rules `recommended` has and the saved policy lacks, and adds them on a
yes. It is a command and not a startup step: a policy file should not
gain an approval its owner did not ask for. The saved file does not
record which built-in it came from, so the prompt says the rules are
`recommended`'s, and that adding them to a policy that started as
`minimal` makes it approve what `recommended` approves.

The two pure functions are in `lib/runtime/policyUpdate.ts`, and
`std::policy` exposes them as `missingPolicyRules` and `addPolicyRules`,
which work on the handler's active policy:

- Two rules are the same when their action, `rejectMessage`, and `match`
  entries are the same. A saved rule with an expanded path
  (`/Users/me/.agency-agent/tools`) is not the same as the placeholder
  form (`<agent-home>/tools`), so the command can offer a rule that
  repeats one the user already has. The repeat is harmless.
- An effect the saved policy decides with a rule that has no `match` is
  skipped. The first match wins, so nothing after that rule is reached.
- A saved `"*"` rule with no `match` makes the whole policy complete.
  Effect-specific rules are checked before the wildcard, so any added
  rule would overturn what the wildcard decides today.
- New rules are appended, never put in front, so every rule the user has
  keeps deciding what it decided.
- `addPolicyRules` changes the active policy only after the file is
  written. A failed save leaves the session on its old rules.
- Under `--policy`, `--approve`, or `--reject` the session runs on a
  per-session copy, so the command says so and changes nothing
  (`usesSavedPolicy` in `turn.agency`).

## Reading what you are approving

The prompt's first line is the effect, in bold, then the interrupt's
message, so which permission is being asked for is legible before the
reason for it.

The prompt is a pinned footer at the bottom of the terminal, so it shows
at most six physical rows of the interrupt's body
(`INTERRUPT_BODY_MAX_LINES` in `lib/stdlib/cli.ts`) and then an ellipsis.
Six rows is nothing next to a file being written, and that is a prompt
where the body is the whole point. (The two effects that carry source
code do not rely on the footer at all; see the next section.)

When the body is cut off, the widget adds one option of its own, `v`.
Typing it prints the entire body into the scrollback above the prompt,
which stays up waiting for the real answer. The write goes through the
patched stdout the bottom region installs, which is what puts it above
the footer rather than over it. No caller offers the option and no effect
can claim the key: `renderInterruptFooter` appends it and
`submitInterrupt` checks it before the option keys and before free text,
both gated on the same `bodyIsTruncated`, which the shell re-evaluates at
each keystroke so a resize mid-prompt cannot leave the footer offering a
key the reducer no longer honours. When nothing is cut off, `v` is an
ordinary free-text reason.

## An "always" answer covers the interrupts already waiting

Parallel tool calls raise their interrupts together, so every one of them
runs its policy check before any of them is answered. None finds a rule,
and they queue for the `std::tty` lock behind the first one's prompt. An
"always" answer to that first prompt has to cover the rest, or the user
answers the same question once per tool call.

Two things make that work, and both are needed:

- `askUser` runs `checkPolicy` again once it holds the lock, just before
  it would draw the prompt, so a rule saved by the interrupt ahead of it
  is seen. `applyRule` carries out the decision from either check.
- `recordAnswer` saves an "always" answer *before* releasing the lock.
  Recording it after, which is where it used to happen, loses the race to
  the next interrupt's check.

A sibling decided this way prints `⏺ Approved … by the rule just saved`
rather than nothing, so the prompt that did not appear is accounted for.

A "reject always" answer needs none of this: rejecting the first
interrupt sends the rest back through the handler, where the ordinary
check finds the new rule.

Testing any of it needs the LLM tool loop, not a `parallel` block: a
`parallel` block's arms consult the handler one after another, and each
arm gets its own copy of the module globals that hold the saved rules.

## A rule never approves a raise that expects a value

`askUserChoices` offers such a raise only the once-only answers, because
an effect-wide rule cannot answer a question that wants its own answer,
and an `approve()` carries no value, so the raise site reads it as a bare
yes — for `std::toolbox::review`, accepting a draft nobody looked at.

That one refusal has to hold in three places, because a rule reaches such
an interrupt by three routes:

- `recordAnswer` saves nothing for one. The prompt takes free text, so a
  user can type "aa" at a prompt that never offered it and
  `choiceResult` will read the string rather than the menu.
- The check under the lock skips one, so a rule a sibling saved in the
  same round cannot answer it.
- `_handler`'s ordinary check approves one no longer either, since a rule
  saved in an *earlier* round arrives by that route. A rule may still
  reject it: rejecting is the fail-closed direction and carries its
  message.

The cost is that a policy file cannot express "approve this
value-expecting effect without asking", and `approve-all` is no longer
quite all — its description says so. For the effects that expect a value
today (`std::question`, `std::skills::review`, `std::toolbox::review`), a
silent empty answer was not a useful thing to be able to ask for.

Headlessly such an interrupt is rejected, and the rejection says which of
the two things happened. "The policy has no rule for this effect" is the
message for no rule; a rule that approves but could not be used gets its
own, because the first one is false in exactly the case that produces it
and sends whoever reads it looking for a policy bug.

## The handler's own file operations

`_internalIo` names the operation open on the handler's own policy file,
`"std::read"` while it loads and `"std::write"` while it flushes, and is
`""` the rest of the time. Only the read half matches anything today:
`_writePolicyFile` writes through `writeText` directly, so a flush raises
no `std::write`. The flag is still set around it, because the window is
real either way — the containment check it awaits is time another branch
can arrive in — and a flush that ever goes through Agency's own `write`
should find the guard already here. `isOwnPolicyIo` approves an interrupt without
consulting the policy when it is that operation, on that file's name.

It is worth being clear about what this is not for. A handler never hears
its own raise: the chain walk skips an entry while that entry is
executing (see [handlers.md](../../site/guide/handlers.md)), so the read
inside `maybeLoadPolicy` does not come back through `_handler` at all. A
print put inside `isOwnPolicyIo` never fires on a plain load. What the
flag covers is a *second* entry of this same handler in the chain, which
does hear that read, shares these module globals, and whose no-match
propagate or `_policy == null` default would veto it, leaving every later
interrupt to prompt.

That second entry is not the only thing that can reach the handler while
the flag is set, which is the reason the check is narrow. The file
operation is awaited, and other execution paths — parallel tool calls, a
fork — have their own entries and are not excluded from anything. A bare
`if (_internalIo) { return approve() }`, which is what this was, approves
whatever any branch raises for the length of a file read, with no check
at all.

The name is matched, not the directory: the interrupt reports the
directory the containment layer resolved, which is the realpath, and on
macOS that is not the string the caller passed (`/tmp` against
`/private/tmp`), and Agency exposes no realpath to compare with. A read
of a same-named file in another directory, from another branch, inside
the window, is what is left.

`cli-policy-handler-parallel-rule` and `-flush` put three branches in the
handler while one of them reads or writes that file, with a policy that
rejects the effect, and count three rejections. Those rejections come
from a rule in the file, so the tests also show the load and the flush
still work through the narrower check — which is the real risk in
tightening it, because a check that is too tight fails silently and makes
everything prompt. What they cannot show is that a branch really did land
inside the window; that is up to the scheduler. The guarantee is
`isOwnPolicyIo`, not the timing.

## Code changes are shown as a diff

Two effects carry source code: `std::edit`, which is a change to a file,
and `std::toolbox::review`, which is a tool the agent has drafted. For
both, the change is the thing being judged, and six rows of a footer
cannot hold it. So the handler prints the whole change above the prompt,
as a syntax-highlighted unified diff, and the prompt's own body drops the
source and keeps the metadata that names the change.

`renderInterruptDiff` in `stdlib/policy.agency` decides whether an
interrupt has a diff and builds it; `printInterruptDiff` prints it. There
are exactly two callers, which is the part that is easy to get wrong:

- `askUser`, after its second policy check and before it draws the
  prompt. After that check, so an interrupt a rule decides there prints
  once rather than twice; under the lock, so a diff and the prompt it
  belongs to cannot be split apart by another branch's prompt.
- `applyRule`'s approve branch, which is where an interrupt a rule
  decided ends up, whether that rule was already in the policy or was
  saved a moment ago by a sibling in the same round. Neither draws a
  prompt, so the diff is the only record the user has of what happened.

The two differ on purpose. `askUser` prints under the lock; `applyRule`
does not, because `withLock` is non-reentrant and throws when the same
owner takes a lock it already holds, and a rule can decide an interrupt
raised by code that is already inside the lock. `applyRule` also prints
in a headless run, where the rejection line below it stays quiet: a
rejection there is a decision nobody needs the detail of, while an
approved change is the one record of something that happened.

A review's diff needs something to diff against. The design loop carries
the last draft the user saw in `previous` alongside `source` (see
`rounds` in `stdlib/toolbox.agency`), so the second round shows what
changed instead of the whole tool again. On the first round `previous` is
`""` and the diff is all insertions, which is how a new file reads too.

Both the source and the header run through `stripControlChars`, and so
do the prompt's title and every string value in its table, since the
agent picks some of those too (a tool's name, a filename, and the message
a tool it wrote raises its own interrupt with). It removes control
characters, a lone carriage return, and the bidi and zero-width characters behind
trojan source. Each of the three renderers drops a different subset on
its own — `diff` drops carriage returns, the table renderer drops ANSI —
so none of them can be relied on for this. Tabs and newlines stay.

## What "approve always here" pins

The prompt's "approve always here" answer saves a rule scoped to some of
the interrupt's data fields. Which fields is declared on the effect with
`@always` / `@alwaysUnder` (see
[effect-always-tag.md](../language/effect-always-tag.md)); the agent
passes no table of its own. `cliPolicyHandler`'s `fields:` argument is an
override: an entry replaces the declared scope for that effect, and an
empty list turns the option off. Interrupts that expect a value (a
question, a review) get no "always" answers at all.

## Effects that carry their own bookkeeping

Some stdlib work is a file operation only incidentally: the toolbox
counting a use in `meta.json`, or building a draft in its staging
directory. Those raise an effect of their own and then do the file work
with the non-interrupt primitives, so a policy can allow them without a
`std::write` rule on the agent home, and a rejection of writes elsewhere
still holds. `std::toolbox::scan`, `std::toolbox::recordUse`,
`std::toolbox::writeFile`, `std::toolbox::createStaging`,
`std::toolbox::removeStaging`, and `std::toolbox::removeStagedFile` are
the current set, and `recommended` approves every one of them under the
agent home. Writing a draft's files decides nothing: the user reads the
finished draft at `std::toolbox::review` and answers for it at
`std::toolbox::save`, and those two stay with the prompt.

An effect like this must scope its `@always` field to something durable.
`std::toolbox::writeFile` pins `root`, the toolbox, not `dir`, the
staging directory: a staging name ends in a random number, so a rule
pinned to it would match nothing ever again.

## What `recommended` lets the agent read

The read-only file effects (`std::read`, `std::readBinary`, `std::ls`,
`std::glob`, `std::grep`) and the scan effects that read a whole
directory under one approval (`std::skills::skillsDir`,
`std::skills::commandsDir`, `std::toolbox::scan`) are approved in three
places only (`readScopeRules` in `lib/runtime/builtinPolicies.ts`):

- the launch directory and everything under it, written as `{.,./**}` so
  the rule keeps meaning "wherever the agent runs" after the policy is
  saved to a file (rule 2 below);
- the agency install's own `stdlib/` and `dist/` trees, written as
  `{<agency>/stdlib/**,<agency>/dist/**}`. The docs tools (`agencyGuide`,
  `agencyStdlib`, ...) are `read` partially applied to
  `stdlib/docs/<section>`, and the bundled skills are read the same way, so
  without this rule those tools return rejections in a headless run;
- three directories of the agent home: its learned `skills/` and
  `tools/`, and its `memory/`, each listed as the directory and
  everything under it. The root is listed as well as its contents because
  a catalog scan of a whole directory names the root itself in its
  payload. Without this rule every read of a learned skill, every catalog
  scan, and every `runTool` would prompt, and would auto-reject headless.

The agent home as a whole is not in scope, and that is deliberate.
`sessions/` and `history` hold earlier conversations, often from other
projects, and these same rules cover `std::grep`, `std::glob`, and
`std::ls`, which search a whole tree. With the home in scope, text
injected into a file in one project could have the agent grep every
earlier conversation and put what it found into the query of a web
search, which `recommended` also approves. The user would not be asked
at any step.

`std::read` has one more rule than the others: `settings.json` in the
agent home, by name (`settingsReadRule`). The tree-searching effects
carry no `filename`, so a rule that names one cannot match them.

## Why `recommended` has no `std::write` rule

It approves no file write at all. `std::mkdir` has one, for the agent home
itself, which `writeSettingsFile` creates when it is not there yet: an
empty directory decides nothing, and the write into it still asks.

The write the agent most obviously wants is its own `settings.json`,
which `/model` and `/preset` save. That one is left to the prompt on
purpose. settings.json decides what the next agent start runs: an
`mcpServers` entry is a command, which `maybeLoadMcp` passes to the mcp
package and `StdioClientTransport` spawns, and `loadSettings` sanitizes
`capabilities` and `model.slots` but not that field. A rule approving
that write would let text injected into one project write the agent a
command to run, with the user asked at no step. The cost of leaving it
out is one prompt when you change your model.

Three more things in that same directory are the same kind of hole, so
no `dir` rule covers the home either:

- `policy.json` and `session-policy.json`. They *are* this policy. An
  agent that can rewrite them can grant itself anything it likes, and the
  approval prompt stops meaning what it says.
- `skills/**`. A skill gets there through `designSkill`'s review; a plain
  write would put one there without it.
- `tools/**`. The same, through the toolbox's review and save gates.

`recommended` also approves `std::toolbox::recordUse` under
`<agent-home>/tools/**`, the effect `runTool` raises before counting a
use in the tool's `meta.json`. It is an effect of its own rather than a
`std::write` rule on that filename because a path glob cannot tell the
stdlib's bookkeeping from any program writing arbitrary content into
`meta.json`, whose `purpose` text `listTools` then trusts and whose
`maxTime` sets the run's time limit. Approving the effect approves only
the record the stdlib composes.

The save and review gates (`std::skills::save`, `std::skills::review`,
`std::toolbox::save`, `std::toolbox::review`) have no rule in any
built-in but `approve-all`. They prompt.

All three read rules, and the `std::mkdir` rule, are placeholders, not paths. `.` expands to the
process cwd, `<agency>` to the directory the agency package is installed
in (`AGENCY_INSTALL_DIR_PLACEHOLDER`, `expandAgencyInstallDir`,
`getPackageRoot`), and `<agent-home>` to `AGENCY_AGENT_HOME` or
`~/.agency-agent` (`AGENT_HOME_PLACEHOLDER`, `expandAgentHomeDir`,
`agentHomeDir` in `lib/runtime/agentHome.ts`), each at match time. An
empty `AGENCY_AGENT_HOME` counts as unset, and a relative one resolves
against the cwd, the way the `--agent-home` flag does. The copy the
agent saves to `~/.agency-agent/policy.json` therefore pins neither the
directory it was first run in, nor the install path of one version, nor
one machine's home. A root that cannot be found (a bundled build with no
`package.json` above it) leaves `<agency>` as written and the rule simply
never matches.

The expanded home is resolved through `root()` in `lib/stdlib/contained.ts`,
the same walker every file effect uses for the directory in its payload,
so a home reached through a symlinked ancestor (`/tmp` on macOS, a linked
`$HOME`) matches the payload's spelling. The scan and save effects in
`std::skills` and `std::toolbox` put that spelling in their payloads too,
so one rule covers a read and the scan that precedes it. Below an
approved directory, a symlinked skill or tool directory is hidden from
scans and refused by reads and writes, as everywhere else (see
`docs/dev/stdlib/contained-files.md`).

A policy file saved before this change keeps its old catch-all read rules;
there is no migration. Delete the file (the agent writes a fresh
recommended policy on the next launch) or edit the five read effects.

There is deliberately no trailing `reject`. A read elsewhere is undecided,
so it prompts in an interactive session and auto-rejects in a headless one.
The agent's own reads of its home directory (`~/.agency-agent`) do not go
through the policy at all (`_internalIo` in `stdlib/policy.agency`).

Before this, `recommended` approved every read anywhere, and a verifier
under eval used that to list the home directory and read the repo's
`package.json` while hunting for an `agency` binary.

## Rule matching

A rule is `{ match?: Record<string, string>, action, rejectMessage? }`.
Each match value is a picomatch glob tested against the interrupt's data
field of the same name (`origin` and `message` come from the interrupt
itself). All entries must match; a rule with no `match` is a catch-all.

A reject rule may carry a `rejectMessage`: the rejection's reason,
handed back to whoever raised the interrupt. For a rejected tool call it
is what the model reads, so it can steer the next attempt — e.g. a rule
rejecting `std::bash` with `"rejectMessage": "Use safeBash instead"`.
`validatePolicy` refuses a `rejectMessage` on an approve or propagate
rule, and refuses an empty one (a blank reason would replace the default
messages). A handler calling `checkPolicy` itself gets the message as
`.message` on the reject result; returning the result directly from the
handler also carries it.

A failed validation fails the whole policy file, so the loaders are
deliberate about what happens next. The CLI handler warns and continues
with an empty policy (which fails closed in a non-interactive run). The
serve-side `PolicyStore` also continues with an empty policy, but
refuses `addRule`/`removeRule` until the file is fixed — saving from the
empty in-memory policy would overwrite the user's rules on disk. `set()`
and `clear()` stay allowed as explicit overwrites.

Three semantics to keep straight:

1. **Values arrive absolutized.** Agent tools are bound with
   `useAgentCwd: true`, so the `dir` in interrupt data is an absolute path
   by the time the policy sees it. A relative pattern in a policy file
   therefore never matches an agent's dir — except via the dot rule below.
2. **`.` in a `dir` pattern means the launch directory.** A `dir` pattern
   gets a second match attempt with `.` resolved against `process.cwd()` —
   standing alone (`"."`), as a prefix (`"./sub/**"`), or as a brace
   alternative (`"{.,./**}"`). This lets a static policy say "wherever the
   agent is running" instead of hard-coding an absolute path. The raw
   pattern is always tried first, so no existing match is taken away. Only
   the `dir` field resolves; `command` and the rest match raw.
3. **`**` never matches a dot-led segment.** picomatch's dot rule: a glob
   `base/**` does not reach `base/.staging/x`. Dot segments in the
   *literal* prefix are fine — a launch directory whose own path contains
   `.staging` works, because only the suffix is matched by `**`. This is
   what shields `.git` from broad approve rules, and also what makes
   dot-led subdirectories invisible to them.

## The eval case, concretely

`eval run --agent-cmd` launches the agent with cwd
`<group>/.staging/<testId>/workdir`. A static rule scoped to the repo
cannot reach it (rule 3: the `.staging` segment would have to be matched
by `**`). Either give the eval command `--policy with-writes`, or put a
`{.,./**}`-scoped rule in the static file (rule 2) — both resolve to the
staged workdir at launch, where the dot segments are literal prefix and
match fine.

## Filename containment (the contained-filename wrappers)

The single-file stdlib wrappers (`read`, `write`, `readBinary`,
`writeBinary`, `edit`, and the four file wrappers in `std::agency`) prepare
their `(dir, filename)` pair before raising: `dir` is realpathed, the
filename is normalized, and any stable escape — an absolute path, `~`,
upward traversal, or a symlink whose target leaves `dir` — is rejected
BEFORE the interrupt exists. No policy or human can approve an escape,
because no escape request is ever raised. `prepareContainedPath`
(`lib/stdlib/prepareContainedPath.ts`) owns the rule, re-exported to Agency
as `_prepareContainedPath` from `lib/stdlib/fs.ts`. The spec is
`2026-08-20-contained-filename-spec.md` at the package root.

The migration rule doubles as the design principle: **the destination
belongs in `dir`, because `dir` is the field a policy rule (or a human)
judges.** `write("/tmp/report.txt")` is refused with an error that teaches
the fix — `write("report.txt", dir: "/tmp")` — and the interrupt then
reports `/tmp` truthfully.

safeBash is the exception that proves the trust rule: its whole command is
untrusted, so there is no trusted `dir` to contain within. Its redirect
writes instead report the resolved parent of the target (quote-aware: an
unquoted `~` expands, a quoted one does not), so the policy judges the
real destination. Targets it cannot resolve (dangling symlinks, loops,
variables) fall back to the broad `std::bash` question.

What this does NOT defend against: a hostile local process swapping a
directory for a symlink between approval and execution. Node exposes no
primitive that closes that race on the platforms we support, and a local
process with that access already owns the account. Stable escapes are the
threat model; races are explicitly out of scope.
