---
name: "coding"
description: "General-purpose coding agent: writes, edits, and runs code to complete a task, then verifies the produced artifact against the task's own success criteria."
---

# coding

General-purpose coding agent: writes, edits, and runs code to complete a
  task, then verifies the produced artifact against the task's own success
  criteria.

## Functions

### codingAgent

```ts
codingAgent(
  task: string,
  context: string = "",
  criteria: string[] = [],
  maxAttempts: number = 3,
  maxCost: number = $50.00,
  maxTime: number = 30m,
  checkpoint: number = 0,
): string
```

General-purpose coding agent. Writes and runs code to complete a task and
  verifies the result against the task's success criteria. Returns a short
  summary; the real output is filesystem side effects.

  @param task - What to build or fix.
  @param context - Optional extra material (data, examples, constraints).
  @param criteria - Optional authoritative acceptance criteria (e.g. an expert
    checklist) passed through to `verify` so the strict review checks those
    exact items, not just its own re-derivation.
  @param maxAttempts - Max verify-and-fix attempts before returning (default 3).
  @param maxCost - Hard spend cap for the whole run (default $50).
  @param maxTime - Hard wall-clock cap for the whole run (default 30 minutes).
  @param checkpoint - If > 0, verify the disk output at this interval and either
    redirect the agent (when it is making progress) or stop it (when it is
    thrashing or out of time). 0 keeps the plain single-guard behavior.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| criteria | `string[]` | [] |
| maxAttempts | `number` | 3 |
| maxCost | `number` | $50.00 |
| maxTime | `number` | 30m |
| checkpoint | `number` | 0 |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/coding.agency#L32))
