import { describe, it, expect } from "vitest";
import { isContained } from "./isContained.js";

describe("isContained", () => {
  it("compares whole path components", () => {
    expect(isContained("/a/b", "/a/b")).toBe(true);
    expect(isContained("/a/b/c", "/a/b")).toBe(true);
    expect(isContained("/a/bc", "/a/b")).toBe(false);
    expect(isContained("/x", "/a/b")).toBe(false);
    expect(isContained("/a/b", "/")).toBe(true);
  });
});
