# http

## Functions

### fetch

```ts
fetch(url: string): Result
```

Fetch a URL and return the response body as text. Fails on network errors or if the response body exceeds 10 MB.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | string |  |

**Returns:** Result

### fetchJSON

```ts
fetchJSON(url: string): Result
```

Fetch a URL and parse the response body as JSON. Fails on network errors, invalid JSON, or if the response body exceeds 10 MB.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | string |  |

**Returns:** Result

### webfetch

```ts
webfetch(url: string): Result
```

Fetch a URL and return the body as readable markdown when the response is HTML, or as plain text otherwise. Useful for extracting page content for an LLM. Fails on network errors or if the response body exceeds 10 MB.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | string |  |

**Returns:** Result
