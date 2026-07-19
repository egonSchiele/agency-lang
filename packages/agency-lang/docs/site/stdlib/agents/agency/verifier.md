---
name: "verifier"
description: "Runs an Agency program and judges its actual result against a task."
---

# verifier

The verifier runs; review reads. To check source text without executing it,
  use agencyReviewAgent instead.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the Agency verifier's tools. It reads and measures what the program
  left behind; it has no write tools, because a verifier that can fix things
  is no longer a verifier.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/verifier.agency#L24))

### agencyVerifierAgent

```ts
agencyVerifierAgent(
  source: string,
  task: string,
  context: string = "",
  maxCost: number = $20.00,
  maxTime: number = 15m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
): Result<Feedback[]>
```

Run an Agency program and judge its result against the task. A program that
  fails to run yields a single error finding rather than a failure, so callers
  can always read findings.

  @param source - The Agency program to run
  @param task - What the program's result must satisfy
  @param context - Extra material for the judgment, or ""
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| task | `string` |  |
| context | `string` | "" |
| maxCost | `number` | $20.00 |
| maxTime | `number` | 15m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/verifier.agency#L89))
