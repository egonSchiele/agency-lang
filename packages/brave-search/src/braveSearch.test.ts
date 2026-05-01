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
