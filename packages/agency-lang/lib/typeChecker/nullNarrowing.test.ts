import { describe, it, expect } from "vitest";
import { narrowUnionByPresence } from "./narrowing.js";
import { NULL_T, STRING_T, NUMBER_T } from "./primitives.js";
import type { VariableType } from "../types.js";

const union = (...types: VariableType[]): VariableType => ({
  type: "unionType",
  types,
});

describe("narrowUnionByPresence", () => {
  const strOrNull = union(STRING_T, NULL_T);

  it("present: true strips the null member (string | null → string)", () => {
    expect(narrowUnionByPresence(strOrNull, true, {})).toEqual(STRING_T);
  });

  it("present: false keeps only null (string | null → null)", () => {
    expect(narrowUnionByPresence(strOrNull, false, {})).toEqual(NULL_T);
  });

  it("present: true on a 3-member union drops only null (string | number | null → string | number)", () => {
    expect(
      narrowUnionByPresence(union(STRING_T, NUMBER_T, NULL_T), true, {}),
    ).toEqual(union(STRING_T, NUMBER_T));
  });

  it("present: true with no null member → null (no narrowing)", () => {
    expect(narrowUnionByPresence(union(STRING_T, NUMBER_T), true, {})).toBeNull();
  });

  it("present: false with no null member → null (no narrowing, no narrow-to-never)", () => {
    expect(narrowUnionByPresence(union(STRING_T, NUMBER_T), false, {})).toBeNull();
  });

  it("non-union type → null (no narrowing)", () => {
    expect(narrowUnionByPresence(STRING_T, true, {})).toBeNull();
  });

  it("present: true on a union of only-null members → null (hits the empty-kept guard, no narrow-to-never)", () => {
    // All members are null; stripping them would leave `never`, so return null.
    // (NULL_T alone is a primitive, not a union, and bails at the first guard —
    // this exercises the `kept.length === 0` guard specifically.)
    expect(narrowUnionByPresence(union(NULL_T, NULL_T), true, {})).toBeNull();
  });
});
