---
name: "wikipedia"
description: "Search English Wikipedia and read article introductions or full text."
---

# wikipedia

Search English Wikipedia and read article summaries or full text.

  ```ts
  import { search, summary } from "std::wikipedia"

  node main() {
    const results = search("Ada Lovelace")
    if (results.length > 0) {
      const intro = summary(results[0].title)
      print(intro.extract)
    }
  }
  ```

## Effects

### std::wikipedia::search

```ts
effect std::wikipedia::search {
  query: string;
  limit: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L39))

### std::wikipedia::summary

```ts
effect std::wikipedia::summary {
  title: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L40))

### std::wikipedia::article

```ts
effect std::wikipedia::article {
  title: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L41))

## Functions

### search

```ts
search(query: string, limit: number = 5): WikiSearchResult[]
```

Find English Wikipedia articles matching a search query.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| limit | `number` | 5 |

**Returns:** `WikiSearchResult[]`

**Throws:** `std::wikipedia::search`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L44))

### summary

```ts
summary(title: string): WikiSummary
```

Read the introductory summary of a Wikipedia article.

  @param title - An article title returned by Wikipedia search.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

**Returns:** `WikiSummary`

**Throws:** `std::wikipedia::summary`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L57))

### article

```ts
article(title: string): WikiArticle
```

Read the full plain text of a Wikipedia article.

  @param title - An article title returned by Wikipedia search.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

**Returns:** `WikiArticle`

**Throws:** `std::wikipedia::article`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L71))
