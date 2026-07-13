---
name: "agency"
---

# agency

Agency-coding agent: writes an Agency program for a task, runs it, and
  verifies the program's actual result satisfies the task. Built on
  writeAgency and runCode.

## Types

## Functions

### agencyCodingAgent

```ts
agencyCodingAgent(
  task: string,
  context: string = "",
  maxAttempts: number = 3,
  maxCost: number = $50.00,
  maxTime: number = 30m,
): Result<string, WriteFailure>
```

Writes an Agency program for the task, runs it, and judges its result against
  the task. On success returns source that compiles, typechecks, and passed the
  result check. If the result check keeps failing within maxAttempts (or the
  cost/time budget trips), returns the last attempt as a best effort.

  @param task - What the generated program should do.
  @param context - Optional extra material.
  @param maxAttempts - Max generation attempts before giving up (default 3).
  @param maxCost - Hard spend cap for the whole run (default $50).
  @param maxTime - Hard wall-clock cap for the whole run (default 30 minutes).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| maxAttempts | `number` | 3 |
| maxCost | `number` | $50.00 |
| maxTime | `number` | 30m |

**Returns:** `Result<string, WriteFailure>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency.agency#L53))
