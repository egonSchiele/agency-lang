---
name: "expert"
description: "Consults an Agency-language specialist for a task: returns the"
---

# expert

syntax rules and acceptance checklist a solver needs, grounded in the
  bundled docs.

  It only consults; to solve with the guidance, compose:

    const guidance = guidanceOrEmpty(agencyExpertAgent(task))
    agencyCodingAgent(task, context: renderGuidance(guidance))

  For any other technical domain, use expertAgent, which consults the web
  instead of the bundled docs.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the Agency expert's tools: the bundled language documentation and
  the source inspectors it cites in its guidance.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/expert.agency#L22))

### agencyExpertAgent

```ts
agencyExpertAgent(
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

Consult an Agency-language specialist: return the syntax rules and
  acceptance checklist a solver needs, grounded in the bundled docs.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/expert.agency#L57))
