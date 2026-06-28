---
name: "search"
---

# search

## Types

## Functions

### search

```ts
search(query: string, count: number, apiKey: string, country: string, searchLang: string, safesearch: string, freshness: string): SearchResult[]
```

Search the web. Returns a list of results with title, url, and description. Set BRAVE_API_KEY env var or pass apiKey directly. Backed by the Brave Search API (https://brave.com/search/api/).

  @param query - The search query
  @param count - Number of results to return (default 5)
  @param apiKey - Brave Search API key (defaults to BRAVE_API_KEY env var)
  @param country - Two-letter country code to localize results (e.g. "US")
  @param searchLang - Language code for results (e.g. "en")
  @param safesearch - Safe search level ("off", "moderate", "strict")
  @param freshness - Time-based filter ("pd" past day, "pw" past week, "pm" past month, "py" past year)

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/search.agency#L18))

### tavilySearch

```ts
tavilySearch(query: string, count: number, apiKey: string, searchDepth: string, topic: string): SearchResult[]
```

Search the web with Tavily, a search API built for AI agents. Returns a list of results with title, url, and description. Set TAVILY_API_KEY env var or pass apiKey directly. A free key (no credit card) is available at https://tavily.com.

  @param query - The search query
  @param count - Number of results to return (default 5)
  @param apiKey - Tavily API key (defaults to TAVILY_API_KEY env var)
  @param searchDepth - Depth of the search ("basic" for fast results, "advanced" for deeper retrieval)
  @param topic - Category of the search ("general" or "news")

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| count | `number` | 5 |
| apiKey | `string` | "" |
| searchDepth | `string` | "" |
| topic | `string` | "" |

**Returns:** `SearchResult[]`

**Throws:** `std::search`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/search.agency#L59))
