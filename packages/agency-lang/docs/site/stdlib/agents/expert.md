---
name: "expert"
description: "Get domain rules and acceptance criteria before solving a task."
---

# expert

`expertAgent` returns `ExpertGuidance` for a solver or verifier to use.
`guidanceOrEmpty` lets a caller continue if the consultation fails.
For Agency-language guidance, use `agencyExpertAgent`.

```ts
import { expertAgent } from "std::agents/expert"
import { guidanceOrEmpty, renderGuidance } from "std::agents/lib/expertGuidance"

node main() {
  const guidance = guidanceOrEmpty(expertAgent("Validate a FASTA file"))
  print(renderGuidance(guidance))
}
```

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the expert agent's web lookup and saved-output tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L29))

### expertAgent

```ts
@guarded(cost: maxCost, time: maxTime)
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
  @param maxCost - Cost budget in USD.
  @param maxTime - Time budget in milliseconds.
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override, ignored when model is empty.
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

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L73))
