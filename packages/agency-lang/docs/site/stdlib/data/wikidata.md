---
name: "wikidata"
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L46))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L56))

## Effects

### std::wikidata

```ts
effect std::wikidata {
  op: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L34))

## Functions

### wikidataSearch

```ts
wikidataSearch(name: string, limit: number): Result<Entity[]>
```

Search Wikidata for entities by name. Returns matches with QID, label, description, and URL. The
  QID identifies the entity for a follow-up entity fetch or SPARQL query. Empty result set returns an
  empty list.

  @param name - The person, organization, place, or thing to search for
  @param limit - Maximum number of matches to return (default 5)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| limit | `number` | 5 |

**Returns:** `Result<Entity[]>`

**Throws:** `std::wikidata`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L231))

### wikidataEntity

```ts
wikidataEntity(qid: string): Result<EntityDetail>
```

Fetch one Wikidata entity by its QID. Returns the English label, description, aliases, and claims
  (property id to values; entity-valued claims are QIDs to resolve separately). Unknown QID returns
  a failure.

  @param qid - The Wikidata entity id, e.g. "Q42"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| qid | `string` |  |

**Returns:** `Result<EntityDetail>`

**Throws:** `std::wikidata`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L245))

### wikidataQuery

```ts
wikidataQuery(sparql: string): Result<Record<string, string>[]>
```

Run a SPARQL query against the Wikidata Query Service and return rows (each a map of the SELECTed
  variable names to string values). Prefixes wd:/wdt:/rdfs: and SERVICE wikibase:label are available.
  Example: SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 . SERVICE wikibase:label { bd:serviceParam wikibase:language "en" } } LIMIT 10

  @param sparql - The SPARQL query text

**Parameters:**

| Name | Type | Default |
|---|---|---|
| sparql | `string` |  |

**Returns:** `Result<Record<string, string>[]>`

**Throws:** `std::wikidata`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/wikidata.agency#L258))
