---
name: "search"
description: "Search the web with Brave or Tavily."
---

# search

Search the web from Agency code, backed by the Brave Search API
  (https://brave.com/search/api/), or use Tavily as an alternative. Configure
  `BRAVE_API_KEY` or `TAVILY_API_KEY` for the provider you use.

  ```ts
  import { search } from "std::web/search"

  node main() {
    const results = search("agency language programming")
    print(results)
  }
  ```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/search.agency#L25))

### std::tavilySearch

```ts
effect std::tavilySearch {
  query: string;
  count: number;
  searchDepth: string;
  topic: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/search.agency#L26))

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

Search the web with Brave.

  @param apiKey - Leave empty to use BRAVE_API_KEY.
  @param country - A two-letter country code to localize results, such as "US".
  @param searchLang - A result language code, such as "en".
  @param safesearch - Use "off", "moderate", or "strict", or empty for the provider default.
  @param freshness - Use "pd", "pw", "pm", or "py" for the past day, week, month, or year.

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

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/search.agency#L29))

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

Search the web with Tavily and return source links with extracted snippets.

  @param apiKey - Leave empty to use TAVILY_API_KEY.
  @param searchDepth - Use "basic" for faster retrieval or "advanced" for deeper retrieval.
  @param topic - Search "general" web content or "news".

Configure a Tavily API key at https://tavily.com before using this provider.

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

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/search.agency#L70))
