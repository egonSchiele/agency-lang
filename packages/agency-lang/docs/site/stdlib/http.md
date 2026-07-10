---
name: "http"
---

# http

Fetch URLs from Agency code. Returns the response as text, JSON, or Markdown.
  Aborting tears down the in-flight request.

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

An HTTP request method. Non-GET methods may carry a body.

```ts
/** An HTTP request method. Non-GET methods may carry a body. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L29))

## Effects

### std::http::fetch

```ts
effect std::http::fetch {
  baseUrl: string;
  path: string;
  method: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L24))

### std::http::fetchJSON

```ts
effect std::http::fetchJSON {
  baseUrl: string;
  path: string;
  method: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L25))

### std::http::fetchMarkdown

```ts
effect std::http::fetchMarkdown {
  baseUrl: string;
  path: string;
  method: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L26))

## Functions

### fetch

```ts
fetch(baseUrl: string, path: string, headers: Record<string, any>, allowedDomains: string[], method: HttpMethod, body: any): Result
```

Fetch a URL and return the response as text.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)
  @param method - The HTTP method
  @param body - Request body: a string is sent as-is, a non-string is sent as JSON

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
| body | `any` | null |

**Returns:** `Result`

**Throws:** `std::http::fetch`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L36))

### fetchJSON

```ts
fetchJSON(baseUrl: string, path: string, headers: Record<string, any>, allowedDomains: string[], method: HttpMethod, body: any): Result
```

Fetch a URL and return the response parsed as JSON.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)
  @param method - The HTTP method
  @param body - Request body: a string is sent as-is, a non-string is sent as JSON

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
| body | `any` | null |

**Returns:** `Result`

**Throws:** `std::http::fetchJSON`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L67))

### fetchMarkdown

```ts
fetchMarkdown(baseUrl: string, path: string, headers: Record<string, any>, allowedDomains: string[], method: HttpMethod, body: any): Result
```

Fetch a URL and return the body as readable markdown when the response is HTML, or as plain text otherwise. Good for extracting page content for an LLM. Fails on network errors, domain violations, or if the response body exceeds 10 MB.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)
  @param method - The HTTP method
  @param body - Request body: a string is sent as-is, a non-string is sent as JSON

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
| body | `any` | null |

**Returns:** `Result`

**Throws:** `std::http::fetchMarkdown`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L98))
