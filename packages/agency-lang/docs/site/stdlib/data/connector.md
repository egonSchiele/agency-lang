---
name: "connector"
description: "Shared request and normalization helpers for data connectors."
---

# connector

Use these helpers when writing a connector for a public JSON API. They
  provide request handling, consistent error messages, limit clamping,
  and timestamp conversion.

  ```ts
  import { clampLimit, dateStrToEpochMs } from "std::data/connector"

  node main() {
    return {
      limit: clampLimit(500, 100),
      timestamp: dateStrToEpochMs("2026-01-01T00:00:00Z")
    }
  }
  ```

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

Fetch a JSON API path within the allowed domains.

  @param base - The API base URL to resolve the path against.
  @param domains - Hostnames that the request is allowed to reach.
  @param path - The API path and query string, with user-supplied values URL-encoded.

In a custom connector, raise your connector's effect before calling this
  helper with `with approve`. That avoids a separate interactive prompt
  for each HTTP request. Outer handlers still receive the HTTP interrupt
  and can reject it. Calling this helper directly requires an HTTP decision.

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

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L28))

### connectorError

```ts
connectorError(source: string, err: any): string
```

Format a connector request failure with its source name.

Keep request failures consistent across connector operations.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| err | `any` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L47))

### shapeError

```ts
shapeError(source: string, endpoint: string, err: any): string
```

Format a connector response-validation failure with its source and endpoint.

Preserve validation details so a caller can identify changed API fields.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| endpoint | `string` |  |
| err | `any` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L55))

### clampLimit

```ts
clampLimit(n: number, cap: number): number
```

Clamp a limit to the range from zero through the supplied cap.

Use for connector limits that should be clamped instead of rejected.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| cap | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L63))

### dateStrToEpochMs

```ts
dateStrToEpochMs(iso: string): number
```

Convert an ISO 8601 timestamp to epoch milliseconds, returning zero if it cannot be parsed.

Normalize source timestamps so results from different connectors can be compared.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| iso | `string` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/connector.agency#L77))
