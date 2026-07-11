import { describe, it, expect } from "vitest";
import { formatTypeHint } from "./formatType.js";
import { VariableType } from "@/types.js";

const alias = (name: string): VariableType => ({
  type: "typeAliasVariable",
  aliasName: name,
});

describe("formatTypeHint array-element paren rules", () => {
  // Each case must re-parse as written; the bare forms re-parse with
  // the [] binding to the last operand only.
  it("parenthesizes a union element: (A | B)[]", () => {
    expect(
      formatTypeHint({
        type: "arrayType",
        elementType: { type: "unionType", types: [alias("A"), alias("B")] },
      }),
    ).toBe("(A | B)[]");
  });

  it("parenthesizes an intersection element: (A & B)[]", () => {
    expect(
      formatTypeHint({
        type: "arrayType",
        elementType: {
          type: "intersectionType",
          types: [alias("A"), alias("B")],
        },
      }),
    ).toBe("(A & B)[]");
  });

  it("parenthesizes a keyof element: (keyof A)[]", () => {
    expect(
      formatTypeHint({
        type: "arrayType",
        elementType: { type: "keyofType", operand: alias("A") },
      }),
    ).toBe("(keyof A)[]");
  });

  it("leaves a plain element bare: A[]", () => {
    expect(
      formatTypeHint({ type: "arrayType", elementType: alias("A") }),
    ).toBe("A[]");
  });
});
