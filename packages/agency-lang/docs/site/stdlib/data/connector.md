---
name: "connector"
description: "Connector core — shared plumbing for `std::data` connectors"
---

# connector

## Connector core — shared plumbing for `std::data` connectors

  Every data connector (Hacker News, Bluesky, ...) needs the same plumbing: an
  HTTP fetch that surfaces as one connector-level prompt instead of a raw HTTP
  prompt per request, a consistent failure message, limit clamping, and
  timestamp normalization. This module holds that plumbing so a connector file
  only contains what is specific to its source: types, reshapes, path
  builders, and verbs.

  See `docs/dev/data-connectors.md` for the full guide to writing a connector.

## Functions

### connectorFetch

```ts
connectorFetch(
  base: string,
  domains: string[],
  path: string,
): Result raises <std::http::fetchJSON>
```

Fetch a connector API path and return the parsed-JSON Result. Approves the
    inner std::http::fetchJSON interrupt so a plain caller sees only the
    connector's own effect prompt. An OUTER fetch handler still receives the
    fetch interrupt and can reject or propagate it (a reject always wins over
    this approve). allowedDomains is enforced inside fetchJSON regardless.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| base | `string` |  |
| domains | `string[]` |  |
| path | `string` |  |

**Returns:** `Result`

**Throws:** `std::http::fetchJSON`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L22))

### connectorError

```ts
connectorError(source: string, err: any): string
```

Shared failure message for a failed connector fetch. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| err | `any` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L33))

### clampLimit

```ts
clampLimit(n: number, cap: number): number
```

Clamp n into [0, cap]. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| cap | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L38))

### dateStrToEpochMs

```ts
dateStrToEpochMs(iso: string): number
```

Convert an ISO 8601 datetime string to epoch milliseconds. Returns 0 when
    the string cannot be parsed, so reshapes using it stay total. Connectors
    normalize every source timestamp through this, whatever the source's
    native format, so cross-connector code can compare times directly. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| iso | `string` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L52))
