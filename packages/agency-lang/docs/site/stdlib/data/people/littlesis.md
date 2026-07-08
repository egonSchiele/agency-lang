---
name: "littlesis"
---

# littlesis

## LittleSis — people, organizations, and the ties between them

  Query the [LittleSis](https://littlesis.org/api/) API — an open database of powerful
  people and organizations and their **relationships** (employment, board seats,
  ownership/investment, donations). Use this connector when the question is about *entities and
  the edges between them* (who worked where, who funds whom, who sits on which board), as opposed
  to macro numbers (`std::data/finance/fred`), company filings (`std::data/finance/edgar`), or
  news (`std::data/finance/gdelt`).

  No API key required (the API is rate-limited; HTTP 503 means "Rate Limit Exceeded").

  **Two-step recipe.** LittleSis edges carry entity *IDs*, not names. So:
  use `littlesisConnections` to see *who* an entity is tied to (neighbor entities **by name**,
  filtered by category); use `littlesisRelationships` to get the *terms* of a tie (amount, dates,
  roles). Resolve a name to an id first with `littlesisSearch`.

  Relationship categories are friendly strings: `position` (employment/roles), `education`,
  `membership`, `family`, `donation`, `transaction`, `lobbying`, `social`, `professional`,
  `ownership`, `hierarchy`, `generic`.

  ### Usage

  ```ts
  import { littlesisSearch, littlesisConnections } from "std::data/people/littlesis"

  node main() {
    const hits = littlesisSearch("Andreessen Horowitz") catch []
    if (hits.length > 0) {
      const linked = littlesisConnections(hits[0].id, "ownership") catch []
      for (e in linked) { print("${e.type}  ${e.name}") }
    }
  }
  ```

## Types

### Entity

A LittleSis person or organization. `type` is "Person" or "Org" (from primary_ext).
    `relationshipId`/`relationshipCategory` are populated only on connections results.

```ts
/** A LittleSis person or organization. `type` is "Person" or "Org" (from primary_ext).
    `relationshipId`/`relationshipCategory` are populated only on connections results. */
export type Entity = {
  id: number;
  name: string;
  type: string;
  blurb: string;
  types: string[];
  aliases: string[];
  website: string;
  url: string;
  relationshipId?: number;
  relationshipCategory: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L49))

### Relationship

One typed edge. entity1Id/entity2Id are LittleSis entity IDs, NOT names.

```ts
/** One typed edge. entity1Id/entity2Id are LittleSis entity IDs, NOT names. */
export type Relationship = {
  id: number;
  category: string;
  categoryId: number;
  entity1Id: number;
  entity2Id: number;
  description1: string;
  description2: string;
  amount?: number;
  startDate: string;
  endDate: string;
  isCurrent?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L63))

### CategoryFilter

A category filter for relationship/connection queries: either "all" (no filter) or a specific
    category by id. Produced by parseCategoryFilter, consumed by the path builders — this replaces
    the old numeric sentinels (no more -1 for "invalid" or 0 for "all").

```ts
/** A category filter for relationship/connection queries: either "all" (no filter) or a specific
    category by id. Produced by parseCategoryFilter, consumed by the path builders — this replaces
    the old numeric sentinels (no more -1 for "invalid" or 0 for "all"). */
export type CategoryFilter = { type: "all" } | { type: "category"; id: number }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L80))

## Effects

### std::littlesis

```ts
effect std::littlesis {
  op: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L39))

## Functions

### categoryIdToName

```ts
categoryIdToName(id: number): string
```

Map a LittleSis category_id (1–12) to its friendly name; unknown id → "". Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L83))

### parseCategoryFilter

```ts
parseCategoryFilter(name: string): Result<CategoryFilter>
```

Parse a friendly category name into a CategoryFilter. "" (or not given) → all; a valid name →
    that category; an unknown name → failure (listing the valid names). Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `Result<CategoryFilter>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L98))

### buildSearchPath

```ts
buildSearchPath(name: string, page: number): string
```

Build the entity-search path. `page` is appended only when > 1. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| page | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L110))

### buildEntityPath

```ts
buildEntityPath(id: number): string
```

Build the single-entity path. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L119))

### buildRelationshipsPath

```ts
buildRelationshipsPath(id: number, filter: CategoryFilter, sort: string): string
```

Build the relationships path from a category filter and optional sort. Builds a present-params
    list and joins it, so it scales linearly with params instead of enumerating combinations. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |
| filter | [CategoryFilter](#categoryfilter) |  |
| sort | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L125))

### buildConnectionsPath

```ts
buildConnectionsPath(id: number, filter: CategoryFilter): string
```

Build the connections path from a category filter. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |
| filter | [CategoryFilter](#categoryfilter) |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L141))

### parseEntity

```ts
parseEntity(node: any): Entity
```

Reshape one LittleSis entity node ({ id, attributes, links }) into an Entity.
    Reads connection-only relationship fields defensively (null/"" when absent). Pure/total.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | `any` |  |

**Returns:** [Entity](#entity)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L150))

### parseEntities

```ts
parseEntities(raw: any): Entity[]
```

Reshape a LittleSis list body ({ data: [node] }) into Entity[]. Pure/total.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| raw | `any` |  |

**Returns:** `Entity[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L170))

### parseRelationships

```ts
parseRelationships(raw: any): Relationship[]
```

Reshape a LittleSis relationships body ({ data: [rel] }) into Relationship[]. Pure/total.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| raw | `any` |  |

**Returns:** `Relationship[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L179))

### littlesisError

```ts
littlesisError(err: any): string
```

Shared failure message for a failed LittleSis fetch. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| err | `any` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L203))

### entityListFinalize

```ts
entityListFinalize(fetchResult: any): Result<Entity[]>
```

Turn a fetchJSON Result into an entity-list Result. Used by BOTH search and connections
    (identical shape). Pure — testable with mock Results.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| fetchResult | `any` |  |

**Returns:** `Result<Entity[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L223))

### entityFinalize

```ts
entityFinalize(fetchResult: any): Result<Entity>
```

Turn a fetchJSON Result into a single-entity Result; missing data → failure. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| fetchResult | `any` |  |

**Returns:** `Result<Entity>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L231))

### relationshipsFinalize

```ts
relationshipsFinalize(fetchResult: any): Result<Relationship[]>
```

Turn a fetchJSON Result into a relationships Result. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| fetchResult | `any` |  |

**Returns:** `Result<Relationship[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L245))

### littlesisSearch

```ts
littlesisSearch(name: string, page: number): Result<Entity[]>
```

Search LittleSis for people and organizations by name. Returns matching entities (id, name,
  type "Person"/"Org", blurb, aliases, website, url). Use the returned id with the other
  littlesis functions. Empty result set returns an empty list.

  @param name - The person or organization name to search for
  @param page - Result page, 10 per page (default 1)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| page | `number` | 1 |

**Returns:** `Result<Entity[]>`

**Throws:** `std::littlesis`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L252))

### littlesisEntity

```ts
littlesisEntity(id: number): Result<Entity>
```

Fetch one LittleSis entity by its numeric id (from littlesisSearch). Returns the full profile
  (name, type, blurb, aliases, website, url). Unknown id returns a failure.

  @param id - The LittleSis entity id

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |

**Returns:** `Result<Entity>`

**Throws:** `std::littlesis`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L268))

### littlesisRelationships

```ts
littlesisRelationships(id: number, category: string, sort: string): Result<Relationship[]>
```

List an entity's relationships (typed edges) by its id. Each edge carries the two entity IDs,
  role labels (description1/description2), amount, dates, and category. Filter with a friendly
  category name. Edges carry entity IDs, not names — use littlesisConnections for neighbor names.

  @param id - The LittleSis entity id
  @param category - Optional category filter: position, education, membership, family, donation, transaction, lobbying, social, professional, ownership, hierarchy, generic (empty = all)
  @param sort - Optional sort: "amount", "oldest", or "recent" (empty = default)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |
| category | `string` | "" |
| sort | `string` | "" |

**Returns:** `Result<Relationship[]>`

**Throws:** `std::littlesis`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L280))

### littlesisConnections

```ts
littlesisConnections(id: number, category: string): Result<Entity[]>
```

List the entities connected to an entity (neighbors, by name), optionally filtered by a
  friendly category name. Lighter than littlesisRelationships and name-bearing — the preferred
  first hop for "who is X tied to". Each result also carries the linking relationshipId/category.

  @param id - The LittleSis entity id
  @param category - Optional category filter: position, education, membership, family, donation, transaction, lobbying, social, professional, ownership, hierarchy, generic (empty = all)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |
| category | `string` | "" |

**Returns:** `Result<Entity[]>`

**Throws:** `std::littlesis`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L304))
