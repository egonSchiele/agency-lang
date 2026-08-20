# Approval policies: how rules match

The approval policy decides what an agent may do without asking. This page
covers the matching semantics in `lib/runtime/policy.ts`, because they have
surprised us more than once.

## Where policies come from

- With no `--policy` flag, `agency agent` loads the user's static file at
  `~/.agency-agent/policy.json`
  (`lib/agents/agency-agent/lib/policy.agency`, `getPolicyForAgent`).
- `--policy <name>` selects a built-in (`stdlib` `builtinPolicy`) and
  **replaces** the static file for that run — there is no merging.
- Built-ins like `with-writes` are constructed at launch with the process
  cwd baked into their dir rules.

In a non-interactive run (`-p`), an effect no rule decides is
auto-rejected with an explanatory message (`stdlib/policy.agency`) — there
is no one to ask.

## Rule matching

A rule is `{ match?: Record<string, string>, action }`. Each match value is
a picomatch glob tested against the interrupt's data field of the same name
(`origin` and `message` come from the interrupt itself). All entries must
match; a rule with no `match` is a catch-all.

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
