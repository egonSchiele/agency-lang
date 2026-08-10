---
name: "bluesky"
description: "Bluesky — keyword search, author feeds, and profiles"
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L50))

### Post

A Bluesky post. `createdAt` is epoch milliseconds (0 when the source
    timestamp was malformed). `url` is the human-facing bsky.app link,
    constructed from the post's at:// uri.

```ts
/** A Bluesky post. `createdAt` is epoch milliseconds (0 when the source
    timestamp was malformed). `url` is the human-facing bsky.app link,
    constructed from the post's at:// uri. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L44))

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

Search Bluesky posts by keyword. Returns matching posts with author, text,
  engagement counts, and a bsky.app link.

  @param query - The search keywords
  @param sort - Result ordering
  @param since - Only include posts created at or after this instant, as epoch milliseconds (0 means no time filter)
  @param limit - Maximum results (capped at 100)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| sort | [BskySort](#bskysort) | "latest" |
| since | `number` | 0 |
| limit | `number` | 25 |

**Returns:** `Result<Post[]>`

**Throws:** `std::bluesky`, `std::http::fetchJSON`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L251))

### bskyAuthorFeed

```ts
bskyAuthorFeed(
  handle: string,
  limit: number = 30,
): Result<Post[]> raises <std::bluesky, std::http::fetchJSON>
```

Fetch a Bluesky account's recent posts, newest first. Returns posts with
  text, engagement counts, and a bsky.app link.

  @param handle - The account's handle (like "user.bsky.social") or did
  @param limit - Maximum posts (capped at 100)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| handle | `string` |  |
| limit | `number` | 30 |

**Returns:** `Result<Post[]>`

**Throws:** `std::bluesky`, `std::http::fetchJSON`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L267))

### bskyProfile

```ts
bskyProfile(
  handle: string,
): Result<Profile> raises <std::bluesky, std::http::fetchJSON>
```

Fetch a Bluesky account's public profile: display name, description, and
  follower, follow, and post counts. An unknown handle returns a failure.

  @param handle - The account's handle (like "user.bsky.social") or did

**Parameters:**

| Name | Type | Default |
|---|---|---|
| handle | `string` |  |

**Returns:** `Result<Profile>`

**Throws:** `std::bluesky`, `std::http::fetchJSON`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/social/bluesky.agency#L281))
