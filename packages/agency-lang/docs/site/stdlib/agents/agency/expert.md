---
name: "expert"
description: "Get Agency syntax guidance and acceptance criteria from the bundled docs."
---

# expert

Use `agencyExpertAgent` before generating Agency source when a task needs
language-specific guidance. Pass `renderGuidance` output as the coding
agent's context, or give the checklist to a verifier. The shared helpers
are in `std::agents/lib/expertGuidance`.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the Agency expert's documentation and source-checking tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/expert.agency#L19))

### agencyExpertAgent

```ts
@guarded(cost: maxCost, time: maxTime)
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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  | The task to advise on |
| context | `string` | "" | Extra material, or "" |
| maxCost | `number` | $10.00 | Cost budget in USD. |
| maxTime | `number` | 10m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| session | `string` | "" | Session name to share a thread across calls, or "" for isolated |
| extraTools | `any[]` | [] | Extra tools to offer the LLM, appended to the built-in set |

**Returns:** `Result<ExpertGuidance>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/expert.agency#L54))
