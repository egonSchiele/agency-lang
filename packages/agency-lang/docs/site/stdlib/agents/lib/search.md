---
name: "search"
description: "Select client-side and provider-hosted search tools for agents."
---

# search

`searchTools` selects Brave when `BRAVE_API_KEY` is available, then Tavily
when `TAVILY_API_KEY` is available, or no client-side tool without a key.
`hostedSearchTools` selects hosted search for the model and provider route
used by an LLM call. Both can be offered together.

`setSearchMode` narrows both for the rest of the run. Every agent in
`std::agents` takes its search tools from these two functions, so one call
changes how all of them search:

```ts
import { setSearchMode } from "std::agents/lib/search"

node main() {
  setSearchMode("off")
}
```

## Types

### SearchMode

How the agents in this run search the web. `auto` offers a client tool
when a key is set and hosted search when the model's provider has it.
`hosted`, `brave`, and `tavily` offer that one alone. `off` offers none.

```ts
/** How the agents in this run search the web. `auto` offers a client tool
when a key is set and hosted search when the model's provider has it.
`hosted`, `brave`, and `tavily` offer that one alone. `off` offers none. */
export type SearchMode = "auto" | "hosted" | "brave" | "tavily" | "off"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L29))

## Functions

### setSearchMode

```ts
setSearchMode(mode: SearchMode)
```

Choose how agents search the web for the rest of this run.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| mode | [SearchMode](#searchmode) |  | "auto" for a client tool and hosted search where each is available, "hosted", "brave", or "tavily" for that one alone, or "off" for none. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L33))

### searchMode

```ts
searchMode(): SearchMode
```

Return the search mode set with `setSearchMode`, or "auto".

**Returns:** [SearchMode](#searchmode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L42))

### searchTools

```ts
searchTools(): any[]
```

Return one web-search tool, preferring BRAVE_API_KEY over TAVILY_API_KEY.
  Return an empty array when neither key is set, or when the search mode
  set with `setSearchMode` is "hosted", "off", or a provider with no key.

**Returns:** `any[]`

**Throws:** `std::env`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L101))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L110))

### hostedSearchTools

```ts
hostedSearchTools(model: string = "", provider: string = ""): string[]
```

Select provider-hosted search for an LLM call's model and provider route.
  Return an empty array when the model's provider has none, or when the
  search mode set with `setSearchMode` is "brave", "tavily", or "off".

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| model | `string` | "" | Use the same model as the call, or "" for the ambient model. |
| provider | `string` | "" | Use the same provider as the call, or "" for automatic resolution. |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L121))

### searchProviderNames

```ts
searchProviderNames(): string[]
```

Return the selected web-search provider's name, preferring Brave over
  Tavily, or an empty array when neither API key is set.

**Returns:** `string[]`

**Throws:** `std::env`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/search.agency#L136))
