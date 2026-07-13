---
name: "agency"
---

# agency

Agency-coding agent: writes an Agency program for a task, runs it, and
  verifies the program's actual result satisfies the task. Built on
  writeAgency + runCode. Composable — call it directly or from another agent.

## Types

## Functions

### agencyCodingAgent

```ts
agencyCodingAgent(
  task: string,
  context: string = "",
  maxCost: number = $50.00,
  maxTime: number = 10m,
): Result<string, WriteFailure>
```

Writes an Agency program for the task, runs it, and verifies its result
  satisfies the task. Returns source that compiles, typechecks, and passes
  verification.

  @param task - What the generated program should do.
  @param context - Optional extra material.
  @param maxCost - Hard spend cap for the whole run (default $50).
  @param maxTime - Hard wall-clock cap for the whole run (default 10 minutes).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| maxCost | `number` | $50.00 |
| maxTime | `number` | 10m |

**Returns:** `Result<string, WriteFailure>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency.agency#L63))
