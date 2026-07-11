import { describe, it, expect } from "vitest";
import { formatTypeHint } from "./formatType.js";
import { variableTypeToString } from "@/backends/typescriptGenerator/typeToString.js";
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

describe("raises on a function type", () => {
  const anySet = { type: "primitiveType", value: "any" } as VariableType;
  const emptySet = { type: "unionType", types: [], isEffectSet: true } as unknown as VariableType;
  const readSet = {
    type: "unionType",
    isEffectSet: true,
    types: [{ type: "stringLiteralType", value: "std::read" }],
  } as unknown as VariableType;
  const fn = (raises?: VariableType): VariableType =>
    ({
      type: "blockType",
      params: [{ name: "s", typeAnnotation: { type: "primitiveType", value: "string" } }],
      returnType: { type: "primitiveType", value: "string" },
      raises,
    }) as unknown as VariableType;

  it("empty set → raises <>", () => {
    expect(formatTypeHint(fn(emptySet))).toMatch(/raises\s*<>/);
  });
  it("labels → raises <std::read>", () => {
    expect(formatTypeHint(fn(readSet))).toMatch(/raises\s*<std::read>/);
  });
  it("wildcard → raises <*>", () => {
    expect(formatTypeHint(fn(anySet))).toMatch(/raises\s*<\*>/);
  });
  it("no clause → no raises", () => {
    expect(formatTypeHint(fn(undefined))).not.toMatch(/raises/);
  });

  it("TS codegen never emits raises (forFormatting=false)", () => {
    expect(variableTypeToString(fn(readSet), {}, false)).not.toMatch(/raises/);
  });
});
