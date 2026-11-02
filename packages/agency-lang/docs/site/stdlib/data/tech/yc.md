---
name: "yc"
description: "Browse the Y Combinator company directory by batch, industry, or tag."
---

# yc

## Y Combinator — the YC company directory

  Query the [yc-oss](https://github.com/yc-oss/api) community dataset by
  batch, industry, tag, or curated list. Company profiles include their
  descriptions, funding batch, team size, and status.

  The data is static JSON refreshed daily, and there is no server-side search. Fetch a slice (a
  batch, industry, or tag) and filter in Agency. `ycMeta` lists the available slugs, so an agent
  can discover the newest batch before fetching it. No API key required.

  ### Usage

  ```ts
  import { ycBatch } from "std::data/tech/yc"

  node main() {
    const companies = ycBatch("Winter 2025") catch []
    for (c in companies) {
      print("${c.name} — ${c.oneLiner} [${c.status}]")
    }
  }
  ```

## Types

### Company

A YC company profile, with `launchedAt` in Unix seconds.

```ts
/** A YC company profile, with `launchedAt` in Unix seconds. */
export type Company = {
  id: number;
  name: string;
  slug: string;
  website: string;
  oneLiner: string;
  longDescription: string;
  batch: string;
  status: string;
  stage: string;
  teamSize: number;
  industry: string;
  subindustry: string;
  tags: string[];
  regions: string[];
  allLocations: string;
  launchedAt: number;
  topCompany: boolean;
  isHiring: boolean;
  nonprofit: boolean;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L39))

### YcMeta

The available slugs for discovery (from meta.json), so a caller can find the newest batch.

```ts
/** The available slugs for discovery (from meta.json), so a caller can find the newest batch. */
export type YcMeta = {
  lastUpdated: string;
  batches: string[];
  industries: string[];
  tags: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L63))

## Effects

### std::yc

```ts
effect std::yc {
  op: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L30))

## Functions

### ycBatch

```ts
ycBatch(batch: string): Result<Company[]> raises <std::yc, std::http::fetchJSON>
```

List YC companies in a funding batch.

  @param batch - A batch label or slug, such as "Winter 2025" or "winter-2025".

**Parameters:**

| Name | Type | Default |
|---|---|---|
| batch | `string` |  |

**Returns:** `Result<Company[]>`

**Throws:** `std::yc`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L179))

### ycIndustry

```ts
ycIndustry(
  industry: string,
): Result<Company[]> raises <std::yc, std::http::fetchJSON>
```

List YC companies in an industry.

  @param industry - An industry label or slug from the directory metadata, such as "fintech".

**Parameters:**

| Name | Type | Default |
|---|---|---|
| industry | `string` |  |

**Returns:** `Result<Company[]>`

**Throws:** `std::yc`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L191))

### ycTag

```ts
ycTag(tag: string): Result<Company[]> raises <std::yc, std::http::fetchJSON>
```

List YC companies carrying a directory tag.

  @param tag - A tag label or slug from the directory metadata, such as "SaaS".

**Parameters:**

| Name | Type | Default |
|---|---|---|
| tag | `string` |  |

**Returns:** `Result<Company[]>`

**Throws:** `std::yc`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L203))

### ycList

```ts
ycList(
  list: string = "top",
): Result<Company[]> raises <std::yc, std::http::fetchJSON>
```

Read a curated YC company list. "all" is large (about 6 MB); prefer a
  batch, industry, or tag lookup when you only need part of the directory.

  @param list - Use "top", "all", "hiring", "nonprofit", "women-founded", "black-founded", or "hispanic-latino-founded".

The `all` list can be large. Prefer a batch, industry, or tag when you
  only need part of the directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| list | `string` | "top" |

**Returns:** `Result<Company[]>`

**Throws:** `std::yc`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L219))

### ycMeta

```ts
ycMeta(): Result<YcMeta> raises <std::yc, std::http::fetchJSON>
```

Discover available YC batch, industry, and tag slugs and the dataset's update time.

**Returns:** `Result<YcMeta>`

**Throws:** `std::yc`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L237))
