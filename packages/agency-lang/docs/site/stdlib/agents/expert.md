---
name: "expert"
description: "Get domain rules and acceptance criteria before solving a task."
---

# expert

Call `expertAgent` before solving a task in an unfamiliar domain. A model
often fails such a task because it does not know a convention of the
domain, such as the rules of a file format. `expertAgent` returns those
rules and an acceptance checklist as `ExpertGuidance`, for a solver or
verifier to use. `guidanceOrEmpty` lets a caller continue if the
consultation fails.
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L33))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L77))
