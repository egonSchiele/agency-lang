---
name: "search"
description: "Finds which web-search providers are usable right now and returns"
---

# search

their tools.

  Client-side web search needs an API key, and which providers a user has
  keys for varies. Agents ask for whatever is available instead of hardcoding
  one provider, so an agent still runs with no keys at all, just without web
  search. Adding a provider means appending one entry to the catalog here,
  and every agent picks it up.

## Types

## Functions

### searchTools

```ts
searchTools(): any[]
```

Return the web-search tools whose API key is set, or an empty array when
  no search provider is configured.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L52))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L61))

### searchProviderNames

```ts
searchProviderNames(): string[]
```

Return the names of the web-search providers whose API key is set, for
  telling a user which search is active.

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L74))
