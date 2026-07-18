---
name: "research"
description: "Research agent: gathers from web and Wikipedia sources and synthesizes a cited, grounded answer."
---

# research

Research agent: gathers from web and Wikipedia sources and synthesizes a
  cited, grounded answer.

## Functions

### researchAgent

```ts
researchAgent(
  task: string,
  context: string = "",
  maxAttempts: number = 2,
  maxCost: number = $50.00,
  maxTime: number = 30m,
): string
```

Research agent: gathers from web and Wikipedia sources and synthesizes a
  cited answer, checked for grounding and completeness.

  @param task - The research question.
  @param context - Optional extra material.
  @param maxAttempts - Max answer-and-fix attempts before returning (default 2).
  @param maxCost - Hard spend cap for the whole run (default $50).
  @param maxTime - Hard wall-clock cap for the whole run (default 30 minutes).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| maxAttempts | `number` | 2 |
| maxCost | `number` | $50.00 |
| maxTime | `number` | 30m |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/research.agency#L30))
