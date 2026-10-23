import { describe, expect, it } from "vitest";

import { citedUrls } from "./researchGraders.js";

describe("citedUrls", () => {
  it("keeps a closing paren that the URL opened", () => {
    expect(citedUrls("see https://en.wikipedia.org/wiki/Amnesiac_(album) for more")).toEqual([
      "https://en.wikipedia.org/wiki/Amnesiac_(album)",
    ]);
  });

  it("drops a closing paren the sentence put after the URL", () => {
    expect(citedUrls("(interview at https://example.com/a).")).toEqual(["https://example.com/a"]);
    expect(citedUrls("[text](https://example.com/b)")).toEqual(["https://example.com/b"]);
  });

  it("stops at markdown emphasis, code spans, and brackets", () => {
    expect(
      citedUrls(
        "**https://example.com/a** and `https://example.com/b` and <https://example.com/c>",
      ),
    ).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
  });

  it("trims sentence punctuation and keeps each URL once", () => {
    expect(
      citedUrls("https://example.com/a, https://example.com/a; https://example.com/b."),
    ).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
});
