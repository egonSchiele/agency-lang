# @agency-lang/brave-search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an Agency package that wraps the Brave Search REST API, exposing a `braveSearch` function usable as an LLM tool.

**Architecture:** A TypeScript core module (`src/braveSearch.ts`) calls the Brave Search API directly via native `fetch`. A thin Agency wrapper (`index.agency`) re-exports it as an Agency function with named parameters and defaults.

**Tech Stack:** TypeScript, native `fetch`, vitest for unit tests, Agency for integration test.

**Spec:** `docs/superpowers/specs/2026-05-01-brave-search-design.md`

---

### Task 1: Scaffold the package

**Files:**
- Create: `packages/brave-search/package.json`
- Create: `packages/brave-search/tsconfig.json`

- [ ] **Step 1: Create `packages/brave-search/package.json`**

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

- [ ] **Step 2: Create `packages/brave-search/tsconfig.json`**

Copy from `packages/mcp/tsconfig.json` — identical settings:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `cd packages/brave-search && pnpm install`

Verify the package is recognized by the workspace.

- [ ] **Step 4: Commit**

```bash
git add packages/brave-search/package.json packages/brave-search/tsconfig.json
git commit -m "scaffold @agency-lang/brave-search package"
```

---

### Task 2: Write unit tests for the TS core

**Files:**
- Create: `packages/brave-search/src/braveSearch.test.ts`

All tests mock `global.fetch`. No real API calls.

- [ ] **Step 1: Write the tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { braveSearch } from "./braveSearch.js";

const FAKE_KEY = "test-brave-api-key";

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe("braveSearch", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.BRAVE_API_KEY;

  beforeEach(() => {
    process.env.BRAVE_API_KEY = FAKE_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.BRAVE_API_KEY = originalEnv;
    } else {
      delete process.env.BRAVE_API_KEY;
    }
  });

  it("builds correct URL with query and default params", async () => {
    const mockFetch = mockFetchResponse({ web: { results: [] } });
    globalThis.fetch = mockFetch;

    await braveSearch("test query");

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://api.search.brave.com/res/v1/web/search"
    );
    expect(parsed.searchParams.get("q")).toBe("test query");
    expect(parsed.searchParams.get("count")).toBe("5");
  });

  it("sends API key in X-Subscription-Token header", async () => {
    const mockFetch = mockFetchResponse({ web: { results: [] } });
    globalThis.fetch = mockFetch;

    await braveSearch("test");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Subscription-Token"]).toBe(FAKE_KEY);
  });

  it("uses apiKey option over env var", async () => {
    const mockFetch = mockFetchResponse({ web: { results: [] } });
    globalThis.fetch = mockFetch;

    await braveSearch("test", { apiKey: "override-key" });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Subscription-Token"]).toBe("override-key");
  });

  it("maps response to BraveSearchResult array", async () => {
    globalThis.fetch = mockFetchResponse({
      web: {
        results: [
          {
            title: "Example",
            url: "https://example.com",
            description: "An example site",
            extra_field: "ignored",
          },
        ],
      },
    });

    const results = await braveSearch("test");

    expect(results).toEqual([
      {
        title: "Example",
        url: "https://example.com",
        description: "An example site",
      },
    ]);
  });

  it("returns empty array when no web results", async () => {
    globalThis.fetch = mockFetchResponse({ web: { results: [] } });
    const results = await braveSearch("test");
    expect(results).toEqual([]);
  });

  it("returns empty array when web field is missing", async () => {
    globalThis.fetch = mockFetchResponse({});
    const results = await braveSearch("test");
    expect(results).toEqual([]);
  });

  it("throws when no API key is available", async () => {
    delete process.env.BRAVE_API_KEY;
    await expect(braveSearch("test")).rejects.toThrow(
      "BRAVE_API_KEY"
    );
  });

  it("throws on non-200 response with status and body", async () => {
    globalThis.fetch = mockFetchResponse(
      { message: "Rate limit exceeded" },
      429
    );

    await expect(braveSearch("test")).rejects.toThrow(
      "Brave Search API error (429)"
    );
  });

  it("includes optional params in URL when provided", async () => {
    const mockFetch = mockFetchResponse({ web: { results: [] } });
    globalThis.fetch = mockFetch;

    await braveSearch("test", {
      count: 10,
      country: "US",
      searchLang: "en",
      safesearch: "strict",
      freshness: "pw",
    });

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("count")).toBe("10");
    expect(parsed.searchParams.get("country")).toBe("US");
    expect(parsed.searchParams.get("search_lang")).toBe("en");
    expect(parsed.searchParams.get("safesearch")).toBe("strict");
    expect(parsed.searchParams.get("freshness")).toBe("pw");
  });

  it("omits empty-string options from URL", async () => {
    const mockFetch = mockFetchResponse({ web: { results: [] } });
    globalThis.fetch = mockFetch;

    await braveSearch("test", { country: "", freshness: "" });

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.has("country")).toBe(false);
    expect(parsed.searchParams.has("freshness")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/brave-search && pnpm test:run 2>&1 | tee /tmp/brave-search-test-1.txt`

Expected: All tests FAIL because `braveSearch` doesn't exist yet.

- [ ] **Step 3: Commit**

```bash
git add packages/brave-search/src/braveSearch.test.ts
git commit -m "add unit tests for braveSearch"
```

---

### Task 3: Implement the TS core

**Files:**
- Create: `packages/brave-search/src/braveSearch.ts`

- [ ] **Step 1: Write the implementation**

```typescript
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export type BraveSearchResult = {
  title: string;
  url: string;
  description: string;
};

export type BraveSearchOptions = {
  apiKey?: string;
  count?: number;
  country?: string;
  searchLang?: string;
  safesearch?: string;
  freshness?: string;
};

export async function braveSearch(
  query: string,
  options?: BraveSearchOptions
): Promise<BraveSearchResult[]> {
  // Note: using || (not ??) so empty strings from Agency defaults fall through to env var
  const apiKey = options?.apiKey || process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Brave Search API key. Set BRAVE_API_KEY env var or pass apiKey option."
    );
  }

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(options?.count ?? 5));

  if (options?.country) url.searchParams.set("country", options.country);
  if (options?.searchLang) url.searchParams.set("search_lang", options.searchLang);
  if (options?.safesearch) url.searchParams.set("safesearch", options.safesearch);
  if (options?.freshness) url.searchParams.set("freshness", options.freshness);

  const response = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brave Search API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  const results = data?.web?.results ?? [];

  return results.map((r: Record<string, unknown>) => ({
    title: r.title as string,
    url: r.url as string,
    description: r.description as string,
  }));
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd packages/brave-search && pnpm test:run 2>&1 | tee /tmp/brave-search-test-2.txt`

Expected: All 9 tests PASS.

- [ ] **Step 3: Verify the TypeScript compiles**

Run: `cd packages/brave-search && pnpm build`

Expected: Clean compilation, `dist/src/braveSearch.js` and `dist/src/braveSearch.d.ts` are generated.

- [ ] **Step 4: Commit**

```bash
git add packages/brave-search/src/braveSearch.ts
git commit -m "implement braveSearch TypeScript core"
```

---

### Task 4: Write the Agency wrapper

**Files:**
- Create: `packages/brave-search/index.agency`

- [ ] **Step 1: Create `packages/brave-search/index.agency`**

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

- [ ] **Step 2: Verify it parses**

Run: `cd packages/brave-search && pnpm run --filter agency-lang ast index.agency`

If pnpm filtering doesn't work, run from the agency-lang package: `cd packages/agency-lang && pnpm run ast ../../packages/brave-search/index.agency`

Expected: Valid AST output (no parse errors).

- [ ] **Step 3: Commit**

```bash
git add packages/brave-search/index.agency
git commit -m "add Agency wrapper for braveSearch"
```

---

### Task 5: Write integration test

**Files:**
- Create: `packages/brave-search/tests/agency/brave-search.agency`

- [ ] **Step 1: Create the integration test**

This test calls `braveSearch` directly (no LLM) and checks the result shape. It requires a real `BRAVE_API_KEY`.

```
import { braveSearch } from "../../index.agency"

node main() {
  let results = braveSearch("TypeScript programming language")
  let first = results[0]
  print(first.title)
  print(first.url)
  print(first.description)
  print(results)
}
```

- [ ] **Step 2: Run the integration test (manual, requires API key)**

Run: `cd packages/brave-search && BRAVE_API_KEY=<your-key> pnpm run test:agency 2>&1 | tee /tmp/brave-search-integration.txt`

Expected: Prints an array of search results with title, url, and description fields. Verify the output looks correct.

Note: Skip this step if no API key is available. The unit tests in Task 2/3 cover the logic without needing a key.

- [ ] **Step 3: Commit**

```bash
git add packages/brave-search/tests/agency/brave-search.agency
git commit -m "add integration test for braveSearch"
```

---

### Task 6: Wire into workspace and verify end-to-end build

- [ ] **Step 1: Install workspace dependencies**

Run: `pnpm install` (from repo root)

Expected: `@agency-lang/brave-search` appears in the workspace packages.

- [ ] **Step 2: Build the package**

Run: `cd packages/brave-search && pnpm build`

Expected: Clean compilation.

- [ ] **Step 3: Run all unit tests**

Run: `cd packages/brave-search && pnpm test:run 2>&1 | tee /tmp/brave-search-test-final.txt`

Expected: All tests pass.

- [ ] **Step 4: Verify nothing is broken in the rest of the repo**

Run: `cd packages/agency-lang && pnpm test:run 2>&1 | tee /tmp/agency-lang-test.txt`

Expected: Existing tests still pass. The new package should have no effect on existing code.

- [ ] **Step 5: Commit any remaining changes (lockfile, etc.)**

```bash
git add -A
git commit -m "wire @agency-lang/brave-search into workspace"
```
