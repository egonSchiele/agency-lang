import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPage } from "./fetchPage.js";

const SAMPLE_ARTICLE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test Article</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <article>
    <h1>Test Article Title</h1>
    <p>This is the first paragraph of the article with enough text to be considered content by readability. It needs to be reasonably long so the algorithm picks it up as the main article body.</p>
    <p>This is the second paragraph with more content. Readability needs a substantial amount of text to determine that this is indeed an article worth extracting from the page.</p>
    <p>Here is a third paragraph. The more content we add, the more confident Readability will be that this is the main content of the page and not just some sidebar or navigation element.</p>
    <h2>A Subheading</h2>
    <p>More content under the subheading. This paragraph provides additional depth to the article, covering more details about the topic at hand.</p>
    <ul>
      <li>First item in a list</li>
      <li>Second item in a list</li>
    </ul>
    <p>A paragraph with <strong>bold text</strong> and <em>italic text</em> and <code>inline code</code>.</p>
    <p>A paragraph with a <a href="https://example.com">link to example</a>.</p>
  </article>
  <footer><p>Copyright 2026</p></footer>
</body>
</html>
`;

const MINIMAL_HTML = `
<!DOCTYPE html>
<html><head><title>Minimal</title></head>
<body></body>
</html>
`;

function mockFetchResponse(body: string, options: { status?: number; contentType?: string; url?: string } = {}) {
  const { status = 200, contentType = "text/html", url = "https://example.com" } = options;
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    url,
    headers: new Headers({ "content-type": contentType }),
    text: async () => body,
  });
}

describe("fetchPage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts title, content, and excerpt from article HTML", async () => {
    globalThis.fetch = mockFetchResponse(SAMPLE_ARTICLE_HTML);

    const result = await fetchPage("https://example.com/article");

    expect(result.title).toBe("Test Article");
    expect(result.content).toContain("first paragraph");
    expect(result.content).toContain("second paragraph");
    expect(result.excerpt).toBeTruthy();
    expect(result.url).toBe("https://example.com");
  });

  it("converts extracted HTML to markdown", async () => {
    globalThis.fetch = mockFetchResponse(SAMPLE_ARTICLE_HTML);

    const result = await fetchPage("https://example.com/article");

    expect(result.content).toContain("## A Subheading");
    expect(result.content).toContain("**bold text**");
    expect(result.content).toContain("*italic text*");
    expect(result.content).toContain("`inline code`");
    expect(result.content).toContain("[link to example](https://example.com)");
    expect(result.content).toContain("- First item in a list");
  });

  it("truncates content to maxChars", async () => {
    globalThis.fetch = mockFetchResponse(SAMPLE_ARTICLE_HTML);

    const result = await fetchPage("https://example.com/article", { maxChars: 50 });

    expect(result.content.length).toBeLessThanOrEqual(50);
  });

  it("returns full content when under maxChars", async () => {
    globalThis.fetch = mockFetchResponse(SAMPLE_ARTICLE_HTML);

    const result = await fetchPage("https://example.com/article", { maxChars: 100000 });

    expect(result.content).toContain("first paragraph");
    expect(result.content).toContain("A Subheading");
  });

  it("throws on non-200 HTTP response", async () => {
    globalThis.fetch = mockFetchResponse("Not Found", { status: 404 });

    await expect(fetchPage("https://example.com/missing")).rejects.toThrow(
      "Fetch error (404)"
    );
  });

  it("throws on non-HTML content type", async () => {
    globalThis.fetch = mockFetchResponse("%PDF-1.4", { contentType: "application/pdf" });

    await expect(fetchPage("https://example.com/file.pdf")).rejects.toThrow(
      "Expected HTML but got application/pdf"
    );
  });

  it("throws when Readability cannot extract content", async () => {
    globalThis.fetch = mockFetchResponse(MINIMAL_HTML);

    await expect(fetchPage("https://example.com/empty")).rejects.toThrow(
      "no extractable content"
    );
  });

  it("passes through the final URL from response.url", async () => {
    globalThis.fetch = mockFetchResponse(SAMPLE_ARTICLE_HTML, {
      url: "https://example.com/redirected",
    });

    const result = await fetchPage("https://example.com/original");

    expect(result.url).toBe("https://example.com/redirected");
  });

  it("handles pages with missing title/excerpt gracefully", async () => {
    const htmlNoTitle = `
      <!DOCTYPE html>
      <html><head></head>
      <body><article>
        <p>This is a long enough article body that readability should pick it up as the main content. We need several sentences to ensure detection works properly.</p>
        <p>Adding another paragraph to make sure readability has enough content to work with. This should be sufficient for extraction.</p>
        <p>And one more paragraph for good measure. Readability typically needs a fair amount of text before it considers something article-worthy.</p>
      </article></body>
      </html>
    `;
    globalThis.fetch = mockFetchResponse(htmlNoTitle);

    const result = await fetchPage("https://example.com/no-title");

    expect(typeof result.title).toBe("string");
    expect(typeof result.excerpt).toBe("string");
  });

  it("sends a browser-like User-Agent header", async () => {
    const mockFetch = mockFetchResponse(SAMPLE_ARTICLE_HTML);
    globalThis.fetch = mockFetch;

    await fetchPage("https://example.com");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toContain("Mozilla/5.0");
  });

  it("uses AbortSignal.timeout for fetch timeout", async () => {
    const mockFetch = mockFetchResponse(SAMPLE_ARTICLE_HTML);
    globalThis.fetch = mockFetch;

    await fetchPage("https://example.com", { timeout: 5000 });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeDefined();
  });

  it("throws on fetch timeout", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new DOMException("The operation was aborted", "TimeoutError")
    );

    await expect(fetchPage("https://example.com")).rejects.toThrow("aborted");
  });
});
