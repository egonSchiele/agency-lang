---
name: "search"
description: "Select client-side and provider-hosted search tools for agents."
---

# search

`searchTools` selects Brave when `BRAVE_API_KEY` is available, then Tavily
when `TAVILY_API_KEY` is available, or no client-side tool without a key.
`hostedSearchTools` selects hosted search for the model and provider route
used by an LLM call. Both can be offered together.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L55))

### searchProviderName

```ts
searchProviderName(toolName: string): string | null
```

Return the catalog provider name for a search tool, or null when its name is unknown.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| toolName | `string` |  |

**Returns:** `string | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L63))

### hostedSearchTools

```ts
hostedSearchTools(model: string = "", provider: string = ""): string[]
```

Select provider-hosted search for an LLM call's model and provider route.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| model | `string` | "" | Use the same model as the call, or "" for the ambient model. |
| provider | `string` | "" | Use the same provider as the call, or "" for automatic resolution. |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L74))

### searchProviderNames

```ts
searchProviderNames(): string[]
```

Return the selected web-search provider's name, preferring Brave over
  Tavily, or an empty array when neither API key is set.

**Returns:** `string[]`

**Throws:** `std::env`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L84))
