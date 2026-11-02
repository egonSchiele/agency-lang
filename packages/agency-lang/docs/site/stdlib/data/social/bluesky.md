---
name: "bluesky"
description: "Search Bluesky posts and read public feeds and profiles."
---

# bluesky

## Bluesky — keyword search, author feeds, and profiles

  Read [Bluesky](https://bsky.app) via its public AppView API. No API key or
  account is required. Use this connector to search posts by keyword
  (`bskySearch`), read an account's recent posts (`bskyAuthorFeed`), or look
  up a profile (`bskyProfile`).

  Every post comes back with a `url` field holding its human-facing bsky.app
  link, so results can go straight into an email or report. Post timestamps
  are epoch milliseconds, so they compare directly against `now()` from
  `std::date`.

  ### Usage

  ```ts
  import { bskySearch, bskyAuthorFeed } from "std::data/social/bluesky"
  import { now } from "std::date"

  node main() {
    // Posts mentioning a topic in the last day.
    const recent = bskySearch("agency lang", since: now() - 1d) catch []
    for (p in recent) {
      print("${p.author}: ${p.text}")
      print("  ${p.url}")
    }
  }
  ```

  ### Shaping the tools for an agent

  Like any Agency function, these verbs can be narrowed with partial
  application before handing them to an LLM:

  ```ts
  const searchRecent = bskySearch.partial(sort: "latest", limit: 10)
  const news = llm("what are people saying about agency-lang?", tools: [searchRecent])
  ```

## Types

### BskySort

Result ordering for `bskySearch`.

```ts
/** Result ordering for `bskySearch`. */
export type BskySort = "latest" | "top"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L51))

### Post

A Bluesky post with a browser link and epoch-millisecond `createdAt`.
    A malformed source timestamp becomes zero.

```ts
/** A Bluesky post with a browser link and epoch-millisecond `createdAt`.
    A malformed source timestamp becomes zero. */
export type Post = {
  uri: string;
  url: string;
  author: string;
  authorName: string;
  text: string;
  createdAt: number;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  quoteCount: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L55))

### Profile

A Bluesky account profile.

```ts
/** A Bluesky account profile. */
export type Profile = {
  did: string;
  handle: string;
  displayName: string;
  description: string;
  followersCount: number;
  followsCount: number;
  postsCount: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L69))

## Effects

### std::bluesky

```ts
effect std::bluesky {
  op: string;
  query: string;
  since: number;
  limit: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L45))

## Functions

### bskySearch

```ts
bskySearch(
  query: string,
  sort: BskySort = "latest",
  since: number = 0,
  limit: number = 25,
): Result<Post[]> raises <std::bluesky, std::http::fetchJSON>
```

Search public Bluesky posts by keyword.

  @param since - Include posts at or after this epoch-millisecond timestamp, or zero for no time filter.
  @param limit - The maximum results, clamped to the range zero through 100.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| sort | [BskySort](#bskysort) | "latest" |
| since | `number` | 0 |
| limit | `number` | 25 |

**Returns:** `Result<Post[]>`

**Throws:** `std::bluesky`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L248))

### bskyAuthorFeed

```ts
bskyAuthorFeed(
  handle: string,
  limit: number = 30,
): Result<Post[]> raises <std::bluesky, std::http::fetchJSON>
```

Read a Bluesky account’s recent posts, newest first.

  @param handle - An account handle such as "user.bsky.social", or a DID.
  @param limit - The maximum posts, clamped to the range zero through 100.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| handle | `string` |  |
| limit | `number` | 30 |

**Returns:** `Result<Post[]>`

**Throws:** `std::bluesky`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L262))

### bskyProfile

```ts
bskyProfile(
  handle: string,
): Result<Profile> raises <std::bluesky, std::http::fetchJSON>
```

Read a Bluesky account’s public profile and follower counts.

  @param handle - An account handle such as "user.bsky.social", or a DID.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| handle | `string` |  |

**Returns:** `Result<Profile>`

**Throws:** `std::bluesky`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L276))
