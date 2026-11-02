---
name: "wikidata"
description: "Find Wikidata entities, read claims, and query the knowledge graph."
---

# wikidata

## Wikidata — the open knowledge graph

  Query [Wikidata](https://www.wikidata.org), the free structured database behind Wikipedia:
  resolve a name to an entity, read an entity's facts, or run a raw SPARQL query over the graph.
  Use it for broad entity research — people, organizations, places, works, and their typed
  relationships — complementing the power-network focus of `std::data/people/littlesis`.

  Recipe: `wikidataSearch` a name to get a QID, then `wikidataEntity(qid)` for its facts, or
  `wikidataQuery` for graph traversal. Entity claims and SPARQL results reference other entities by
  QID (e.g. "Q5"); resolve those with another search/entity call, or ask SPARQL for labels with
  `SERVICE wikibase:label`. No API key required (WDQS is rate-limited and wants a descriptive
  User-Agent — set WIKIDATA_USER_AGENT to override the default).

  ### Usage

  ```ts
  import { wikidataSearch, wikidataEntity } from "std::data/wikidata"

  node main() {
    const hits = wikidataSearch("Ada Lovelace") catch []
    if (hits.length > 0) {
      const e = wikidataEntity(hits[0].id) catch { id: "", label: "", description: "", aliases: [], claims: {} }
      print("${e.label}: ${e.description}")
    }
  }
  ```

## Types

### Entity

A Wikidata entity from a name search. `id` is the QID (e.g. "Q42").

```ts
/** A Wikidata entity from a name search. `id` is the QID (e.g. "Q42"). */
export type Entity = {
  id: string;
  label: string;
  description: string;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L48))

### EntityDetail

One entity's facts. `claims` maps a property id (e.g. "P31") to its values; a value is a QID for
    entity-valued claims, or the literal's string form otherwise. Resolve QIDs with another
    search/entity call.

```ts
/** One entity's facts. `claims` maps a property id (e.g. "P31") to its values; a value is a QID for
    entity-valued claims, or the literal's string form otherwise. Resolve QIDs with another
    search/entity call. */
export type EntityDetail = {
  id: string;
  label: string;
  description: string;
  aliases: string[];
  claims: Record<string, string[]>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L58))

## Effects

### std::wikidata

```ts
effect std::wikidata {
  op: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L35))

## Functions

### wikidataSearch

```ts
wikidataSearch(
  name: string,
  limit: number = 5,
): Result<Entity[]> raises <std::wikidata, std::http::fetchJSON>
```

Find Wikidata entities by name and return their QIDs.

  @param name - A person, organization, place, or topic to look up.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| limit | `number` | 5 |

**Returns:** `Result<Entity[]>`

**Throws:** `std::wikidata`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L220))

### wikidataEntity

```ts
wikidataEntity(
  qid: string,
): Result<EntityDetail> raises <std::wikidata, std::http::fetchJSON>
```

Read a Wikidata entity’s English profile and property claims.

  @param qid - A Wikidata entity ID such as "Q42", obtained from search or another claim.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| qid | `string` |  |

**Returns:** `Result<EntityDetail>`

**Throws:** `std::wikidata`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L232))

### wikidataQuery

```ts
wikidataQuery(
  sparql: string,
): Result<Record<string, string>[]> raises <std::wikidata, std::http::fetchJSON>
```

Run a SPARQL SELECT query against the Wikidata knowledge graph.

  @param sparql - A complete SPARQL SELECT query.

Use SELECT queries to retrieve rows. Each row maps a selected variable
  name to its string value. Ask for labels when you need names for QIDs:

  ```sparql
  SELECT ?item ?itemLabel WHERE {
    ?item wdt:P31 wd:Q5 .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
  } LIMIT 10
  ```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| sparql | `string` |  |

**Returns:** `Result<Record<string, string>[]>`

**Throws:** `std::wikidata`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L255))
