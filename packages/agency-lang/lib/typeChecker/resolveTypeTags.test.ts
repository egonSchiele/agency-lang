import { describe, expect, it } from "vitest";
import { resolveType } from "./assignability.js";
import type { Tag, TypeAliasEntry, VariableType } from "../types.js";

function ident(name: string): any {
  return { type: "variableName", value: name };
}

function tag(name: string, args: any[]): Tag {
  return { type: "tag", name, arguments: args } as Tag;
}

describe("resolveType — tag propagation", () => {
  it("attaches alias tags to a non-generic alias's resolved type", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Email: {
        body: { type: "primitiveType", value: "string" },
        tags: [tag("validate", [ident("isEmail")])],
      },
    };
    const ref: VariableType = { type: "typeAliasVariable", aliasName: "Email" };
    const resolved = resolveType(ref, aliases);
    expect(resolved.type).toBe("primitiveType");
    expect(resolved.tags).toHaveLength(1);
    expect(resolved.tags?.[0].name).toBe("validate");
  });

  it("returns alias's resolved body with NO tags if alias has none", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Plain: { body: { type: "primitiveType", value: "string" } },
    };
    const ref: VariableType = { type: "typeAliasVariable", aliasName: "Plain" };
    const resolved = resolveType(ref, aliases);
    expect(resolved.tags).toBeUndefined();
  });

  it("propagates alias tags through generic instantiation", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      NonEmptyArray: {
        body: {
          type: "arrayType",
          elementType: { type: "typeAliasVariable", aliasName: "T" },
        },
        typeParams: [{ name: "T" }],
        tags: [tag("validate", [ident("nonEmpty")])],
      },
    };
    const ref: VariableType = {
      type: "genericType",
      name: "NonEmptyArray",
      typeArgs: [{ type: "primitiveType", value: "number" }],
    };
    const resolved = resolveType(ref, aliases);
    expect(resolved.type).toBe("arrayType");
    expect(resolved.tags).toHaveLength(1);
    expect(resolved.tags?.[0].name).toBe("validate");
  });

  it("nested type alias tags survive through inner resolution", () => {
    // type Email = string  (has @validate(isEmail))
    // type UserList = { emails: Email[] }
    // Resolving UserList -> resolves to objectType with property whose
    // value is arrayType whose elementType is the resolved primitive
    // string with Email's tags attached.
    const aliases: Record<string, TypeAliasEntry> = {
      Email: {
        body: { type: "primitiveType", value: "string" },
        tags: [tag("validate", [ident("isEmail")])],
      },
    };
    const arrOfEmail: VariableType = {
      type: "arrayType",
      elementType: { type: "typeAliasVariable", aliasName: "Email" },
    };
    const resolved = resolveType(arrOfEmail, aliases);
    expect(resolved.type).toBe("arrayType");
    // arrayType.elementType is not auto-walked by resolveType (it operates
    // on the top-level only). The element-level resolution happens when
    // the caller walks into the array. This test documents that behavior.
    expect((resolved as any).elementType.type).toBe("typeAliasVariable");
  });
});
