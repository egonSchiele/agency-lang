---
name: "gdelt"
description: "GDELT — worldwide news coverage"
---

# gdelt

## GDELT — worldwide news coverage

  Search global online news via the [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/).
  Use this connector for the *qualitative, fast-moving* signal — what the world is reporting
  right now about an event, company, or topic. It returns recent matching articles (title,
  URL, source domain, language, source country, and GDELT's seen-date). It tells you what is
  being *said*, not what is *true* — for authoritative company facts use
  `std::data/finance/edgar`; for economic numbers use `std::data/finance/fred` or
  `std::data/finance/dbnomics`.

  No API key required. GDELT asks callers to make at most one request every 5 seconds; on a
  zero-match query it returns no `articles` (this connector returns an empty list).

  ### Usage

  ```ts
  import { gdeltNews } from "std::data/finance/gdelt"

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/gdelt.agency#L34))

## Effects

### std::gdelt

```ts
effect std::gdelt {
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/gdelt.agency#L31))

## Functions

### gdeltNews

```ts
gdeltNews(
  query: string,
  maxRecords: number = 25,
  timespan: string = "3d",
): Result<NewsArticle[]> raises <std::gdelt, std::http::fetchJSON>
```

Search worldwide online news coverage for a query via GDELT DOC 2.0. Returns recent
  matching articles (title, URL, source domain, language, source country, and the GDELT
  seen-date); a zero-match query returns an empty list. Use for current events, public
  attention, and sentiment. Note: GDELT is rate-limited to about one request every 5 seconds.

  @param query - Search terms in GDELT DOC query syntax, e.g. "Federal Reserve rate cut"
  @param maxRecords - Maximum number of articles to return, 1-250 (default 25)
  @param timespan - How far back to search, e.g. "24h", "3d", "1w" (default "3d")

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| maxRecords | `number` | 25 |
| timespan | `string` | "3d" |

**Returns:** `Result<NewsArticle[]>`

**Throws:** `std::gdelt`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/gdelt.agency#L82))
