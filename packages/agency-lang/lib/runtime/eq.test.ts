import { describe, it, expect } from "vitest";
import { __eq } from "./eq.js";

describe("__eq", () => {
  it("treats null and undefined as equal", () => {
    expect(__eq(null, undefined)).toBe(true);
    expect(__eq(undefined, null)).toBe(true);
    expect(__eq(null, null)).toBe(true);
    expect(__eq(undefined, undefined)).toBe(true);
  });

  it("keeps non-nullish values distinct from nullish", () => {
    expect(__eq(0, null)).toBe(false);
    expect(__eq(0, undefined)).toBe(false);
    expect(__eq("", null)).toBe(false);
    expect(__eq(false, null)).toBe(false);
    expect(__eq(5, null)).toBe(false);
  });

  it("matches === for non-nullish values", () => {
    expect(__eq(5, 5)).toBe(true);
    expect(__eq("a", "a")).toBe(true);
    expect(__eq(5, 6)).toBe(false);
    expect(__eq("a", "b")).toBe(false);
    const obj = { x: 1 };
    expect(__eq(obj, obj)).toBe(true);
    expect(__eq({ x: 1 }, { x: 1 })).toBe(false); // reference equality
    expect(__eq(NaN, NaN)).toBe(false); // same as ===
  });

  it("is symmetric for any value against null vs undefined", () => {
    for (const x of [0, "", false, 5, "a", null, undefined, NaN]) {
      expect(__eq(x, null)).toBe(__eq(x, undefined));
    }
  });
});
