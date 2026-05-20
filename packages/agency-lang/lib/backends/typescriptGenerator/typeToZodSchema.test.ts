import { describe, it, expect } from "vitest";
import { mapTypeToZodSchema, mapTypeToValidationSchema, appendMeta } from "./typeToZodSchema.js";
import { VariableType } from "../../types.js";
import type { Tag } from "../../types/tag.js";

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

describe("mapTypeToZodSchema: Record<K, V>", () => {
  it("emits z.record for Record<string, number>", () => {
    const result = mapTypeToZodSchema(
      {
        type: "genericType",
        name: "Record",
        typeArgs: [
          { type: "primitiveType", value: "string" },
          { type: "primitiveType", value: "number" },
        ],
      },
      {},
    );
    expect(result).toBe("z.record(z.string(), z.number())");
  });

  it("emits z.record nested inside z.array", () => {
    const result = mapTypeToZodSchema(
      {
        type: "arrayType",
        elementType: {
          type: "genericType",
          name: "Record",
          typeArgs: [
            { type: "primitiveType", value: "string" },
            { type: "primitiveType", value: "string" },
          ],
        },
      },
      {},
    );
    expect(result).toBe("z.array(z.record(z.string(), z.string()))");
  });

  it("emits nested z.record for Record<string, Record<string, number>>", () => {
    const result = mapTypeToZodSchema(
      {
        type: "genericType",
        name: "Record",
        typeArgs: [
          { type: "primitiveType", value: "string" },
          {
            type: "genericType",
            name: "Record",
            typeArgs: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "number" },
            ],
          },
        ],
      },
      {},
    );
    expect(result).toBe(
      "z.record(z.string(), z.record(z.string(), z.number()))",
    );
  });

  it("emits doubly-nested z.record for Record<string, Record<string, Record<string, boolean>>>", () => {
    const result = mapTypeToZodSchema(
      {
        type: "genericType",
        name: "Record",
        typeArgs: [
          { type: "primitiveType", value: "string" },
          {
            type: "genericType",
            name: "Record",
            typeArgs: [
              { type: "primitiveType", value: "string" },
              {
                type: "genericType",
                name: "Record",
                typeArgs: [
                  { type: "primitiveType", value: "string" },
                  { type: "primitiveType", value: "boolean" },
                ],
              },
            ],
          },
        ],
      },
      {},
    );
    expect(result).toBe(
      "z.record(z.string(), z.record(z.string(), z.record(z.string(), z.boolean())))",
    );
  });

  it("throws on unresolved generic types other than Record", () => {
    expect(() =>
      mapTypeToZodSchema(
        {
          type: "genericType",
          name: "Container",
          typeArgs: [{ type: "primitiveType", value: "string" }],
        },
        {},
      ),
    ).toThrow(/Unresolved generic type at codegen: Container/);
  });
});

describe("appendMeta", () => {
  const obj = (entries: Record<string, unknown>) => ({
    type: "agencyObject" as const,
    entries: Object.entries(entries).map(([key, value]) => ({
      key,
      value: value as any,
    })),
  });
  const stringLit = (s: string) => ({
    type: "string" as const,
    segments: [{ type: "text" as const, value: s }],
  });
  const tag = (name: string, args: any[]): Tag =>
    ({ type: "tag", name, arguments: args }) as Tag;

  it("returns the schema unchanged when no @jsonSchema tag is present", () => {
    expect(appendMeta("z.string()", undefined)).toBe("z.string()");
    expect(appendMeta("z.string()", [])).toBe("z.string()");
    expect(appendMeta("z.string()", [tag("validate", [])])).toBe("z.string()");
  });

  it("appends .meta(...) when a single @jsonSchema tag is present", () => {
    const tags = [tag("jsonSchema", [obj({ format: stringLit("email") })])];
    expect(appendMeta("z.string()", tags)).toContain(".meta(");
    expect(appendMeta("z.string()", tags)).toMatch(/format:\s*"email"/);
  });

  it("throws when more than one @jsonSchema is attached to the same target", () => {
    const tags = [
      tag("jsonSchema", [obj({ format: stringLit("email") })]),
      tag("jsonSchema", [obj({ description: stringLit("dup") })]),
    ];
    expect(() => appendMeta("z.string()", tags)).toThrow(/Multiple @jsonSchema/);
  });
});
