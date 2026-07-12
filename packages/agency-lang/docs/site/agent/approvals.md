# Approvals and policies

The agent asks before it does anything that touches your machine. Writing a file,
running a shell command, making a git commit, or calling an
[MCP tool](/agent/mcp) all pause and wait for your say-so. A **policy** decides
which of those actions the agent may take without asking, so you are not
approving every file read by hand.

This is the agent's core safety mechanism. Reads and web lookups are cheap to
allow; writes and shell commands are not. The policy is where you draw that line.

## The approval prompt

When the agent hits an action the policy has not already decided, it stops and
asks you. You have three choices:

- **approve** — allow this one action.
- **reject** — deny it. The agent gets an error and continues without it.
- **always** — allow this action and every future action like it. The agent
  remembers the decision and never asks about it again.

An "always" decision is saved to your policy file, so it carries across sessions.

## Built-in policies

Four named policies cover the common cases:

| Name | What it auto-approves |
|---|---|
| `minimal` | Memory and the safe read-only Agency subcommands. You approve most things by hand. |
| `recommended` | Reading files and browsing the web. Writes, shell, and git still prompt. |
| `with-writes` | The above, plus file writes and git changes scoped to the current directory and its children. |
| `approve-all` | Every action, with no scoping. For sandboxes only. |

The first time you run the agent, it asks you to pick between `minimal` and
`recommended`. Your choice is saved. You can change it any time by editing your
policy file or passing `--policy`.

## The `--policy` flag

`--policy` overrides the saved policy for one run. Pass a built-in name or a path
to a policy file:

```bash
agency agent --policy recommended
agency agent --policy with-writes
agency agent --policy ./ci-policy.json
```

An override does not touch your saved policy. Any "always" decision you make
during that run is kept separate.

Run `--policy` with no value to print the built-in policies and exit:

```bash
agency agent --policy
```

## Policy files

Your policy lives at `~/.agency-agent/policy.json` (or under your
`--agent-home`). It is a map from an action's **effect name** to an ordered list
of rules. Each rule has a `match` and an `action`, and the first matching rule
wins.

```json
{
  "std::read": [
    { "action": "approve" }
  ],
  "std::write": [
    { "match": { "dir": "src/**" }, "action": "approve" },
    { "action": "reject" }
  ],
  "mcp::call": [
    { "match": { "server": "filesystem", "tool": "read_file" }, "action": "approve" }
  ]
}
```

A rule with no `match` matches every action for that effect. `match` values are
glob patterns, so `"src/**"` covers everything under `src`. The special effect
key `"*"` is a catch-all for any effect that has no rule of its own; this is how
`approve-all` covers everything at once.

An `action` is `approve`, `reject`, or `propagate`. `propagate` means "don't
decide here" and lets the prompt (or an outer handler) take over.

## Finer control with a handler

Policy rules match on flat fields like a path or a tool name. For logic they
cannot express, such as inspecting a tool's arguments, write a `handle` block for
the effect. The [MCP page](/agent/mcp#approvals) shows this pattern for
`mcp::call`, and the [`std::policy` reference](/stdlib/policy) covers the handler
API in full.
