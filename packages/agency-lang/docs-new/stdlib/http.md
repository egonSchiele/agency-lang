# http

## Functions

### webfetch

```ts
webfetch(baseUrl: string, path: string, headers: Record<string, any>, allowedDomains: string[]): Result
```

Fetch a URL and return the body as readable markdown when the response is HTML, or as plain text otherwise. Useful for extracting page content for an LLM. Provide baseUrl and optionally path (they are joined). Set headers for custom request headers. Set allowedDomains to restrict which domains can be fetched. Fails on network errors, domain violations, or if the response body exceeds 10 MB.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/http.agency#L3))
