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

In a non-interactive run (`-p`), an effect no rule decides is
auto-rejected with an explanatory message (`stdlib/policy.agency`) — there
is no one to ask.

## What "approve always here" pins

The prompt's "approve always here" answer saves a rule scoped to some of
the interrupt's data fields. Which fields is declared on the effect with
`@always` / `@alwaysUnder` (see
[effect-always-tag.md](../language/effect-always-tag.md)); the agent
passes no table of its own. `cliPolicyHandler`'s `fields:` argument is an
override: an entry replaces the declared scope for that effect, and an
empty list turns the option off. Interrupts that expect a value (a
question, a review) get no "always" answers at all.

## What `recommended` lets the agent read

The read-only file effects (`std::read`, `std::readBinary`, `std::ls`,
`std::glob`, `std::grep`) are approved in two places only
(`readScopeRules` in `lib/runtime/builtinPolicies.ts`):

- the launch directory and everything under it, written as `{.,./**}` so
  the rule keeps meaning "wherever the agent runs" after the policy is
  saved to a file (rule 2 below);
- the agency install's own `stdlib/` and `dist/` trees, written as
  `{<agency>/stdlib/**,<agency>/dist/**}`. The docs tools (`agencyGuide`,
  `agencyStdlib`, ...) are `read` partially applied to
  `stdlib/docs/<section>`, and the bundled skills are read the same way, so
  without this rule those tools return rejections in a headless run.

Both rules are placeholders, not paths. `.` expands to the process cwd and
`<agency>` to the directory the agency package is installed in
(`AGENCY_INSTALL_DIR_PLACEHOLDER`, `expandAgencyInstallDir`,
`getPackageRoot`), each at match time. The copy the agent saves to
`~/.agency-agent/policy.json` therefore pins neither the directory it was
first run in nor the install path of one version. After an upgrade moves the
package, the same rule still matches. A root that cannot be found (a bundled build
with no `package.json` above it) leaves `<agency>` as written and the rule
simply never matches.

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
rule. Every policy consumer forwards it: the run policy handler
(`--policy`, `AGENCY_RUN_POLICY`, a served invocation's policy), the CLI
decider, the MCP interrupt loop, and the agent's `cliPolicyHandler`; a
handler calling `checkPolicy` itself gets it as `.message` on the reject
result (returning the result directly also carries it).

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
