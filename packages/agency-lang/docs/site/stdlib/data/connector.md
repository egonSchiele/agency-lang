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
  headers: Record<string, any> = {},
  method: HttpMethod = "GET",
  body: Record<string, any> | string | null = null,
): Result raises <std::http::fetchJSON>
```

Fetch a connector API path and return the parsed-JSON Result. Raises the
    same std::http::fetchJSON interrupt as fetchJSON itself, so calling this
    directly is fully gated — nothing is pre-approved. Connector verbs approve
    it at the call site (`connectorFetch(...) with approve`), AFTER raising
    their own connector effect; that is what makes a connector call surface as
    one connector-level prompt. The call-site approval is a vote, not a
    bypass: an outer handler still receives the fetch interrupt and its
    reject wins. allowedDomains is enforced inside fetchJSON.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| base | `string` |  |
| domains | `string[]` |  |
| path | `string` |  |
| headers | `Record<string, any>` | {} |
| method | [HttpMethod](../http.md#httpmethod) | "GET" |
| body | `Record<string, any> \| string \| null` | null |

**Returns:** `Result`

**Throws:** `std::http::fetchJSON`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L25))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L37))

### shapeError

```ts
shapeError(source: string, endpoint: string, err: any): string
```

Failure message for a response body that failed wire-shape validation.
    The embedded Zod issues name each mismatched path and what was expected
    there, so API drift is diagnosable from the message alone. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| endpoint | `string` |  |
| err | `any` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L44))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L49))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L63))
