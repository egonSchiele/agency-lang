import { describe, it, expect } from "vitest";
import { _urlHost } from "./system.js";

describe("_urlHost", () => {
  it("returns the hostname of a URL", () => {
    expect(_urlHost("https://example.com/a/b?c=d")).toBe("example.com");
  });

  it("returns the whole string when there is no hostname", () => {
    expect(_urlHost("not a url")).toBe("not a url");
    expect(_urlHost("mailto:user@example.com")).toBe("mailto:user@example.com");
  });
});
