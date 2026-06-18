import { describe, expect, it } from "vitest";

import { getPath } from "./getPath.js";

describe("getPath", () => {
  it("reads a nested object path", () => {
    expect(getPath({ metadata: { expectedOutput: "New Delhi" } }, ["metadata", "expectedOutput"])).toBe("New Delhi");
  });

  it("reads an array index", () => {
    expect(getPath({ items: ["a", "b", "c"] }, ["items", 1])).toBe("b");
  });

  it("returns undefined for a missing key", () => {
    expect(getPath({ metadata: {} }, ["metadata", "expectedOutput"])).toBeUndefined();
  });

  it("returns undefined when descending into a non-object", () => {
    expect(getPath({ a: 5 }, ["a", "b"])).toBeUndefined();
  });

  it("returns undefined for null/undefined roots", () => {
    expect(getPath(null, ["a"])).toBeUndefined();
    expect(getPath(undefined, ["a"])).toBeUndefined();
  });

  it("returns the root for an empty path", () => {
    expect(getPath("hi", [])).toBe("hi");
  });
});
