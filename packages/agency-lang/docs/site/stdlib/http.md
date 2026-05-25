# http

## Functions

### fetch

```ts
fetch(baseUrl: string, path: string, headers: Record<string, any>, allowedDomains: string[]): Result
```

A tool for fetching a URL and returning the response as text. Provide baseUrl and optionally path (they are joined). Set headers for custom request headers. Set allowedDomains to restrict which domains can be fetched.

  Cancellation: an aborted run (e.g. user Ctrl-C, race loser, time guard) tears down the in-flight HTTP request and body read, surfacing as an AgencyCancelledError that propagates out of the surrounding `try`.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` |  |
| path | `string` | "" |
| headers | `Record<string, any>` | {} |
| allowedDomains | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::http::fetch`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/http.agency#L9))

### fetchJSON

```ts
fetchJSON(baseUrl: string, path: string, headers: Record<string, any>, allowedDomains: string[]): Result
```

A tool for fetching a URL and returning the response as parsed JSON. Provide baseUrl and optionally path (they are joined). Set headers for custom request headers. Set allowedDomains to restrict which domains can be fetched.

  Cancellation: an aborted run (e.g. user Ctrl-C, race loser, time guard) tears down the in-flight HTTP request and body read, surfacing as an AgencyCancelledError that propagates out of the surrounding `try`.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` |  |
| path | `string` | "" |
| headers | `Record<string, any>` | {} |
| allowedDomains | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::http::fetchJSON`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/http.agency#L32))

### fetchMarkdown

```ts
fetchMarkdown(baseUrl: string, path: string, headers: Record<string, any>, allowedDomains: string[]): Result
```

Fetch a URL and return the body as readable markdown when the response is HTML, or as plain text otherwise. Useful for extracting page content for an LLM. Provide baseUrl and optionally path (they are joined). Set headers for custom request headers. Set allowedDomains to restrict which domains can be fetched. Fails on network errors, domain violations, or if the response body exceeds 10 MB.

  Cancellation: an aborted run (e.g. user Ctrl-C, race loser, time guard) tears down the in-flight HTTP request and body read, surfacing as an AgencyCancelledError that propagates out of the surrounding `try`.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` |  |
| path | `string` | "" |
| headers | `Record<string, any>` | {} |
| allowedDomains | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::http::fetchMarkdown`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/http.agency#L55))
