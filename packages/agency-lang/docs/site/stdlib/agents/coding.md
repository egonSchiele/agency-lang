---
name: "coding"
description: "Writes, edits, and runs code to complete a task on disk. One"
---

# coding

honest pass: it works until it believes the task is done, then returns a
  summary.

  The real output is filesystem side effects; the returned string is a
  summary. This agent does not verify its own work against the task. To add
  verify-and-fix, compose it with verifierAgent, or run it under supervise
  (std::supervise) for mid-run course correction:

    supervise(every: 5m, maxTime: 30m, check: myCheck) {
      return codingAgent(task, maxTime: 30m)
    }

  For an Agency-specific coding agent, use std::agents/agency/coding.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the coding agent's tools. Exported so a caller can inspect what the
  agent may do, and so tests can assert it.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/coding.agency#L54))

### codingAgent

```ts
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

  @param task - What to accomplish
  @param context - Extra material folded into the prompt, or ""
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| maxCost | `number` | $50.00 |
| maxTime | `number` | 30m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/coding.agency#L101))
