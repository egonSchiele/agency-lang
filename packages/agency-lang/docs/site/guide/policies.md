# Policies

Claude Code has an interesting feature. When it asks you for approval for a tool, you can also say "don't ask me about this tool again". You auto-approve that tool for the future. How do you add a feature like that to your agent? By using policies.

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
import { checkPolicy } from "std::policy

handle {
  someFunc()
} with (interrupt) {
  return checkPolicy(policy, interrupt)
}
```

Policies are a structured way to respond to interrupts of different kinds. They don't magically get applied, you need to call the `checkPolicy()` function yourself. The rules of handlers still apply, so if a policy approves an interrupt, but a different handler rejects it, that interrupt will still get rejected.

Here I've defined the policy as a variable, but its just an object. It could just as easily come from a JSON file, or a database.

In this example, I am matching on the interrupt kind, but I can additionally match on the interrupt data too. For example, here is a policy that approves all reads from the `/tmp` directory, and rejects all other reads.

```json
{
    "std::read": [
      { "match": { "dir": "/tmp" }, "action": "approve" },
      { "action": "reject" }
    ]
}
```

The key is the interrupt type, and the value is an array of rules. For the rules, first match wins.

You can also use globs. For example, here is a policy that allows users to read all Markdown files:

```json
{
    "std::read": [
      { "match": { "filename": "*.md" }, "action": "approve" },
      { "action": "reject" }
    ]
}
```