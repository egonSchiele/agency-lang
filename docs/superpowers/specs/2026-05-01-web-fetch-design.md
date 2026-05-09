# @agency-lang/web-fetch Design Spec

## Overview

An Agency package that fetches web pages and extracts readable content as markdown using `@mozilla/readability` and `linkedom`. Returns structured results with title, content, excerpt, and site name.

## Configuration

No API keys or configuration needed. Works out of the box.

## Usage

```
import { fetchPage } from "pkg::@agency-lang/web-fetch"

node main() {
  let page = fetchPage("https://example.com/article")
  print(page.title)
  print(page.content)
}
```

As an LLM tool alongside brave-search:

```
import { braveSearch } from "pkg::@agency-lang/brave-search"
import { fetchPage } from "pkg::@agency-lang/web-fetch"

node main() {
  let answer = llm("Research climate change policy") uses braveSearch, fetchPage
}
```

## Package Structure

```
packages/web-fetch/
├── package.json            # @agency-lang/web-fetch
├── tsconfig.json
├── index.agency            # Agency wrapper exporting fetchPage
├── src/
│   ├── fetchPage.ts        # Core: fetch, parse, extract, convert to markdown
│   └── fetchPage.test.ts   # Unit tests (mocked fetch, real readability parsing)
└── tests/
    └── agency/
        └── web-fetch.agency  # Integration test
```

## API Design

### TypeScript Core (`src/fetchPage.ts`)

```typescript
type FetchPageResult = {
  title: string
  content: string       // article content as markdown
  excerpt: string
  siteName: string
  url: string           // final URL (after redirects)
}

type FetchPageOptions = {
  maxChars?: number     // default 20000, truncates content when exceeded
  timeout?: number      // default 15000ms, aborts fetch if exceeded
}

export async function fetchPage(
  url: string,
  options?: FetchPageOptions
): Promise<FetchPageResult>
```

**Behavior:**
1. Fetches the URL with a browser-like User-Agent header and `AbortSignal.timeout(timeout)` (default 15s). Uses default fetch redirect behavior (follows redirects automatically). The `url` field in the result is populated from `response.url`, reflecting the final URL after any redirects.
2. Throws on non-200 HTTP responses with status code and body (e.g., "Fetch error (404): Not Found")
3. Checks that the response `Content-Type` is HTML-like (`text/html` or `application/xhtml+xml`); throws a descriptive error otherwise (e.g., "Expected HTML but got application/pdf")
4. Parses the HTML into a DOM using `linkedom`'s `parseHTML`
5. Runs `@mozilla/readability`'s `Readability` on the DOM to extract the article
6. Throws if Readability returns null (page has no extractable content)
7. Converts the extracted article HTML to markdown using a regex-based converter (headings, links, bold, italic, code, lists, entity decoding)
8. Truncates content to `maxChars` (default 20,000) if exceeded
9. Returns `{ title, content, excerpt, siteName, url }`

### HTML-to-Markdown Conversion

Readability's `content` field is cleaned-up HTML (no nav, ads, scripts). We convert it to markdown using a regex-based approach similar to the existing stdlib `htmlToMarkdown` in `packages/agency-lang/stdlib/lib/http.ts`. This handles:
- Headings (`<h1>`-`<h6>` → `#`-`######`)
- Links (`<a href="...">` → `[text](url)`)
- Bold/italic (`<strong>`/`<em>` → `**`/`*`)
- Code (`<code>` → backticks)
- Lists (`<li>` → `- `)
- Line breaks and paragraphs
- HTML entity decoding

No additional dependency needed for this conversion.

### Agency Wrapper (`index.agency`)

```
import { fetchPage as fetchPageImpl } from "./dist/src/fetchPage.js"

/// Fetch a web page and extract its readable content as markdown. Returns title, content, excerpt, siteName, and url.
export def fetchPage(url: string, maxChars: number = 20000, timeout: number = 15000) {
  return fetchPageImpl(url, { maxChars: maxChars, timeout: timeout })
}
```

## Testing

### Unit Tests (`src/fetchPage.test.ts`)

Mock `global.fetch` and test with real `@mozilla/readability` + `linkedom` parsing:
- Extracts title, content, excerpt from a well-formed article HTML
- Converts extracted HTML to markdown (headings, links, lists, bold/italic)
- Truncates content to maxChars when exceeded
- Returns full content when under maxChars
- Throws on non-200 HTTP response with status and body
- Throws on non-HTML content type
- Throws when Readability can't extract content (returns null)
- Throws on timeout (AbortSignal.timeout)
- Passes through the final URL from response.url (for redirect tracking)
- Handles pages with missing title/excerpt gracefully (empty strings)

### Integration Test (`tests/agency/web-fetch.agency`)

An Agency program that calls `fetchPage` on `https://example.com` (IANA-maintained, stable) to verify end-to-end wiring. Checks that the result has `title`, `content`, `excerpt`, `siteName`, and `url` fields. Requires network access; skip in CI if unavailable.

## package.json

```json
{
  "name": "@agency-lang/web-fetch",
  "version": "0.0.1",
  "description": "Web page fetching and content extraction for Agency",
  "type": "module",
  "agency": "./index.agency",
  "main": "./dist/src/fetchPage.js",
  "exports": {
    ".": {
      "types": "./dist/src/fetchPage.d.ts",
      "import": "./dist/src/fetchPage.js"
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
  "dependencies": {
    "@mozilla/readability": "^0.5.0",
    "linkedom": "^0.18.0"
  },
  "peerDependencies": {
    "agency-lang": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

## Decisions

- **No API key needed:** This is a pure client-side fetch + parse. No external service.
- **@mozilla/readability + linkedom:** Trusted maintainer (Mozilla), lightweight DOM parser, clean security records. Readability extracts article content, stripping nav/ads/footers.
- **Regex-based HTML-to-markdown (duplicated from stdlib):** Avoids adding a `turndown` dependency. The stdlib has a similar `htmlToMarkdown` in `packages/agency-lang/stdlib/lib/http.ts`, but we duplicate rather than share it because: (1) this package shouldn't depend on agency-lang's internal stdlib, and (2) Readability already strips scripts/nav/ads, so our converter can be simpler. The duplication is small (~40 lines) and the two contexts have different input guarantees.
- **Default 20,000 char cap:** Prevents accidentally dumping huge pages into LLM context. Caller can override via `maxChars` named parameter.
- **Throws on errors:** Consistent with brave-search. Agency's tool execution catches errors and reports them to the LLM.
