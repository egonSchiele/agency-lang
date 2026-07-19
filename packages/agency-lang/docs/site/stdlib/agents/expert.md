---
name: "expert"
description: "Consults a domain expert for a task: returns the rules and"
---

# expert

acceptance checklist a solver needs to get the task right.

  A weak model often fails a task because it is missing a domain convention,
  not because it cannot reason. This agent returns that missing expertise as
  ExpertGuidance. It only consults; to solve with the guidance, compose:

    const guidance = guidanceOrEmpty(expertAgent(task))
    codingAgent(task, context: renderGuidance(guidance))
    verifierAgent(task, criteria: guidance.checklist)

  For tasks about the Agency language itself, use agencyExpertAgent, which
  grounds its guidance in the bundled docs instead of the web.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the expert's tools: the web and encyclopedia lookups it uses to
  confirm domain specifics.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L25))

### expertAgent

```ts
expertAgent(
  task: string,
  context: string = "",
  maxCost: number = $10.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
): Result<ExpertGuidance>
```

Consult a domain expert: identify the task's technical domain and return
  the rules and acceptance checklist a solver needs to get it right.

  @param task - The task to advise on
  @param context - Extra material, or ""
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
| maxCost | `number` | $10.00 |
| maxTime | `number` | 10m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |

**Returns:** `Result<ExpertGuidance>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L66))
