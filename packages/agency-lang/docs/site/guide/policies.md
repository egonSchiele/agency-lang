---
name: Policies
description: Explains how to define structured policies — rules matching on interrupt effect and data — to auto-approve or reject interrupts inside handler blocks.
---

# Policies

Claude Code has an interesting feature. When it asks you for approval for a tool, you can also say "don't ask me about this tool again". You auto-approve that tool for the future. How do you add a feature like that to your agent? By using policies.

## Basic policies

Here is an example of a policy:

```ts
  const policy = {
    "std::read": [{ action: "approve" }],
    "std::write": [{ action: "reject" }],
    "std::shell": [{ action: "reject" }]
  }
```

This policy approves all reads and rejects all writes and shell commands.

To use the policy, you need to check it in a handler block.

```ts
import { checkPolicy } from "std::policy"

handle {
  someFunc()
} with (interrupt) {
  return checkPolicy(policy, interrupt)
}
```

Policies are a structured way to respond to interrupts based on their effect.

The rules of handlers still apply, so if a policy approves an interrupt, but a different handler rejects it, that interrupt will still get rejected.

Here I've defined the policy as a variable, but its just an object. It could just as easily come from a JSON file, or a database.

## Matching on interrupt data

In this example, I am matching on the interrupt effect, but I can additionally match on the interrupt data too. For example, here is a policy that approves all reads from the `/tmp` directory, and rejects all other reads.

```json
{
    "std::read": [
      { "match": { "dir": "/tmp" }, "action": "approve" },
      { "action": "reject" }
    ]
}
```

The key is the interrupt's [effect](/guide/effects), and the value is an array of rules. For the rules, *first match wins*.

### Globs
You can also use *globs*. For example, here is a policy that allows users to read all Markdown files:

```json
{
    "std::read": [
      { "match": { "filename": "*.md" }, "action": "approve" },
      { "action": "reject" }
    ]
}
```

## Running with a policy from the command line

You don't have to wire a handler into your program to apply a policy. `agency run`
can install one for you, so you can constrain a program — including one you didn't
write — without touching its source:

```bash
# A named built-in policy
agency run agent.agency --policy recommended

# A policy JSON file
agency run agent.agency --policy ./my-policy.json

# Inline effect lists
agency run agent.agency --approve std::read,std::ls --reject std::write
```

The built-in names are `recommended`, `minimal`, `with-writes`, and `approve-all`.
`--approve` and `--reject` take comma-separated [effect](/guide/effects) names and
compose with `--policy`: they layer on top of it, and an effect named in both wins as
a **reject**.

### Fail-closed by default

Without `--interactive`, the policy runs non-interactively and **fails closed**: any
effect the policy doesn't explicitly approve is rejected. This is the safety property —
an unlisted destructive action can't slip through. Pass `--interactive` to be prompted
(approve / reject / approve-always / reject-always) on effects the policy doesn't cover,
instead of rejecting them.

The installed policy handler is the outermost one, so it has the final say: a program's
own `with approve` can't override it (see [handlers](/guide/handlers)).

### It covers code your agent runs, too

The policy applies to interrupts raised inside code run via
[`std::agency::run`](/stdlib/agency), not just the top-level program. This is what makes
it safe to let an agent write and run its own code. For example:

```bash
agency run driver.agency --approve std::run --approve std::read --reject std::write
```

Here `--approve std::run` lets the agent spawn the generated program, `std::read` is
allowed inside it, and any `std::write` the generated code attempts is rejected — even
if that code tried to approve its own write.

### Two things to keep in mind

- **Fail-closed overrides a program's own approvals of *unlisted* effects.** If a program
  raises and internally approves a custom effect the policy doesn't mention, a
  non-interactive policy rejects it. Add the effect to the policy, or use `--interactive`.
- **Input-style interrupts get only approve/reject.** An `interrupt("...")` used to fetch a
  value receives an approve/reject decision from a policy, not a free-text answer. Policies
  target approval-style (safety) interrupts.