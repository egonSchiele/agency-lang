import { describe, it, expect } from "vitest";
import { z } from "zod";
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
    const result = mapTypeToValidationSchema({ type: "primitiveType", value: "regex" }, {});
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
    expect(result).toBe("z.record(z.string(), z.record(z.string(), z.number()))");
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
  const tag = (name: string, args: any[]): Tag => ({ type: "tag", name, arguments: args }) as Tag;

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

  it("merges stacked @jsonSchema tags into a single .meta(...) call", () => {
    const tags = [
      tag("jsonSchema", [obj({ format: stringLit("email") })]),
      tag("jsonSchema", [obj({ description: stringLit("user email") })]),
    ];
    const out = appendMeta("z.string()", tags);
    expect(out).toMatch(/format:\s*"email"/);
    expect(out).toMatch(/description:\s*"user email"/);
  });

  it("merges multiple object-literal arguments inside a single @jsonSchema tag", () => {
    const tags = [
      tag("jsonSchema", [
        obj({ format: stringLit("email") }),
        obj({ description: stringLit("user email") }),
      ]),
    ];
    const out = appendMeta("z.string()", tags);
    expect(out).toMatch(/format:\s*"email"/);
    expect(out).toMatch(/description:\s*"user email"/);
  });
});

describe("optional-key coalescing (validation mapper)", () => {
  const optionalStringObj: VariableType = {
    type: "objectType",
    properties: [
      {
        key: "foo",
        value: {
          type: "unionType",
          types: [
            { type: "primitiveType", value: "string" },
            { type: "primitiveType", value: "null" },
          ],
        },
      },
    ],
  };

  it("validation mapper makes a T | null key optional and coalesces to null", () => {
    const out = mapTypeToValidationSchema(optionalStringObj, {});
    expect(out).toContain(".optional().default(null)");
  });

  it("LLM mapper keeps a T | null key required (no optional/default)", () => {
    const out = mapTypeToZodSchema(optionalStringObj, {});
    expect(out).not.toContain(".optional()");
    expect(out).not.toContain(".default(null)");
  });

  it("keeps .meta() the final call in the chain for a tagged optional key", () => {
    const objWithTaggedOptional: VariableType = {
      type: "objectType",
      properties: [
        {
          key: "foo",
          value: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "null" },
            ],
            tags: [
              {
                type: "tag",
                name: "jsonSchema",
                arguments: [
                  {
                    type: "agencyObject",
                    entries: [
                      {
                        key: "description",
                        value: { type: "string", segments: [{ type: "text", value: "a foo" }] },
                      },
                    ],
                  },
                ],
              } as unknown as Tag,
            ],
          },
        },
      ],
    };
    const out = mapTypeToValidationSchema(objWithTaggedOptional, {});
    // .meta(...) must be the last call — it must appear AFTER .default(null),
    // otherwise Zod drops the metadata from toJSONSchema().
    expect(out).toContain(".default(null).meta(");
  });
});

describe("never (bottom type) maps to z.never()", () => {
  const never: VariableType = { type: "primitiveType", value: "never" };

  it("maps never to z.never() on the LLM path", () => {
    expect(mapTypeToZodSchema(never, {})).toBe("z.never()");
  });

  it("maps never to z.never() on the validation path", () => {
    expect(mapTypeToValidationSchema(never, {})).toBe("z.never()");
  });
});

// Agency reads a string literal type up to the next quote, so its value can
// end in a backslash. Written between quotes unescaped, that backslash would
// end the TypeScript string early and let the next literal run as code.
describe("string literal types are written as escaped TypeScript strings", () => {
  const literal = (value: string): VariableType => ({ type: "stringLiteralType", value });
  const evaluate = (schemaText: string) => new Function("z", `return ${schemaText}`)(z);

  it("keeps a trailing backslash inside the string", () => {
    const schema = evaluate(mapTypeToValidationSchema(literal("x\\"), {}));
    expect(schema.safeParse("x\\").success).toBe(true);
  });

  it("keeps a line break inside the string", () => {
    const schema = evaluate(mapTypeToValidationSchema(literal("a\nb"), {}));
    expect(schema.safeParse("a\nb").success).toBe(true);
  });

  it("never runs a later literal as code", () => {
    const objectType: VariableType = {
      type: "objectType",
      properties: [
        { key: "a", value: literal("x\\") },
        { key: "in", value: literal(" + (globalThis.__literalEscapeProbe = 1) + ") },
        { key: "instanceof", value: literal(") }) //") },
      ],
    };
    const schema = evaluate(mapTypeToValidationSchema(objectType, {}));
    expect((globalThis as Record<string, unknown>).__literalEscapeProbe).toBe(undefined);
    const value = {
      a: "x\\",
      in: " + (globalThis.__literalEscapeProbe = 1) + ",
      instanceof: ") }) //",
    };
    expect(schema.safeParse(value).success).toBe(true);
  });
});

describe("property descriptions are written as escaped TypeScript strings", () => {
  const evaluate = (schemaText: string) => new Function("z", `return ${schemaText}`)(z);
  const described = (description: string): VariableType => ({
    type: "objectType",
    properties: [{ key: "a", value: { type: "primitiveType", value: "string" }, description }],
  });

  it("keeps a trailing backslash and a line break inside the description", () => {
    const schema = evaluate(mapTypeToValidationSchema(described("path C:\\\nnext"), {}));
    expect(schema.shape.a.description).toBe("path C:\\\nnext");
  });

  it("never runs a description as code", () => {
    const payload = 'x\\", in: " + (globalThis.__descriptionEscapeProbe = 1) + "';
    const schema = evaluate(mapTypeToValidationSchema(described(payload), {}));
    expect((globalThis as Record<string, unknown>).__descriptionEscapeProbe).toBe(undefined);
    expect(schema.shape.a.description).toBe(payload);
  });
});
