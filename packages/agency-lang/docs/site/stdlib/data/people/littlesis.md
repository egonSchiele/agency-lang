---
name: "littlesis"
description: "Research people, organizations, and their relationships in LittleSis."
---

# littlesis

## LittleSis — people, organizations, and the ties between them

  Query the [LittleSis](https://littlesis.org/api/) API — an open database of powerful
  people and organizations and their **relationships** (employment, board seats,
  ownership, investment, and donations). Use it to investigate who worked
  where, who funds an organization, or who sits on a board.

  No API key required (the API is rate-limited; HTTP 503 means "Rate Limit Exceeded").

  Start with `littlesisSearch` to resolve a name to an ID. Then use
  `littlesisConnections` for connected entities by name, or
  `littlesisRelationships` for amounts, dates, and roles. Relationship
  records identify both entities by ID.

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

A LittleSis person or organization. `type` is "Person" or "Org".
    `relationshipId`/`relationshipCategory` are populated only on connections results.

```ts
/** A LittleSis person or organization. `type` is "Person" or "Org".
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L48))

### Relationship

One relationship whose entity1Id and entity2Id identify LittleSis entities.

```ts
/** One relationship whose entity1Id and entity2Id identify LittleSis entities. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L62))

## Effects

### std::littlesis

```ts
effect std::littlesis {
  op: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L38))

## Functions

### littlesisSearch

```ts
littlesisSearch(
  name: string,
  page: number = 1,
): Result<Entity[]> raises <std::littlesis, std::http::fetchJSON>
```

Find people and organizations in LittleSis by name.

  @param page - The result page, starting at one, with ten entries per page.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| page | `number` | 1 |

**Returns:** `Result<Entity[]>`

**Throws:** `std::littlesis`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L235))

### littlesisEntity

```ts
littlesisEntity(
  id: number,
): Result<Entity> raises <std::littlesis, std::http::fetchJSON>
```

Read a LittleSis person or organization profile.

  @param id - An entity ID returned by a LittleSis search or connection listing.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |

**Returns:** `Result<Entity>`

**Throws:** `std::littlesis`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L249))

### littlesisRelationships

```ts
littlesisRelationships(
  id: number,
  category: string = "",
  sort: string = "",
): Result<Relationship[]> raises <std::littlesis, std::http::fetchJSON>
```

List an entity’s relationships with roles, amounts, and dates.

  @param id - An entity ID returned by a LittleSis search or connection listing.
  @param category - Use position, education, membership, family, donation, transaction, lobbying, social, professional, ownership, hierarchy, or generic, or empty for all categories.
  @param sort - Use "amount", "oldest", or "recent", or empty for the source default.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |
| category | `string` | "" |
| sort | `string` | "" |

**Returns:** `Result<Relationship[]>`

**Throws:** `std::littlesis`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L261))

### littlesisConnections

```ts
littlesisConnections(
  id: number,
  category: string = "",
): Result<Entity[]> raises <std::littlesis, std::http::fetchJSON>
```

List the people and organizations connected to an entity, by name.

  @param id - An entity ID returned by a LittleSis search or connection listing.
  @param category - Use position, education, membership, family, donation, transaction, lobbying, social, professional, ownership, hierarchy, or generic, or empty for all categories.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `number` |  |
| category | `string` | "" |

**Returns:** `Result<Entity[]>`

**Throws:** `std::littlesis`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/people/littlesis.agency#L282))
