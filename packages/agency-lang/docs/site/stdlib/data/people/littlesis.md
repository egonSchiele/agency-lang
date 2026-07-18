---
name: "littlesis"
description: "## LittleSis — people, organizations, and the ties between them"
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

### littlesisSearch

```ts
littlesisSearch(
  name: string,
  page: number = 1,
): Result<Entity[]> raises <std::littlesis, std::http::fetchJSON>
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
littlesisEntity(
  id: number,
): Result<Entity> raises <std::littlesis, std::http::fetchJSON>
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
littlesisRelationships(
  id: number,
  category: string = "",
  sort: string = "",
): Result<Relationship[]> raises <std::littlesis, std::http::fetchJSON>
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
littlesisConnections(
  id: number,
  category: string = "",
): Result<Entity[]> raises <std::littlesis, std::http::fetchJSON>
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
