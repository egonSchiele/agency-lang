import { describe, it, expect } from "vitest";
import { mapTypeToZodSchema, mapTypeToValidationSchema } from "./typeToZodSchema.js";
import { VariableType } from "../../types.js";

describe("mapTypeToZodSchema", () => {
  it("should return the alias name directly for typeAliasVariable", () => {
    const variableType: VariableType = {
      type: "typeAliasVariable",
      aliasName: "MathResult",
    };
    const typeAliases = {
      MathResult: {
        type: "objectType" as const,
        properties: [{ key: "answer", value: { type: "primitiveType" as const, value: "number" } }],
      },
    };
    const result = mapTypeToZodSchema(variableType, typeAliases);
    expect(result).toBe("MathResult");
  });

  it("should return the alias name in nested contexts", () => {
    const variableType: VariableType = {
      type: "objectType",
      properties: [
        { key: "result", value: { type: "typeAliasVariable" as const, aliasName: "Coords" } },
      ],
    };
    const typeAliases = {
      Coords: {
        type: "objectType" as const,
        properties: [
          { key: "x", value: { type: "primitiveType" as const, value: "number" } },
          { key: "y", value: { type: "primitiveType" as const, value: "number" } },
        ],
      },
    };
    const result = mapTypeToZodSchema(variableType, typeAliases);
    expect(result).toBe(`z.object({ "result": Coords })`);
  });

  it("should return the alias name inside an array type", () => {
    const variableType: VariableType = {
      type: "arrayType",
      elementType: { type: "typeAliasVariable" as const, aliasName: "Item" },
    };
    const typeAliases = {
      Item: {
        type: "objectType" as const,
        properties: [{ key: "name", value: { type: "primitiveType" as const, value: "string" } }],
      },
    };
    const result = mapTypeToZodSchema(variableType, typeAliases);
    expect(result).toBe("z.array(Item)");
  });

  it("should return the alias name inside a union type", () => {
    const variableType: VariableType = {
      type: "unionType",
      types: [
        { type: "typeAliasVariable" as const, aliasName: "Foo" },
        { type: "primitiveType" as const, value: "number" },
      ],
    };
    const typeAliases = {
      Foo: { type: "primitiveType" as const, value: "string" },
    };
    const result = mapTypeToZodSchema(variableType, typeAliases);
    expect(result).toBe("z.union([Foo, z.number()])");
  });
});

describe("mapTypeToValidationSchema", () => {
  it("should return the alias name directly for typeAliasVariable", () => {
    const variableType: VariableType = {
      type: "typeAliasVariable",
      aliasName: "Category",
    };
    const typeAliases = {
      Category: {
        type: "unionType" as const,
        types: [
          { type: "stringLiteralType" as const, value: "bug" },
          { type: "stringLiteralType" as const, value: "feature" },
        ],
      },
    };
    const result = mapTypeToValidationSchema(variableType, typeAliases);
    expect(result).toBe("Category");
  });

  it("maps the regex primitive to z.instanceof(RegExp)", () => {
    const result = mapTypeToValidationSchema(
      { type: "primitiveType", value: "regex" },
      {},
    );
    expect(result).toBe("z.instanceof(RegExp)");
  });

  it("maps regex inside an object property", () => {
    const result = mapTypeToValidationSchema(
      {
        type: "objectType",
        properties: [{ key: "pattern", value: { type: "primitiveType", value: "regex" } }],
      },
      {},
    );
    expect(result).toBe(`z.object({ "pattern": z.instanceof(RegExp) })`);
  });
});
