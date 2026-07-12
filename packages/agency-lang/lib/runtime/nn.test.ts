import { describe, it, expect } from "vitest";
import { __nn } from "./nn.js";

describe("__nn", () => {
  it("collapses undefined and null to null", () => {
    expect(__nn(undefined)).toBe(null);
    expect(__nn(null)).toBe(null);
  });

  it("passes non-nullish values through unchanged, including falsy ones", () => {
    expect(__nn(0)).toBe(0);
    expect(__nn("")).toBe("");
    expect(__nn(false)).toBe(false);
    expect(__nn(5)).toBe(5);
    expect(__nn("a")).toBe("a");
    expect(Number.isNaN(__nn(NaN))).toBe(true);
  });

  it("returns the same object reference for objects", () => {
    const obj = { x: 1 };
    expect(__nn(obj)).toBe(obj);
  });
});
