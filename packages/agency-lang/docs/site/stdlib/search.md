# search

## Types

### SearchResult

```ts
type SearchResult = {
  title: string;
  url: string;
  description: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/search.agency#L3))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/search.agency#L18))
