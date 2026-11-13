---
name: "coding"
description: "Write, edit, and run code to complete a task on disk."
---

# coding

The returned string summarizes the work. Files and other effects are the
deliverable. Use `verifierAgent` afterwards to check the result against the
task, or `std::agents/agency/coding` to generate Agency source as text.

```ts
import { codingAgent } from "std::agents/coding"

node main() {
  const result = codingAgent("Create a CSV report in report.csv")
  print(result)
}
```

When called as an LLM tool, `codingAgent` continues the caller's conversation.
From code, wrap the call in `thread { ... }` to keep its messages out of the
current thread. GitHub work goes through `githubAgent`, which it carries as a
tool.

The model reports progress in a sentence beside each tool call, and
nothing prints it by default. `std::agents/lib/toolkits` shows the
callback that does.

## Functions

### benchVariant

```ts
benchVariant(): string
```

**Returns:** `string`

**Throws:** `std::env`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/coding.agency#L76))

### buildTools

```ts
buildTools(variant: string = ""): any[]
```

Return the coding agent's built-in tools for inspection or extension.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| variant | `string` | "" | The ablation variant, or "" for the round-2 Pi match |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/coding.agency#L207))

### codingAgent

```ts
@guarded(cost: maxCost, time: maxTime)
codingAgent(
  task: string,
  context: string = "",
  maxCost: number = $50.00,
  maxTime: number = 30m,
  model: string = "",
  provider: string = "",
  extraTools: any[] = [],
): Result<string>
```

Write, edit, and run code to complete a task on disk. Returns a short
  summary; the real output is filesystem side effects. It continues your
  conversation, so it already sees the work above.

Called from code, this runs on the caller's thread like any function:
  the tool results and the answer stay there, and the system prompt is
  removed when the agent finishes. Wrap the call in `thread { ... }` to
  keep them apart.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  | What to accomplish |
| context | `string` | "" | Extra material folded into the prompt, or "" |
| maxCost | `number` | $50.00 | Cost budget in USD. |
| maxTime | `number` | 30m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| extraTools | `any[]` | [] | Extra tools to offer the LLM, appended to the built-in set |

**Returns:** `Result<string>`

**Throws:** `std::guard`, `std::env`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/coding.agency#L294))
