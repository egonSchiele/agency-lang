import { describe, it, expect } from "vitest";
import { isAssignable } from "./assignability.js";
import { NULL_T } from "./primitives.js";
import type { VariableType } from "../types.js";

describe("nullish unification in the type checker", () => {
  const STRING_T: VariableType = { type: "primitiveType", value: "string" };

  it("NULL_T is the null primitive", () => {
    expect(NULL_T).toEqual({ type: "primitiveType", value: "null" });
  });

  it("null is assignable to string | null", () => {
    const target: VariableType = {
      type: "unionType",
      types: [STRING_T, NULL_T],
    };
    expect(isAssignable(NULL_T, target, {})).toBe(true);
  });
});
