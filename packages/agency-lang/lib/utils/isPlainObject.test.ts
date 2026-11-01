import { describe, expect, it } from "vitest";
import { isPlainObject } from "./isPlainObject.js";

describe("isPlainObject", () => {
  it("is true only for non-array objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});
