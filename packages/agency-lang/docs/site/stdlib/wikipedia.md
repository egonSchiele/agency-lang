---
name: "wikipedia"
---

# wikipedia

## Types

## Effects

### std::wikipedia::search

```ts
effect std::wikipedia::search {
  query: string;
  limit: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L22))

### std::wikipedia::summary

```ts
effect std::wikipedia::summary {
  title: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L23))

### std::wikipedia::article

```ts
effect std::wikipedia::article {
  title: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L24))

## Functions

### search

```ts
search(query: string, limit: number): WikiSearchResult[]
```

Search Wikipedia for articles matching the given query. Returns up to limit results (default 5).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| limit | `number` | 5 |

**Returns:** `WikiSearchResult[]`

**Throws:** `std::wikipedia::search`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L26))

### summary

```ts
summary(title: string): WikiSummary
```

Get a summary of a Wikipedia article by its title. Returns the title, description, intro extract, and URL.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

**Returns:** [WikiSummary](#wikisummary)

**Throws:** `std::wikipedia::summary`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L38))

### article

```ts
article(title: string): WikiArticle
```

Get the full text of a Wikipedia article by its title. Returns the title, full plain text content, and URL.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

**Returns:** [WikiArticle](#wikiarticle)

**Throws:** `std::wikipedia::article`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/wikipedia.agency#L49))
