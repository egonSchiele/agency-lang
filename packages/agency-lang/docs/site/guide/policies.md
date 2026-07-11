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

You can also apply policies on the command line, when running an Agency program using `agency run`.

```bash
# A named built-in policy
agency run agent.agency --policy recommended

# A policy JSON file
agency run agent.agency --policy ./my-policy.json

# Inline effect lists
agency run agent.agency --approve std::read,std::ls --reject std::write
```

Notes:

- The built-in names are `recommended`, `minimal`, `with-writes`, and `approve-all`.
- `--approve` and `--reject` take comma-separated [effect](/guide/effects) names. Reject takes precedence, so if you have an effect in both approve and reject, it gets rejected.
- The [rules of handlers](/guide/handlers.md#the-rules-of-handlers) still apply. Think of this as just another handler.

### The `--interactive` flag

By default, any interrupts that aren't addressed by your policy, and aren't handled by your agent, will cause a crash. Run with the `--interactive` flag if you want to be prompted to approve or reject those interrupts instead.

