---
name: "coding"
---

# coding

General-purpose coding agent: writes, edits, and runs code to complete a
  task, then verifies the produced artifact against the task's own success
  criteria. Composable — call it directly or from another agent.

## Functions

### codingAgent

```ts
codingAgent(
  task: string,
  context: string = "",
  maxCost: number = $50.00,
  maxTime: number = 10m,
): string
```

General-purpose coding agent. Writes and runs code to complete a task and
  verifies the result against the task's success criteria. Returns a short
  summary; the real output is filesystem side effects.

  @param task - What to build or fix.
  @param context - Optional extra material (data, examples, constraints).
  @param maxCost - Hard spend cap for the whole run (default $50).
  @param maxTime - Hard wall-clock cap for the whole run (default 10 minutes).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| maxCost | `number` | $50.00 |
| maxTime | `number` | 10m |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/coding.agency#L30))
