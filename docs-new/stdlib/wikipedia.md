# wikipedia

[View source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/wikipedia.agency)

## Types

### WikiSearchResult [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/wikipedia.agency#L2)

```ts
type WikiSearchResult = {
  title: string;
  description: string;
  excerpt: string
}
```

### WikiSummary [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/wikipedia.agency#L8)

```ts
type WikiSummary = {
  title: string;
  description: string;
  extract: string;
  url: string
}
```

### WikiArticle [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/wikipedia.agency#L15)

```ts
type WikiArticle = {
  title: string;
  text: string;
  url: string
}
```

## Functions

### search [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/wikipedia.agency#L21)

```ts
search(query: string, limit: number): WikiSearchResult[]
```

Search Wikipedia for articles matching the given query. Returns up to limit results (default 5).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | string |  |
| limit | number | 5 |

**Returns:** WikiSearchResult[]

### summary [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/wikipedia.agency#L28)

```ts
summary(title: string): WikiSummary
```

Get a summary of a Wikipedia article by its title. Returns the title, description, intro extract, and URL.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | string |  |

**Returns:** [WikiSummary](#wikisummary)

### article [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/wikipedia.agency#L35)

```ts
article(title: string): WikiArticle
```

Get the full text of a Wikipedia article by its title. Returns the title, full plain text content, and URL.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | string |  |

**Returns:** [WikiArticle](#wikiarticle)
