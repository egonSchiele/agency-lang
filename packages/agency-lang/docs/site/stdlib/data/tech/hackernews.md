---
name: "hackernews"
---

# hackernews

## Hacker News — front page, items, users, and search

  Read [Hacker News](https://github.com/HackerNews/API) via its official Firebase API (ranked story
  lists, items, and user profiles) and its [Algolia search](https://hn.algolia.com/api) index
  (keyword full-text search). Use this connector to see what the tech community is discussing right
  now (`hnStories`) or to find HN threads about a topic (`hnSearch`).

  No API key required. `hnStories` fetches a list of item IDs and then one request per item to
  hydrate it, so a large `limit` means many requests (it is capped at 100).

  ### Usage

  ```ts
  import { hnStories, hnSearch } from "std::data/tech/hackernews"

  node main() {
    const front = hnStories("top", 10) catch []
    for (s in front) {
      print("${s.score}  ${s.title}  (${s.by})")
    }
    const hits = hnSearch("rust async", "recent") catch []
    for (h in hits) { print(h.title) }
  }
  ```

## Types

### Story

A Hacker News story (the hydrated list / search shape). `time` is a Unix timestamp.

```ts
/** A Hacker News story (the hydrated list / search shape). `time` is a Unix timestamp. */
export type Story = {
  id: number;
  title: string;
  url: string;
  by: string;
  score: number;
  time: number;
  descendants: number;
  type: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L46))

### Item

A full Hacker News item — story, comment, job, or poll. `kids` are direct child comment ids.

```ts
/** A full Hacker News item — story, comment, job, or poll. `kids` are direct child comment ids. */
export type Item = {
  id: number;
  type: string;
  by: string;
  time: number;
  title: string;
  url: string;
  text: string;
  score: number;
  descendants: number;
  parent?: number;
  kids: number[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L58))

### User

A Hacker News user profile. `submitted` are the ids of items the user posted.

```ts
/** A Hacker News user profile. `submitted` are the ids of items the user posted. */
export type User = {
  id: string;
  created: number;
  karma: number;
  about: string;
  submitted: number[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L73))

## Effects

### std::hackernews

```ts
effect std::hackernews {
  op: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L30))

## Functions

### hnStories

```ts
hnStories(
  list: string = "top",
  limit: number = 30,
): Result<Story[]> raises <std::hackernews, std::http::fetchJSON>
```

Fetch a Hacker News story list and hydrate the top items into full stories (title, url, author,
  score, comment count). Fetches the id list plus one request per item, so a large limit means many
  requests (capped at 100).

  @param list - Which ranked list to read: "top", "new", "best", "ask", "show", or "job"
  @param limit - How many stories to hydrate (capped at 100)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| list | `string` | "top" |
| limit | `number` | 30 |

**Returns:** `Result<Story[]>`

**Throws:** `std::hackernews`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L283))

### hnItem

```ts
hnItem(id: number): Result<Item> raises <std::hackernews, std::http::fetchJSON>
```

Fetch one Hacker News item by id — a story, comment, job, or poll. Returns its text, author,
  score, and the ids of its direct child comments. An unknown id returns a failure.

  @param id - The Hacker News item id

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |

**Returns:** `Result<Item>`

**Throws:** `std::hackernews`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L302))

### hnUser

```ts
hnUser(
  username: string,
): Result<User> raises <std::hackernews, std::http::fetchJSON>
```

Fetch a Hacker News user's public profile: karma, account age, about text, and submitted item
  ids. An unknown username returns a failure.

  @param username - The Hacker News username (case-sensitive)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| username | `string` |  |

**Returns:** `Result<User>`

**Throws:** `std::hackernews`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L314))

### hnSearch

```ts
hnSearch(
  query: string,
  sort: string = "relevance",
  tags: string = "story",
  limit: number = 20,
): Result<Story[]> raises <std::hackernews, std::http::fetchJSON>
```

Search Hacker News stories by keyword via the Algolia index. Returns matching stories (title,
  url, author, score, comment count), sorted by relevance or recency.

  @param query - The search keywords
  @param sort - Result ordering: "relevance" or "recent"
  @param tags - Algolia tag filter, e.g. "story", "comment", "ask_hn", "show_hn"
  @param limit - Maximum results (capped at 50)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| sort | `string` | "relevance" |
| tags | `string` | "story" |
| limit | `number` | 20 |

**Returns:** `Result<Story[]>`

**Throws:** `std::hackernews`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L326))
