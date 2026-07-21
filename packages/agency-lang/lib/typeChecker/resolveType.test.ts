import { describe, it, expect } from "vitest";
import { resolveType, resolveTypeDeep } from "./assignability.js";
import type { TypeAliasEntry, VariableType } from "../types.js";

const stringType: VariableType = { type: "primitiveType", value: "string" };
const numberType: VariableType = { type: "primitiveType", value: "number" };
const booleanType: VariableType = {
  type: "primitiveType",
  value: "boolean",
};
const anyType: VariableType = { type: "primitiveType", value: "any" };

describe("resolveType: built-in generic Array", () => {
  it("normalizes Array<string> to arrayType", () => {
    const result = resolveType(
      { type: "genericType", name: "Array", typeArgs: [stringType] },
      {},
    );
    expect(result).toEqual({ type: "arrayType", elementType: stringType });
  });

  it("resolves nested aliases inside Array<T>", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Str: { body: stringType },
    };
    const result = resolveType(
      {
        type: "genericType",
        name: "Array",
        typeArgs: [{ type: "typeAliasVariable", aliasName: "Str" }],
      },
      aliases,
    );
    expect(result).toEqual({ type: "arrayType", elementType: stringType });
  });

  it("throws on wrong arity", () => {
    expect(() =>
      resolveType({ type: "genericType", name: "Array", typeArgs: [] }, {}),
    ).toThrow(/Array expects 1 type argument/);
    expect(() =>
      resolveType(
        {
          type: "genericType",
          name: "Array",
          typeArgs: [stringType, numberType],
        },
        {},
      ),
    ).toThrow(/Array expects 1 type argument/);
  });
});

describe("resolveType: built-in generic Schema", () => {
  it("normalizes Schema<T> to schemaType", () => {
    const result = resolveType(
      { type: "genericType", name: "Schema", typeArgs: [stringType] },
      {},
    );
    expect(result).toEqual({ type: "schemaType", inner: stringType });
  });

  it("throws on wrong arity", () => {
    expect(() =>
      resolveType(
        {
          type: "genericType",
          name: "Schema",
          typeArgs: [stringType, numberType],
        },
        {},
      ),
    ).toThrow(/Schema expects 1 type argument/);
  });
});

describe("resolveType: built-in generic Record", () => {
  it("keeps Record<string, number> as a genericType (survives to codegen)", () => {
    const input: VariableType = {
      type: "genericType",
      name: "Record",
      typeArgs: [stringType, numberType],
    };
    const result = resolveType(input, {});
    // writtenTypeArgs rides along for the validation-descriptor builder (#630).
    expect(result).toEqual({ ...input, writtenTypeArgs: [stringType, numberType] });
  });

  it("resolves aliases inside Record value position", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      N: { body: numberType },
    };
    const result = resolveType(
      {
        type: "genericType",
        name: "Record",
        typeArgs: [stringType, { type: "typeAliasVariable", aliasName: "N" }],
      },
      aliases,
    );
    expect(result).toEqual({
      type: "genericType",
      name: "Record",
      typeArgs: [stringType, numberType],
      // Written args keep the alias identity that resolution erases (#630).
      writtenTypeArgs: [
        stringType,
        { type: "typeAliasVariable", aliasName: "N" },
      ],
    });
  });

  it("accepts number as key type", () => {
    const result = resolveType(
      {
        type: "genericType",
        name: "Record",
        typeArgs: [numberType, stringType],
      },
      {},
    );
    expect(result.type).toBe("genericType");
  });

  it("accepts string literal as key type", () => {
    const result = resolveType(
      {
        type: "genericType",
        name: "Record",
        typeArgs: [
          { type: "stringLiteralType", value: "ok" },
          stringType,
        ],
      },
      {},
    );
    expect(result.type).toBe("genericType");
  });

  it("accepts union of literals as key type", () => {
    const keyUnion: VariableType = {
      type: "unionType",
      types: [
        { type: "stringLiteralType", value: "a" },
        { type: "stringLiteralType", value: "b" },
      ],
    };
    const result = resolveType(
      {
        type: "genericType",
        name: "Record",
        typeArgs: [keyUnion, stringType],
      },
      {},
    );
    expect(result.type).toBe("genericType");
  });

  it("rejects boolean key type", () => {
    expect(() =>
      resolveType(
        {
          type: "genericType",
          name: "Record",
          typeArgs: [booleanType, stringType],
        },
        {},
      ),
    ).toThrow(/Record key type must be/);
  });

  it("rejects object key type", () => {
    expect(() =>
      resolveType(
        {
          type: "genericType",
          name: "Record",
          typeArgs: [
            { type: "objectType", properties: [] },
            stringType,
          ],
        },
        {},
      ),
    ).toThrow(/Record key type must be/);
  });

  it("throws on wrong arity", () => {
    expect(() =>
      resolveType(
        { type: "genericType", name: "Record", typeArgs: [stringType] },
        {},
      ),
    ).toThrow(/Record expects 2 type arguments/);
  });
});

describe("resolveType: typeAliasVariable resolution still works", () => {
  it("resolves a plain alias to its body", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      MyStr: { body: stringType },
    };
    const result = resolveType(
      { type: "typeAliasVariable", aliasName: "MyStr" },
      aliases,
    );
    expect(result).toEqual(stringType);
  });

  it("resolves alias chain to terminal body", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      A: { body: { type: "typeAliasVariable", aliasName: "B" } },
      B: { body: stringType },
    };
    const result = resolveType(
      { type: "typeAliasVariable", aliasName: "A" },
      aliases,
    );
    expect(result).toEqual(stringType);
  });

  it("returns the alias unchanged when not in registry", () => {
    const result = resolveType(
      { type: "typeAliasVariable", aliasName: "Unknown" },
      {},
    );
    expect(result).toEqual({
      type: "typeAliasVariable",
      aliasName: "Unknown",
    });
  });
});

describe("resolveType: passthrough for unrelated variants", () => {
  it("returns primitives unchanged", () => {
    expect(resolveType(stringType, {})).toEqual(stringType);
    expect(resolveType(anyType, {})).toEqual(anyType);
  });
});

describe("resolveType: user-defined generic aliases", () => {
  it("substitutes T in a simple Container<T>", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Container: {
        body: {
          type: "objectType",
          properties: [
            {
              key: "value",
              value: { type: "typeAliasVariable", aliasName: "T" },
            },
          ],
        },
        typeParams: [{ name: "T" }],
      },
    };
    const result = resolveType(
      { type: "genericType", name: "Container", typeArgs: [numberType] },
      aliases,
    );
    expect(result).toEqual({
      type: "objectType",
      properties: [{ key: "value", value: numberType }],
    });
  });

  it("uses default type argument when alias is referenced bare", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      StringMap: {
        body: {
          type: "genericType",
          name: "Record",
          typeArgs: [
            stringType,
            { type: "typeAliasVariable", aliasName: "V" },
          ],
        },
        typeParams: [{ name: "V", default: anyType }],
      },
    };
    const result = resolveType(
      { type: "typeAliasVariable", aliasName: "StringMap" },
      aliases,
    );
    expect(result).toEqual({
      type: "genericType",
      name: "Record",
      typeArgs: [stringType, anyType],
      // Written args after param substitution: V has already been replaced
      // by its default before Record.apply sees the args (#630).
      writtenTypeArgs: [stringType, anyType],
    });
  });

  it("fills in default type args when only some are supplied", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Pair: {
        body: {
          type: "objectType",
          properties: [
            {
              key: "first",
              value: { type: "typeAliasVariable", aliasName: "A" },
            },
            {
              key: "second",
              value: { type: "typeAliasVariable", aliasName: "B" },
            },
          ],
        },
        typeParams: [{ name: "A" }, { name: "B", default: stringType }],
      },
    };
    const result = resolveType(
      { type: "genericType", name: "Pair", typeArgs: [numberType] },
      aliases,
    );
    expect(result).toEqual({
      type: "objectType",
      properties: [
        { key: "first", value: numberType },
        { key: "second", value: stringType },
      ],
    });
  });

  it("does not infinite-loop on a recursive generic alias", () => {
    // type Tree<T> = { value: T, children: Tree<T>[] }
    const aliases: Record<string, TypeAliasEntry> = {
      Tree: {
        body: {
          type: "objectType",
          properties: [
            {
              key: "value",
              value: { type: "typeAliasVariable", aliasName: "T" },
            },
            {
              key: "children",
              value: {
                type: "arrayType",
                elementType: {
                  type: "genericType",
                  name: "Tree",
                  typeArgs: [{ type: "typeAliasVariable", aliasName: "T" }],
                },
              },
            },
          ],
        },
        typeParams: [{ name: "T" }],
      },
    };
    const result = resolveType(
      { type: "genericType", name: "Tree", typeArgs: [stringType] },
      aliases,
    );
    // The self-reference is preserved as a genericType with substituted args
    expect(result).toEqual({
      type: "objectType",
      properties: [
        { key: "value", value: stringType },
        {
          key: "children",
          value: {
            type: "arrayType",
            elementType: {
              type: "genericType",
              name: "Tree",
              typeArgs: [stringType],
            },
          },
        },
      ],
    });
  });

  it("throws when too many type args are supplied", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Box: {
        body: { type: "typeAliasVariable", aliasName: "T" },
        typeParams: [{ name: "T" }],
      },
    };
    expect(() =>
      resolveType(
        {
          type: "genericType",
          name: "Box",
          typeArgs: [stringType, numberType],
        },
        aliases,
      ),
    ).toThrow(/expects at most 1/);
  });

  it("throws when a required type arg is missing", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Pair: {
        body: { type: "typeAliasVariable", aliasName: "A" },
        typeParams: [{ name: "A" }, { name: "B" }],
      },
    };
    expect(() =>
      resolveType(
        { type: "genericType", name: "Pair", typeArgs: [stringType] },
        aliases,
      ),
    ).toThrow(/requires at least 2/);
  });

  it("throws when a bare alias has params without defaults", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Container: {
        body: { type: "typeAliasVariable", aliasName: "T" },
        typeParams: [{ name: "T" }],
      },
    };
    expect(() =>
      resolveType(
        { type: "typeAliasVariable", aliasName: "Container" },
        aliases,
      ),
    ).toThrow(/Container requires type arguments/);
  });

  it("throws when applying type args to a non-generic alias", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Plain: { body: stringType },
    };
    expect(() =>
      resolveType(
        { type: "genericType", name: "Plain", typeArgs: [stringType] },
        aliases,
      ),
    ).toThrow(/Plain is not a generic type/);
  });

  it("throws when referencing an unknown generic type", () => {
    expect(() =>
      resolveType(
        { type: "genericType", name: "Ghost", typeArgs: [stringType] },
        {},
      ),
    ).toThrow(/Unknown generic type Ghost/);
  });
});

describe("resolveTypeDeep: nested generic resolution", () => {
  it("resolves a generic alias nested inside another generic alias arg", () => {
    // type Container<T> = { value: T }
    const aliases: Record<string, TypeAliasEntry> = {
      Container: {
        body: {
          type: "objectType",
          properties: [
            {
              key: "value",
              value: { type: "typeAliasVariable", aliasName: "T" },
            },
          ],
        },
        typeParams: [{ name: "T" }],
      },
    };
    // Container<Container<number>>
    const input: VariableType = {
      type: "genericType",
      name: "Container",
      typeArgs: [
        {
          type: "genericType",
          name: "Container",
          typeArgs: [numberType],
        },
      ],
    };
    const result = resolveTypeDeep(input, aliases);
    expect(result).toEqual({
      type: "objectType",
      properties: [
        {
          key: "value",
          value: {
            type: "objectType",
            properties: [{ key: "value", value: numberType }],
          },
        },
      ],
    });
  });

  it("resolves a generic alias inside Array<...>", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Container: {
        body: {
          type: "objectType",
          properties: [
            {
              key: "value",
              value: { type: "typeAliasVariable", aliasName: "T" },
            },
          ],
        },
        typeParams: [{ name: "T" }],
      },
    };
    // Array<Container<string>>
    const input: VariableType = {
      type: "genericType",
      name: "Array",
      typeArgs: [
        {
          type: "genericType",
          name: "Container",
          typeArgs: [stringType],
        },
      ],
    };
    const result = resolveTypeDeep(input, aliases);
    expect(result).toEqual({
      type: "arrayType",
      elementType: {
        type: "objectType",
        properties: [{ key: "value", value: stringType }],
      },
    });
  });

  it("keeps Record<K, V> as a genericType while resolving its value arg", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Container: {
        body: {
          type: "objectType",
          properties: [
            {
              key: "value",
              value: { type: "typeAliasVariable", aliasName: "T" },
            },
          ],
        },
        typeParams: [{ name: "T" }],
      },
    };
    // Record<string, Container<number>>
    const input: VariableType = {
      type: "genericType",
      name: "Record",
      typeArgs: [
        stringType,
        {
          type: "genericType",
          name: "Container",
          typeArgs: [numberType],
        },
      ],
    };
    const result = resolveTypeDeep(input, aliases);
    expect(result).toEqual({
      type: "genericType",
      name: "Record",
      typeArgs: [
        stringType,
        {
          type: "objectType",
          properties: [{ key: "value", value: numberType }],
        },
      ],
      // The written value arg keeps the Container<number> reference so the
      // descriptor builder can preserve alias identity (#630).
      writtenTypeArgs: [
        stringType,
        {
          type: "genericType",
          name: "Container",
          typeArgs: [numberType],
        },
      ],
    });
  });

  it("leaves bare typeAliasVariable references intact (so codegen can emit by name)", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Coords: {
        body: {
          type: "objectType",
          properties: [
            { key: "x", value: numberType },
            { key: "y", value: numberType },
          ],
        },
      },
    };
    const input: VariableType = {
      type: "typeAliasVariable",
      aliasName: "Coords",
    };
    const result = resolveTypeDeep(input, aliases);
    // unchanged — codegen emits the alias by name
    expect(result).toEqual(input);
  });

  it("preserves typeAliasVariable references even inside an object tree", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Coords: {
        body: {
          type: "objectType",
          properties: [{ key: "x", value: numberType }],
        },
      },
    };
    const input: VariableType = {
      type: "objectType",
      properties: [
        { key: "a", value: { type: "typeAliasVariable", aliasName: "Coords" } },
      ],
    };
    const result = resolveTypeDeep(input, aliases);
    expect(result).toEqual(input);
  });

  it("returns primitives unchanged", () => {
    expect(resolveTypeDeep(numberType, {})).toEqual(numberType);
  });
});
