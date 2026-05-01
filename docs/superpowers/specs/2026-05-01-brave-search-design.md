# @agency-lang/brave-search Design Spec

## Overview

An Agency package that provides web search via the [Brave Search API](https://brave.com/search/api/). Exposes a single `braveSearch` function that agents can use as an LLM tool to search the web and get back structured results.

No third-party wrapper libraries — calls the Brave REST API directly (~40 lines of TypeScript). Uses the `BRAVE_API_KEY` environment variable by default, or accepts the key directly via the `apiKey` parameter (free tier: 1,000 searches/month).

## Configuration

Get a free API key at https://api.search.brave.com/app/keys. No `agency.json` configuration is needed.

**Option 1: Environment variable** (recommended). Set `BRAVE_API_KEY` in a `.env` file or your shell:

```
# .env
BRAVE_API_KEY=your-key-here
```

**Option 2: Pass directly.** Use the `apiKey` named parameter if you can't set an env var:

```
braveSearch("my query", apiKey: myApiKey)
```

## Usage

```
import { braveSearch } from "pkg::@agency-lang/brave-search"

node main() {
  let answer = llm("What's the latest news on AI regulation?") uses braveSearch
}
```

The LLM calls `braveSearch(query)` as a tool. Results come back as an array of `{ title, url, description }` objects.

## Package Structure

```
packages/brave-search/
├── package.json            # @agency-lang/brave-search
├── tsconfig.json
├── index.agency            # Agency wrapper exporting braveSearch
├── src/
│   ├── braveSearch.ts      # Core: fetch Brave API + map results
│   └── braveSearch.test.ts # Unit tests (mocked fetch)
└── tests/
    └── agency/
        └── brave-search.agency  # Integration test
```

## API Design

### Brave Search API

- **Endpoint:** `GET https://api.search.brave.com/res/v1/web/search`
- **Auth:** `X-Subscription-Token: <BRAVE_API_KEY>` header
- **Key params:** `q` (query), `count` (1-20), `country`, `search_lang`, `safesearch`, `freshness`
- **Response:** `{ web: { results: [{ title, url, description, ... }] } }`

### TypeScript Core (`src/braveSearch.ts`)

```typescript
type BraveSearchResult = {
  title: string
  url: string
  description: string
}

type BraveSearchOptions = {
  apiKey?: string             // override BRAVE_API_KEY env var
  count?: number              // 1-20, default 5
  country?: string            // 2-char code, e.g. "US"
  searchLang?: string         // ISO 639-1, e.g. "en"
  safesearch?: string              // "off", "moderate", or "strict"; default "moderate"
  freshness?: string          // "pd" (24h), "pw" (7d), "pm" (31d), "py" (1y)
}

export async function braveSearch(
  query: string,
  options?: BraveSearchOptions
): Promise<BraveSearchResult[]>
```

**Behavior:**
- Uses `options.apiKey` if provided, otherwise reads `BRAVE_API_KEY` from `process.env`
- Throws if neither is set
- Builds URL with query params, makes GET request with auth header
- Extracts `response.web.results`, maps each to `{ title, url, description }`
- Throws on non-200 HTTP responses with status code and response body (e.g., "Brave Search API error (429): Rate limit exceeded")

### Agency Wrapper (`index.agency`)

```
import { braveSearch as braveSearchImpl } from "./dist/src/braveSearch.js"

/// Search the web using Brave Search. Returns titles, URLs, and descriptions.
export def braveSearch(query: string, count: number = 5, apiKey: string = "", country: string = "", searchLang: string = "", safesearch: string = "moderate", freshness: string = "") {
  return braveSearchImpl(query, {
    count: count,
    apiKey: apiKey,
    country: country,
    searchLang: searchLang,
    safesearch: safesearch,
    freshness: freshness
  })
}
```

All options are exposed with sensible defaults. Users can pass them positionally or with named parameters:

```
// Simple — LLM will typically call it this way
braveSearch("climate change")

// With named parameters for advanced use
braveSearch("climate change", count: 10, country: "US", apiKey: myKey)
```

The TS core ignores empty-string options (treats them as unset), so the defaults work cleanly.

## Testing

### Unit Tests (`src/braveSearch.test.ts`)

Mock `global.fetch` and test:
- Correct URL construction with query params
- Auth header is set correctly
- Response mapping: extracts title, url, description from Brave API response
- Error: missing BRAVE_API_KEY throws
- Error: non-200 HTTP response throws with status/message
- Empty results: returns empty array

### Integration Test (`tests/agency/brave-search.agency`)

An Agency program that calls `braveSearch` directly (not via LLM) to verify the wiring works. The test requires a real `BRAVE_API_KEY` env var and makes a live API call. It should be skipped in CI unless secrets are configured. The test verifies that calling `braveSearch("test query")` returns an array of results with `title`, `url`, and `description` fields.

## package.json

```json
{
  "name": "@agency-lang/brave-search",
  "version": "0.0.1",
  "description": "Brave Search integration for Agency",
  "type": "module",
  "agency": "./index.agency",
  "main": "./dist/src/braveSearch.js",
  "exports": {
    ".": {
      "types": "./dist/src/braveSearch.d.ts",
      "import": "./dist/src/braveSearch.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist/",
    "index.agency"
  ],
  "author": "Aditya Bhargava",
  "license": "ISC",
  "bugs": { "url": "https://github.com/egonSchiele/agency-lang/issues" },
  "homepage": "https://github.com/egonSchiele/agency-lang",
  "scripts": {
    "build": "tsc",
    "test": "vitest",
    "test:run": "vitest run",
    "test:agency": "agency tests/agency"
  },
  "peerDependencies": {
    "agency-lang": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

No runtime dependencies — uses native `fetch`.

## Decisions

- **No wrapper library:** The Brave API is a single GET endpoint. Calling it directly avoids dependency risk, license issues (the existing `brave-search` npm package is GPL v3), and keeps the package minimal.
- **All options exposed with defaults:** All Brave API options are available via named parameters with sensible defaults. The TS core treats empty strings as unset, so default values don't generate unnecessary query params.
- **No caching:** Kept out of v1 for simplicity. Users can add their own caching layer.
- **No Result types in the TS core:** The core throws on errors. The Agency wrapper can use try/catch to convert to Result types if needed, but for a tool function, throwing is fine — Agency's tool execution catches errors and reports them to the LLM.
