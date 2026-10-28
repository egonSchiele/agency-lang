import { afterEach, describe, expect, it, vi } from "vitest";
import { _article } from "./wikipedia.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("_article", () => {
  // "Grant Sanderson" redirects to "3Blue1Brown". Without redirects=1 the
  // API answers with the redirect page, whose extract is empty, and the
  // model concluded Wikipedia had nothing.
  it("asks the API to follow redirects and returns the target article", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          query: {
            redirects: [{ from: "Grant Sanderson", to: "3Blue1Brown" }],
            pages: { "123": { title: "3Blue1Brown", extract: "3Blue1Brown is a channel." } },
          },
        }),
      );
    });
    const article = await _article("Grant Sanderson");
    expect(new URL(urls[0]).searchParams.get("redirects")).toBe("1");
    expect(article).toEqual({
      title: "3Blue1Brown",
      text: "3Blue1Brown is a channel.",
      url: "https://en.wikipedia.org/wiki/3Blue1Brown",
    });
  });
});
