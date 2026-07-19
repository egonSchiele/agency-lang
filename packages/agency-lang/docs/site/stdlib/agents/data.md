---
name: "data"
description: "Answers a question using the structured public-data APIs in the"
---

# data

standard library: economic series, securities filings, federal spending,
  news, and entity databases.

  This agent works structured sources with exact identifiers. For unstructured
  web pages and encyclopedia prose, use researcherAgent instead. Querying
  these APIs usually means finding an identifier first, such as a FRED series
  ID or an EDGAR CIK, so the agent carries search and fetch tools too.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the data agent's tools: every connector, plus the search and fetch
  tools it needs to find an identifier before querying.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/data.agency#L42))

### dataAgent

```ts
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

  @param task - The question to answer
  @param context - Extra material folded into the prompt, or ""
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
| maxCost | `number` | $20.00 |
| maxTime | `number` | 15m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/data.agency#L99))
