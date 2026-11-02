---
name: "search"
description: "Selects one web-search provider from the configured API keys."
---

# search

Agents receive one client-side search tool: Brave when BRAVE_API_KEY is
  set, otherwise Tavily when TAVILY_API_KEY is set. With neither key set,
  they receive no client-side search tool. The catalog order sets the
  preference for all agents that use this helper.

## Functions

### searchTools

```ts
searchTools(): any[]
```

Return one web-search tool, preferring BRAVE_API_KEY over TAVILY_API_KEY.
  Return an empty array when neither key is set.

**Returns:** `any[]`

**Throws:** `std::env`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L59))

### searchProviderName

```ts
searchProviderName(toolName: string): string | null
```

Return a search tool's provider name from the catalog, or null for an
  unknown tool. This lookup does not read API keys or contact a provider.

  @param toolName - The name assigned to the search tool

**Parameters:**

| Name | Type | Default |
|---|---|---|
| toolName | `string` |  |

**Returns:** `string | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L67))

### hostedSearchTools

```ts
hostedSearchTools(model: string = "", provider: string = ""): string[]
```

Return the provider-hosted search capabilities available to a call on this
  model through this provider, or an empty array when that route offers none
  (the base "openai" client, local models). Pass the same model and provider
  the call will use: the answer depends on the route, not the model alone.

  @param model - The model that will run the call, or "" for the ambient default
  @param provider - The provider the call will route through, or "" for the ambient default

**Parameters:**

| Name | Type | Default |
|---|---|---|
| model | `string` | "" |
| provider | `string` | "" |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L81))

### searchProviderNames

```ts
searchProviderNames(): string[]
```

Return the selected web-search provider's name, preferring Brave over
  Tavily, or an empty array when neither API key is set.

**Returns:** `string[]`

**Throws:** `std::env`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L94))
