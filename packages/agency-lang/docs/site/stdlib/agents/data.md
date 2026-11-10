---
name: "data"
description: "Answer questions using structured public-data APIs."
---

# data

Use `dataAgent` for economic series, securities filings, public spending,
news, and entity records. It can search for identifiers before querying an
API. Use `researcherAgent` for questions answered mainly by web pages.

```ts
import { dataAgent } from "std::agents/data"

node main() {
  print(dataAgent("Find the latest reported US unemployment rate and cite its series"))
}
```

The model reports progress in a sentence beside each tool call, and
nothing prints it by default. `std::agents/lib/toolkits` shows the
callback that does.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the data agent's connectors and source lookup tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/data.agency#L59))

### dataAgent

```ts
@guarded(cost: maxCost, time: maxTime)
dataAgent(
  task: string,
  context: string = "",
  maxCost: number = $20.00,
  maxTime: number = 15m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
): Result<string>
```

Answer a question from structured public-data APIs, naming the source and
  identifier behind every figure.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  | The question to answer |
| context | `string` | "" | Extra material folded into the prompt, or "" |
| maxCost | `number` | $20.00 | Cost budget in USD. |
| maxTime | `number` | 15m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| session | `string` | "" | Session name to share a thread across calls, or "" for isolated |
| extraTools | `any[]` | [] | Extra tools to offer the LLM, appended to the built-in set |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/data.agency#L120))
