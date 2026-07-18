---
name: "yc"
description: "## Y Combinator — the YC company directory"
---

# yc

## Y Combinator — the YC company directory

  Query the [yc-oss](https://github.com/yc-oss/api) community dataset: every company Y Combinator
  has funded, sliced by batch, industry, tag, or a curated list. Use this connector to track the
  newest YC startups and what they do — batch, one-liner, industry, stage, team size, and status.

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

A YC company — a curated subset of the yc-oss record. `launchedAt` is a Unix timestamp.

```ts
/** A YC company — a curated subset of the yc-oss record. `launchedAt` is a Unix timestamp. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L38))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L62))

## Effects

### std::yc

```ts
effect std::yc {
  op: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L29))

## Functions

### ycBatch

```ts
ycBatch(batch: string): Result<Company[]> raises <std::yc, std::http::fetchJSON>
```

Fetch the YC companies in a batch. Returns each company's id, name, one-liner, batch, status,
  stage, team size, industry, tags, and URL. An unknown batch returns a failure.

  @param batch - The YC batch, e.g. "Winter 2025" or "winter-2025"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| batch | `string` |  |

**Returns:** `Result<Company[]>`

**Throws:** `std::yc`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L191))

### ycIndustry

```ts
ycIndustry(
  industry: string,
): Result<Company[]> raises <std::yc, std::http::fetchJSON>
```

Fetch the YC companies in an industry. Returns each company's profile. An unknown industry
  returns a failure.

  @param industry - The industry, e.g. "fintech" or "Healthcare"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| industry | `string` |  |

**Returns:** `Result<Company[]>`

**Throws:** `std::yc`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L203))

### ycTag

```ts
ycTag(tag: string): Result<Company[]> raises <std::yc, std::http::fetchJSON>
```

Fetch the YC companies with a tag. Returns each company's profile. An unknown tag returns a
  failure.

  @param tag - The tag, e.g. "ai" or "SaaS"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| tag | `string` |  |

**Returns:** `Result<Company[]>`

**Throws:** `std::yc`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L215))

### ycList

```ts
ycList(
  list: string = "top",
): Result<Company[]> raises <std::yc, std::http::fetchJSON>
```

Fetch a curated YC company list: "top", "all", "hiring", "nonprofit", "women-founded",
  "black-founded", or "hispanic-latino-founded". "all" is large (~6 MB); prefer a batch, industry,
  or tag slice when you can.

  @param list - The curated list name

**Parameters:**

| Name | Type | Default |
|---|---|---|
| list | `string` | "top" |

**Returns:** `Result<Company[]>`

**Throws:** `std::yc`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L227))

### ycMeta

```ts
ycMeta(): Result<YcMeta> raises <std::yc, std::http::fetchJSON>
```

Fetch the YC directory metadata: the available batch, industry, and tag slugs plus the
  last-updated timestamp. Use it to discover the newest batch slug before calling ycBatch.

**Returns:** `Result<YcMeta>`

**Throws:** `std::yc`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/tech/yc.agency#L245))
