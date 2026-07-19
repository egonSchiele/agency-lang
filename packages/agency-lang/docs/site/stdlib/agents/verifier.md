---
name: "verifier"
description: "Verifies completed work on disk against a task: derives measurable"
---

# verifier

criteria and computes each one with tools.

  The verifier runs; review reads. To judge a work product handed to you as
  text without touching the file system, use reviewAgent instead.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the verifier's tools. It measures with shell pipelines and reads
  bytes, because a criterion checked by eye is a criterion not checked. It
  has no write tools: a verifier that can fix things is no longer a verifier.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/verifier.agency#L23))

### verifierAgent

```ts
verifierAgent(
  task: string,
  criteria: string[] = [],
  context: string = "",
  maxCost: number = $20.00,
  maxTime: number = 15m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
): Result<Feedback[]>
```

Verify work on disk against a task: derive measurable success criteria,
  compute each one with tools, and return one pass/fail finding per
  criterion.

  @param task - The task the work must satisfy
  @param criteria - Known acceptance criteria to check, extended with derived ones
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
| task | `string` |  |
| criteria | `string[]` | [] |
| context | `string` | "" |
| maxCost | `number` | $20.00 |
| maxTime | `number` | 15m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/verifier.agency#L48))
