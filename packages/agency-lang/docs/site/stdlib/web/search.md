---
name: "search"
description: "Search the web from Agency code, backed by the Brave Search API (https://brave.com/search/api/). Use `tavilySearch` for AI-optimized results."
---

# search

Search the web from Agency code, backed by the Brave Search API
  (https://brave.com/search/api/). Use `tavilySearch` for AI-optimized results.

  ```ts
  import { search } from "std::web/search"

  node main() {
    const results = search("agency language programming")
    print(results)
  }
  ```

## Types

## Effects

### std::search

```ts
effect std::search {
  query: string;
  count: number;
  country: string;
  searchLang: string;
  safesearch: string;
  freshness: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/search.agency#L23))

### std::tavilySearch

```ts
effect std::tavilySearch {
  query: string;
  count: number;
  searchDepth: string;
  topic: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/search.agency#L24))

## Functions

### search

```ts
search(
  query: string,
  count: number = 5,
  apiKey: string = "",
  country: string = "",
  searchLang: string = "",
  safesearch: string = "",
  freshness: string = "",
): SearchResult[]
```

Search the web. Returns a list of results with title, url, and description.

  @param query - The search query
  @param count - Number of results to return
  @param apiKey - Brave Search API key (defaults to the BRAVE_API_KEY env var)
  @param country - Two-letter country code to localize results (e.g. "US")
  @param searchLang - Language code for results (e.g. "en")
  @param safesearch - Safe search level: "off", "moderate", or "strict"
  @param freshness - Time filter: "pd" (past day), "pw" (past week), "pm" (past month), "py" (past year)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| count | `number` | 5 |
| apiKey | `string` | "" |
| country | `string` | "" |
| searchLang | `string` | "" |
| safesearch | `string` | "" |
| freshness | `string` | "" |

**Returns:** `SearchResult[]`

**Throws:** `std::search`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/search.agency#L26))

### tavilySearch

```ts
tavilySearch(
  query: string,
  count: number = 5,
  apiKey: string = "",
  searchDepth: string = "",
  topic: string = "",
): SearchResult[]
```

Search the web with Tavily, a search API built for AI agents. Returns a list of results with title, url, and description.

  @param query - The search query
  @param count - Number of results to return
  @param apiKey - Tavily API key (defaults to the TAVILY_API_KEY env var)
  @param searchDepth - "basic" for fast results or "advanced" for deeper retrieval
  @param topic - "general" or "news"

Get a free Tavily key (no credit card) at https://tavily.com.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| count | `number` | 5 |
| apiKey | `string` | "" |
| searchDepth | `string` | "" |
| topic | `string` | "" |

**Returns:** `SearchResult[]`

**Throws:** `std::tavilySearch`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/search.agency#L70))
