import { describe, it, expect } from "vitest";
import { referenceKey, uniteTypes } from "./flow.js";
import { NEVER_T } from "./primitives.js";
import type { VariableType } from "../types.js";

const STR: VariableType = { type: "primitiveType", value: "string" };
const NUM: VariableType = { type: "primitiveType", value: "number" };

describe("referenceKey", () => {
  it("is the bare variable for an empty chain", () => {
    expect(referenceKey({ variable: "x", chain: [] })).toBe("x");
  });
  it("dotted-joins a non-empty chain", () => {
    expect(referenceKey({ variable: "u", chain: ["profile", "email"] })).toBe("u.profile.email");
  });
});

describe("uniteTypes", () => {
  it("any dominates", () => {
    expect(uniteTypes(["any", STR], {})).toBe("any");
  });
  it("drops never members (identity element)", () => {
    expect(uniteTypes([NEVER_T, STR], {})).toEqual(STR);
  });
  it("an all-never (or empty) union is never", () => {
    expect(uniteTypes([NEVER_T, NEVER_T], {})).toEqual(NEVER_T);
    expect(uniteTypes([], {})).toEqual(NEVER_T);
  });
  it("dedupes structurally and unwraps a single member", () => {
    expect(uniteTypes([STR, STR], {})).toEqual(STR);
  });
  it("builds a union of distinct members", () => {
    expect(uniteTypes([STR, NUM], {})).toEqual({ type: "unionType", types: [STR, NUM] });
  });
  it("preserves literal members (does not widen to primitives)", () => {
    const litA: VariableType = { type: "stringLiteralType", value: "a" };
    const litB: VariableType = { type: "stringLiteralType", value: "b" };
    expect(uniteTypes([litA, litB], {})).toEqual({
      type: "unionType",
      types: [litA, litB],
    });
  });
});
