---
name: "gdelt"
description: "Search recent worldwide news coverage with GDELT."
---

# gdelt

## GDELT — worldwide news coverage

  Search global online news via the [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/).
  Find recent articles about an event, company, or topic. Results include
  source links and publication metadata for checking the reporting.

  No API key required. GDELT asks callers to make at most one request every 5 seconds; on a
  zero-match query it returns no `articles` (this connector returns an empty list).

  ### Usage

  ```ts
  import { gdeltNews } from "std::data/news/gdelt"

  node main() {
    const articles = gdeltNews("Federal Reserve interest rate decision", 10, "1w") catch []
    for (article in articles) {
      print("${article.seenDate}  ${article.domain}  ${article.title}")
    }
  }
  ```

## Types

### NewsArticle

One news article returned by GDELT. `seenDate` is GDELT's `YYYYMMDDTHHMMSSZ` string.

```ts
/** One news article returned by GDELT. `seenDate` is GDELT's `YYYYMMDDTHHMMSSZ` string. */
export type NewsArticle = {
  title: string;
  url: string;
  domain: string;
  language: string;
  sourceCountry: string;
  seenDate: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/news/gdelt.agency#L31))

## Effects

### std::gdelt

```ts
effect std::gdelt {
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/news/gdelt.agency#L28))

## Functions

### gdeltNews

```ts
gdeltNews(
  query: string,
  maxRecords: number = 25,
  timespan: string = "3d",
): Result<NewsArticle[]> raises <std::gdelt, std::http::fetchJSON>
```

Search recent worldwide news coverage with GDELT. Allow five seconds
  between requests.

  @param query - GDELT DOC search syntax, such as "Federal Reserve rate cut".
  @param maxRecords - Request from 1 through 250 articles.
  @param timespan - How far back to search, such as "24h", "3d", or "1w".

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| maxRecords | `number` | 25 |
| timespan | `string` | "3d" |

**Returns:** `Result<NewsArticle[]>`

**Throws:** `std::gdelt`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/news/gdelt.agency#L77))
