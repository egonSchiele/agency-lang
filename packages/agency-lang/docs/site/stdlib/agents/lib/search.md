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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L44))

### hostedSearchTools

```ts
hostedSearchTools(model: string = ""): string[]
```

Return the provider-hosted search capabilities to request.

  @param model - The model that will run the call, or "" for the branch default

**Parameters:**

| Name | Type | Default |
|---|---|---|
| model | `string` | "" |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L68))

### searchProviderNames

```ts
searchProviderNames(): string[]
```

Return the names of the web-search providers whose API key is set, for
  telling a user which search is active.

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L92))
