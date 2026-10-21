---
name: "http"
description: "Fetch URLs from Agency code."
---

# http

Fetch URLs from Agency code. Returns the response as text, JSON, or Markdown.
  Aborting tears down the in-flight request. A request that has not finished
  in 30 seconds, headers and body together, fails with a message naming the
  URL and the limit; `timeout` raises the limit per call, and `0` removes it.

  ```ts
  import { fetch, fetchJSON } from "std::http"

  node main() {
    const page = fetch("https://example.com")
    const data = fetchJSON("https://api.example.com/status")
    print(page)
  }
  ```

## Types

### HttpMethod

An HTTP request method. POST/PUT/PATCH/DELETE may carry a body; GET/HEAD do not.

```ts
/** An HTTP request method. POST/PUT/PATCH/DELETE may carry a body; GET/HEAD do not. */
export type HttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L34))

## Effects

### std::http::fetch

```ts
@always(method, baseUrl)
effect std::http::fetch {
  baseUrl: string;
  path: string;
  method: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L27))

### std::http::fetchJSON

```ts
@always(method, baseUrl)
effect std::http::fetchJSON {
  baseUrl: string;
  path: string;
  method: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L29))

### std::http::fetchMarkdown

```ts
@always(method, baseUrl)
effect std::http::fetchMarkdown {
  baseUrl: string;
  path: string;
  method: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L31))

## Functions

### fetch

```ts
fetch(
  baseUrl: string,
  path: string = "",
  headers: Record<string, any> = {},
  allowedDomains: string[] = [],
  method: HttpMethod = "GET",
  body: Record<string, any> | string | null = null,
  timeout: number = 30000,
): Result
```

Fetch a URL and return the response as text.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)
  @param method - The HTTP method
  @param body - Request body: a string is sent as-is, a non-string is sent as JSON
  @param timeout - Time limit in milliseconds for the whole request (default 30000); 0 means no limit

On abort, Agency tears down the in-flight HTTP request and body read. The
  abort surfaces as an AgencyCancelledError that propagates out of the
  surrounding `try`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` |  |
| path | `string` | "" |
| headers | `Record<string, any>` | {} |
| allowedDomains | `string[]` | [] |
| method | [HttpMethod](#httpmethod) | "GET" |
| body | `Record<string, any> \| string \| null` | null |
| timeout | `number` | 30000 |

**Returns:** `Result`

**Throws:** `std::http::fetch`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L42))

### fetchJSON

```ts
fetchJSON(
  baseUrl: string,
  path: string = "",
  headers: Record<string, any> = {},
  allowedDomains: string[] = [],
  method: HttpMethod = "GET",
  body: Record<string, any> | string | null = null,
  timeout: number = 30000,
): Result
```

Fetch a URL and return the response parsed as JSON.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)
  @param method - The HTTP method
  @param body - Request body: a string is sent as-is, a non-string is sent as JSON
  @param timeout - Time limit in milliseconds for the whole request (default 30000); 0 means no limit

On abort, Agency tears down the in-flight HTTP request and body read. The
  abort surfaces as an AgencyCancelledError that propagates out of the
  surrounding `try`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` |  |
| path | `string` | "" |
| headers | `Record<string, any>` | {} |
| allowedDomains | `string[]` | [] |
| method | [HttpMethod](#httpmethod) | "GET" |
| body | `Record<string, any> \| string \| null` | null |
| timeout | `number` | 30000 |

**Returns:** `Result`

**Throws:** `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L76))

### fetchMarkdown

```ts
fetchMarkdown(
  baseUrl: string,
  path: string = "",
  headers: Record<string, any> = {},
  allowedDomains: string[] = [],
  method: HttpMethod = "GET",
  body: Record<string, any> | string | null = null,
  timeout: number = 30000,
): Result
```

Fetch a URL and return the body as readable markdown when the response is HTML, or as plain text otherwise. Good for extracting page content for an LLM. Fails on network errors, domain violations, or if the response body exceeds 10 MB.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)
  @param method - The HTTP method
  @param body - Request body: a string is sent as-is, a non-string is sent as JSON
  @param timeout - Time limit in milliseconds for the whole request (default 30000); 0 means no limit

On abort, Agency tears down the in-flight HTTP request and body read. The
  abort surfaces as an AgencyCancelledError that propagates out of the
  surrounding `try`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` |  |
| path | `string` | "" |
| headers | `Record<string, any>` | {} |
| allowedDomains | `string[]` | [] |
| method | [HttpMethod](#httpmethod) | "GET" |
| body | `Record<string, any> \| string \| null` | null |
| timeout | `number` | 30000 |

**Returns:** `Result`

**Throws:** `std::http::fetchMarkdown`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L110))
