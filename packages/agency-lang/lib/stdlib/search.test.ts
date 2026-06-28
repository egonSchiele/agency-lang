import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _search, _tavilySearch } from "./search.js";

const FAKE_KEY = "test-brave-api-key";

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe("_search", () => {
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

    await _search("test query");

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
    expect(parsed.searchParams.get("q")).toBe("test query");
    expect(parsed.searchParams.get("count")).toBe("5");
  });

  it("sends API key in X-Subscription-Token header", async () => {
    const mockFetch = mockFetchResponse({ web: { results: [] } });
    globalThis.fetch = mockFetch;

    await _search("test");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Subscription-Token"]).toBe(FAKE_KEY);
  });

  it("uses apiKey option over env var", async () => {
    const mockFetch = mockFetchResponse({ web: { results: [] } });
    globalThis.fetch = mockFetch;

    await _search("test", { apiKey: "override-key" });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Subscription-Token"]).toBe("override-key");
  });

  it("maps response to SearchResult array", async () => {
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

    const results = await _search("test");

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
    const results = await _search("test");
    expect(results).toEqual([]);
  });

  it("returns empty array when web field is missing", async () => {
    globalThis.fetch = mockFetchResponse({});
    const results = await _search("test");
    expect(results).toEqual([]);
  });

  it("throws when no API key is available", async () => {
    delete process.env.BRAVE_API_KEY;
    await expect(_search("test")).rejects.toThrow("BRAVE_API_KEY");
  });

  it("throws on non-200 response with status and body", async () => {
    globalThis.fetch = mockFetchResponse(
      { message: "Rate limit exceeded" },
      429,
    );

    await expect(_search("test")).rejects.toThrow(
      "Brave Search API error (429)",
    );
  });

  it("includes optional params in URL when provided", async () => {
    const mockFetch = mockFetchResponse({ web: { results: [] } });
    globalThis.fetch = mockFetch;

    await _search("test", {
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

    await _search("test", { country: "", freshness: "" });

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.has("country")).toBe(false);
    expect(parsed.searchParams.has("freshness")).toBe(false);
  });
});

const FAKE_TAVILY_KEY = "tvly-test-key";

describe("_tavilySearch", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    process.env.TAVILY_API_KEY = FAKE_TAVILY_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.TAVILY_API_KEY = originalEnv;
    } else {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("POSTs to the Tavily search endpoint with query and default max_results", async () => {
    const mockFetch = mockFetchResponse({ results: [] });
    globalThis.fetch = mockFetch;

    await _tavilySearch("test query");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.query).toBe("test query");
    expect(body.max_results).toBe(5);
  });

  it("sends API key as a Bearer token", async () => {
    const mockFetch = mockFetchResponse({ results: [] });
    globalThis.fetch = mockFetch;

    await _tavilySearch("test");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_TAVILY_KEY}`);
  });

  it("uses apiKey option over env var", async () => {
    const mockFetch = mockFetchResponse({ results: [] });
    globalThis.fetch = mockFetch;

    await _tavilySearch("test", { apiKey: "tvly-override" });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer tvly-override");
  });

  it("maps Tavily results (content -> description) to SearchResult array", async () => {
    globalThis.fetch = mockFetchResponse({
      answer: "ignored",
      results: [
        {
          title: "Example",
          url: "https://example.com",
          content: "An example snippet",
          score: 0.98,
          raw_content: "ignored",
        },
      ],
    });

    const results = await _tavilySearch("test");

    expect(results).toEqual([
      {
        title: "Example",
        url: "https://example.com",
        description: "An example snippet",
      },
    ]);
  });

  it("returns empty array when no results", async () => {
    globalThis.fetch = mockFetchResponse({ results: [] });
    const results = await _tavilySearch("test");
    expect(results).toEqual([]);
  });

  it("returns empty array when results field is missing", async () => {
    globalThis.fetch = mockFetchResponse({});
    const results = await _tavilySearch("test");
    expect(results).toEqual([]);
  });

  it("throws when no API key is available", async () => {
    delete process.env.TAVILY_API_KEY;
    await expect(_tavilySearch("test")).rejects.toThrow("TAVILY_API_KEY");
  });

  it("throws on non-200 response with status and body", async () => {
    globalThis.fetch = mockFetchResponse({ detail: "Unauthorized" }, 401);

    await expect(_tavilySearch("test")).rejects.toThrow(
      "Tavily Search API error (401)",
    );
  });

  it("includes optional params in the body when provided", async () => {
    const mockFetch = mockFetchResponse({ results: [] });
    globalThis.fetch = mockFetch;

    await _tavilySearch("test", {
      count: 10,
      searchDepth: "advanced",
      topic: "news",
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_results).toBe(10);
    expect(body.search_depth).toBe("advanced");
    expect(body.topic).toBe("news");
  });

  it("omits empty-string options from the body", async () => {
    const mockFetch = mockFetchResponse({ results: [] });
    globalThis.fetch = mockFetch;

    await _tavilySearch("test", { searchDepth: "", topic: "" });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect("search_depth" in body).toBe(false);
    expect("topic" in body).toBe(false);
  });
});
