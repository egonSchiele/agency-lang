---
name: "hackernews"
description: "Read Hacker News stories, items, profiles, and search results."
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

A Hacker News story from a list or search, with `time` in Unix seconds.

```ts
/** A Hacker News story from a list or search, with `time` in Unix seconds. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L47))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L59))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L74))

## Effects

### std::hackernews

```ts
effect std::hackernews {
  op: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L31))

## Functions

### hnStories

```ts
hnStories(
  list: string = "top",
  limit: number = 30,
): Result<Story[]> raises <std::hackernews, std::http::fetchJSON>
```

Read stories from a ranked Hacker News list.

This requests the ranked ID list and then one item per requested story.
  Use a small limit to reduce requests. Items whose fetch fails are skipped.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| list | `string` | "top" | Use "top", "new", "best", "ask", "show", or "job". |
| limit | `number` | 30 | The maximum stories to fetch, clamped to the range zero through 100. |

**Returns:** `Result<Story[]>`

**Throws:** `std::hackernews`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L259))

### hnItem

```ts
hnItem(id: number): Result<Item> raises <std::hackernews, std::http::fetchJSON>
```

Read a Hacker News story, comment, job, or poll, including its child IDs.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| id | `number` |  | A Hacker News item ID from a story listing, search, or parent item. |

**Returns:** `Result<Item>`

**Throws:** `std::hackernews`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L277))

### hnUser

```ts
hnUser(
  username: string,
): Result<User> raises <std::hackernews, std::http::fetchJSON>
```

Read a Hacker News user's public profile and submitted item IDs.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| username | `string` |  | The case-sensitive Hacker News username. |

**Returns:** `Result<User>`

**Throws:** `std::hackernews`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L289))

### hnSearch

```ts
hnSearch(
  query: string,
  sort: string = "relevance",
  tags: string = "story",
  limit: number = 20,
): Result<Story[]> raises <std::hackernews, std::http::fetchJSON>
```

Search Hacker News through its Algolia index.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| query | `string` |  |  |
| sort | `string` | "relevance" | Order results by "relevance" or "recent". |
| tags | `string` | "story" | Algolia tag filters, such as "story", "comment", "ask_hn", or "show_hn". |
| limit | `number` | 20 | The maximum results, clamped to the range zero through 50. |

**Returns:** `Result<Story[]>`

**Throws:** `std::hackernews`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/hackernews.agency#L301))
