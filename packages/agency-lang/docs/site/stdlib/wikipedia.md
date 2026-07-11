---
name: "wikipedia"
---

# wikipedia

Search Wikipedia and read article summaries or full text from Agency code.

  ```ts
  import { search, summary } from "std::wikipedia"

  node main() {
    const results = search("Ada Lovelace")
    const intro = summary(results[0].title)
    print(intro.extract)
  }
  ```

## Types

## Effects

### std::wikipedia::search

```ts
effect std::wikipedia::search {
  query: string;
  limit: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L36))

### std::wikipedia::summary

```ts
effect std::wikipedia::summary {
  title: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L37))

### std::wikipedia::article

```ts
effect std::wikipedia::article {
  title: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L38))

## Functions

### search

```ts
search(query: string, limit: number = 5): WikiSearchResult[]
```

Search Wikipedia for articles matching a query. Each result has a title, description, and excerpt.

  @param query - The search query
  @param limit - Maximum number of results to return

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| limit | `number` | 5 |

**Returns:** `WikiSearchResult[]`

**Throws:** `std::wikipedia::search`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L40))

### summary

```ts
summary(title: string): WikiSummary
```

Get a summary of a Wikipedia article. Returns the title, description, intro extract, and URL.

  @param title - The article title

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

**Returns:** [WikiSummary](#wikisummary)

**Throws:** `std::wikipedia::summary`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L55))

### article

```ts
article(title: string): WikiArticle
```

Get the full text of a Wikipedia article. Returns the title, plain-text content, and URL.

  @param title - The article title

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

**Returns:** [WikiArticle](#wikiarticle)

**Throws:** `std::wikipedia::article`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L68))
