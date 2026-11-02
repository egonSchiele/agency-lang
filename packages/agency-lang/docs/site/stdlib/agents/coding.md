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

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the coding agent's built-in tools for inspection or extension.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/coding.agency#L69))

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
  session: string = "",
  extraTools: any[] = [],
): Result<string>
```

Write, edit, and run code to complete a task on disk. Returns a short
  summary; the real output is filesystem side effects.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  | What to accomplish |
| context | `string` | "" | Extra material folded into the prompt, or "" |
| maxCost | `number` | $50.00 | Cost budget in USD. |
| maxTime | `number` | 30m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| session | `string` | "" | Session name to share a thread across calls, or "" for isolated |
| extraTools | `any[]` | [] | Extra tools to offer the LLM, appended to the built-in set |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/coding.agency#L118))
