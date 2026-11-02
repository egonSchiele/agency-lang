---
name: "http"
description: "Fetch web content as text, JSON, or Markdown."
---

# http

Fetch URLs from Agency code. Returns the response as text, JSON, or Markdown.
  Aborting tears down the in-flight request. A request that has not finished
  in 30 seconds, headers and body together, fails with a message naming the
  URL and the limit; `timeout` raises the limit per call, and `0` removes it.

  When a model calls one of these as a tool, a GET with no body or headers
  of a URL the same conversation already fetched is not fetched again: the
  tool returns what the first fetch returned, and `refresh: true` fetches
  anyway.
  Direct calls from Agency code always make a request.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L41))

## Effects

### std::http::fetch

```ts
@always(method, baseUrl)
effect std::http::fetch {
  baseUrl: string;
  path: string;
  method: string;
  scheme: string;
  network: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L34))

### std::http::fetchJSON

```ts
@always(method, baseUrl)
effect std::http::fetchJSON {
  baseUrl: string;
  path: string;
  method: string;
  scheme: string;
  network: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L36))

### std::http::fetchMarkdown

```ts
@always(method, baseUrl)
effect std::http::fetchMarkdown {
  baseUrl: string;
  path: string;
  method: string;
  scheme: string;
  network: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L38))

## Functions

### fetch

```ts
fetch(
  baseUrl | url: string,
  path: string = "",
  headers: Record<string, any> = {},
  allowedDomains: string[] = [],
  method: HttpMethod = "GET",
  body: Record<string, any> | string | null = null,
  timeout: number = 30000,
  refresh: boolean = false,
): Result raises <std::http::fetch>
```

Fetch a URL as text.

On abort, Agency tears down the in-flight HTTP request and body read. The
  abort surfaces as an AgencyCancelledError that propagates out of the
  surrounding `try`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| baseUrl (also `url`) | `string` |  |  |
| path | `string` | "" | Optional path appended to baseUrl. |
| headers | `Record<string, any>` | {} |  |
| allowedDomains | `string[]` | [] | Allowed destination domains, or empty for no restriction. |
| method | [HttpMethod](#httpmethod) | "GET" |  |
| body | `Record<string, any> \| string \| null` | null | Text sent as-is, or an object sent as JSON. |
| timeout | `number` | 30000 | Whole-request time limit in milliseconds, or zero for no limit. |
| refresh | `boolean` | false | Refetch a repeated GET that would otherwise reuse the conversation's cached response. |

**Returns:** `Result`

**Throws:** `std::http::fetch`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L49))

### fetchJSON

```ts
fetchJSON(
  baseUrl | url: string,
  path: string = "",
  headers: Record<string, any> = {},
  allowedDomains: string[] = [],
  method: HttpMethod = "GET",
  body: Record<string, any> | string | null = null,
  timeout: number = 30000,
  refresh: boolean = false,
): Result raises <std::http::fetchJSON>
```

Fetch a URL and parse the response as JSON.

On abort, Agency tears down the in-flight HTTP request and body read. The
  abort surfaces as an AgencyCancelledError that propagates out of the
  surrounding `try`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| baseUrl (also `url`) | `string` |  |  |
| path | `string` | "" | Optional path appended to baseUrl. |
| headers | `Record<string, any>` | {} |  |
| allowedDomains | `string[]` | [] | Allowed destination domains, or empty for no restriction. |
| method | [HttpMethod](#httpmethod) | "GET" |  |
| body | `Record<string, any> \| string \| null` | null | Text sent as-is, or an object sent as JSON. |
| timeout | `number` | 30000 | Whole-request time limit in milliseconds, or zero for no limit. |
| refresh | `boolean` | false | Refetch a repeated GET that would otherwise reuse the conversation's cached response. |

**Returns:** `Result`

**Throws:** `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L93))

### fetchMarkdown

```ts
fetchMarkdown(
  baseUrl | url: string,
  path: string = "",
  headers: Record<string, any> = {},
  allowedDomains: string[] = [],
  method: HttpMethod = "GET",
  body: Record<string, any> | string | null = null,
  timeout: number = 30000,
  refresh: boolean = false,
): Result raises <std::http::fetchMarkdown>
```

Fetch a web page as readable Markdown for an LLM, or plain text for non-HTML responses.

On abort, Agency tears down the in-flight HTTP request and body read. The
  abort surfaces as an AgencyCancelledError that propagates out of the
  surrounding `try`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| baseUrl (also `url`) | `string` |  |  |
| path | `string` | "" | Optional path appended to baseUrl. |
| headers | `Record<string, any>` | {} |  |
| allowedDomains | `string[]` | [] | Allowed destination domains, or empty for no restriction. |
| method | [HttpMethod](#httpmethod) | "GET" |  |
| body | `Record<string, any> \| string \| null` | null | Text sent as-is, or an object sent as JSON. |
| timeout | `number` | 30000 | Whole-request time limit in milliseconds, or zero for no limit. |
| refresh | `boolean` | false | Refetch a repeated GET that would otherwise reuse the conversation's cached response. |

**Returns:** `Result`

**Throws:** `std::http::fetchMarkdown`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/http.agency#L137))
