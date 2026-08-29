import { describe, it, expect } from "vitest";
import { _urlHost } from "./system.js";

describe("_urlHost", () => {
  it("returns the hostname of a URL", () => {
    expect(_urlHost("https://example.com/a/b?c=d")).toBe("example.com");
  });

  it("returns an empty string for a non-URL", () => {
    expect(_urlHost("not a url")).toBe("");
  });
});
