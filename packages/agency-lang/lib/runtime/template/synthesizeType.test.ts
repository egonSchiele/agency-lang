import { describe, it, expect } from "vitest";
import { synthesizeType } from "./synthesizeType.js";
import { _parseExpr } from "../../stdlib/template.js";

describe("synthesizeType: primitives", () => {
  it("describes strings, numbers, booleans and null", () => {
    expect(synthesizeType("a")).toEqual({ type: "primitiveType", value: "string" });
    expect(synthesizeType(1)).toEqual({ type: "primitiveType", value: "number" });
    expect(synthesizeType(true)).toEqual({ type: "primitiveType", value: "boolean" });
    expect(synthesizeType(null)).toEqual({ type: "primitiveType", value: "null" });
  });
});

describe("synthesizeType: records and arrays", () => {
  it("describes a record property by property", () => {
    expect(synthesizeType({ name: "Alice", age: 30 })).toEqual({
      type: "objectType",
      properties: [
        { key: "name", value: { type: "primitiveType", value: "string" } },
        { key: "age", value: { type: "primitiveType", value: "number" } },
      ],
    });
  });

  it("describes a homogeneous array with a single element type", () => {
    expect(synthesizeType([1, 2, 3])).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });

  it("describes a mixed array as a union of its element types", () => {
    const result = synthesizeType([1, "a"]) as { elementType: { types: unknown[] } };
    expect(result.elementType).toMatchObject({ type: "unionType" });
    expect(result.elementType.types).toHaveLength(2);
  });

  it("describes an empty array as an array of any, which fits anything", () => {
    expect(synthesizeType([])).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "any" },
    });
  });

  it("deduplicates identical element types instead of one per element", () => {
    // Fills run on model-supplied data. Without dedupe a 1000-element
    // array becomes a 1000-member union handed to isAssignable.
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `p${i}`, age: i }));
    const result = synthesizeType(many) as { elementType: { type: string } };
    expect(result.elementType.type).toBe("objectType");
  });
});

describe("synthesizeType: literal Code fragments", () => {
  // This is certainTypeOf's existing behavior, absorbed. Losing it would
  // silently drop the one fragment check that exists today.
  it("describes a single-literal expression fragment by its literal", () => {
    expect(synthesizeType(_parseExpr("42"))).toEqual({ type: "primitiveType", value: "number" });
    expect(synthesizeType(_parseExpr(`"hi"`))).toEqual({ type: "primitiveType", value: "string" });
    expect(synthesizeType(_parseExpr("true"))).toEqual({ type: "primitiveType", value: "boolean" });
  });

  it("cannot describe an interpolated string — its value depends on scope", () => {
    expect(synthesizeType(_parseExpr('"${getCount()}"'))).toBeNull();
  });

  it("cannot describe any other fragment", () => {
    expect(synthesizeType(_parseExpr("getGreeting()"))).toBeNull();
  });
});

describe("synthesizeType: what it refuses to guess", () => {
  it("cannot describe a value containing a fragment, at any depth", () => {
    expect(synthesizeType({ body: _parseExpr("getGreeting()") })).toBeNull();
    expect(synthesizeType([_parseExpr("getGreeting()")])).toBeNull();
  });

  it("cannot describe a function", () => {
    expect(synthesizeType(() => 1)).toBeNull();
  });

  it("cannot describe a Date, a Map or a class instance", () => {
    // These are objects to `typeof`. Describing one as a record of its
    // enumerable keys produces a type that REJECTS, which is the opposite
    // of skipping — so they must come back unknowable.
    expect(synthesizeType(new Date())).toBeNull();
    expect(synthesizeType(new Map())).toBeNull();
    expect(synthesizeType(new (class Thing {})())).toBeNull();
  });

  it("treats undefined the same as null", () => {
    expect(synthesizeType(undefined)).toEqual({ type: "primitiveType", value: "null" });
  });
});

describe("synthesizeType: mirroring what the checker infers", () => {
  it("widens strings by default and describes them literally on request", () => {
    expect(synthesizeType("fast")).toEqual({ type: "primitiveType", value: "string" });
    expect(synthesizeType("fast", { stringsAsLiterals: true })).toEqual({
      type: "stringLiteralType",
      value: "fast",
    });
  });

  it("keeps numbers and booleans widened in BOTH modes", () => {
    // synthType does not infer numeric or boolean literal types, so the
    // compile rejects `const n: 1 | 2 = 1`. Describing them literally here
    // would make fill ACCEPT what the compile refuses — drift the other
    // way, and just as wrong.
    expect(synthesizeType(1, { stringsAsLiterals: true })).toEqual({
      type: "primitiveType",
      value: "number",
    });
    expect(synthesizeType(true, { stringsAsLiterals: true })).toEqual({
      type: "primitiveType",
      value: "boolean",
    });
  });

  it("applies the mode inside records and arrays", () => {
    expect(synthesizeType({ mode: "fast" }, { stringsAsLiterals: true })).toEqual({
      type: "objectType",
      properties: [{ key: "mode", value: { type: "stringLiteralType", value: "fast" } }],
    });
  });
});
