---
name: "research"
---

# research

Research agent: gathers from web/Wikipedia sources and synthesizes a cited,
  grounded answer. Composable — call it directly or from another agent.

## Functions

### researchAgent

```ts
researchAgent(
  task: string,
  context: string = "",
  maxCost: number = $50.00,
  maxTime: number = 10m,
): string
```

Research agent: gathers from web/Wikipedia sources and synthesizes a cited
  answer, checked for grounding and completeness.

  @param task - The research question.
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

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/research.agency#L25))
