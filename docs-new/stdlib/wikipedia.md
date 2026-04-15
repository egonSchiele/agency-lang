# wikipedia

## Types

### WikiSearchResult

```ts
type WikiSearchResult = {
  title: string;
  description: string;
  excerpt: string
}
```

### WikiSummary

```ts
type WikiSummary = {
  title: string;
  description: string;
  extract: string;
  url: string
}
```

### WikiArticle

```ts
type WikiArticle = {
  title: string;
  text: string;
  url: string
}
```

## Functions

### search

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

### summary

```ts
summary(title: string): WikiSummary
```

Get a summary of a Wikipedia article by its title. Returns the title, description, intro extract, and URL.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | string |  |

**Returns:** WikiSummary

### article

```ts
article(title: string): WikiArticle
```

Get the full text of a Wikipedia article by its title. Returns the title, full plain text content, and URL.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | string |  |

**Returns:** WikiArticle
