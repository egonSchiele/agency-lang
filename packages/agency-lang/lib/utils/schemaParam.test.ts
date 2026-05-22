import { describe, it, expect } from "vitest";
import {
  isSchemaTypeHint,
  schemaInnerType,
  findSchemaParam,
} from "./schemaParam.js";
import type { FunctionParameter } from "../types/function.js";

describe("isSchemaTypeHint", () => {
  it("detects the surface `Schema<T>` form", () => {
    expect(
      isSchemaTypeHint({
        type: "genericType",
        name: "Schema",
        typeArgs: [{ type: "primitiveType", value: "any" }],
      }),
    ).toBe(true);
  });

  it("detects the post-resolution `schemaType` form", () => {
    expect(
      isSchemaTypeHint({
        type: "schemaType",
        inner: { type: "primitiveType", value: "string" },
      }),
    ).toBe(true);
  });

  it("rejects unrelated genericType names", () => {
    expect(
      isSchemaTypeHint({
        type: "genericType",
        name: "Array",
        typeArgs: [{ type: "primitiveType", value: "number" }],
      }),
    ).toBe(false);
  });

  it("rejects primitives and arrays", () => {
    expect(isSchemaTypeHint({ type: "primitiveType", value: "string" })).toBe(
      false,
    );
    expect(
      isSchemaTypeHint({
        type: "arrayType",
        elementType: { type: "primitiveType", value: "number" },
      }),
    ).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isSchemaTypeHint(undefined)).toBe(false);
  });
});

describe("schemaInnerType", () => {
  it("returns the inner type from `schemaType`", () => {
    expect(
      schemaInnerType({
        type: "schemaType",
        inner: { type: "primitiveType", value: "string" },
      }),
    ).toEqual({ type: "primitiveType", value: "string" });
  });

  it("returns the first typeArg from `genericType Schema<...>`", () => {
    expect(
      schemaInnerType({
        type: "genericType",
        name: "Schema",
        typeArgs: [
          {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
        ],
      }),
    ).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });

  it("returns undefined for non-Schema types", () => {
    expect(
      schemaInnerType({ type: "primitiveType", value: "string" }),
    ).toBeUndefined();
  });
});

describe("findSchemaParam", () => {
  const stringParam: FunctionParameter = {
    type: "functionParameter",
    name: "input",
    typeHint: { type: "primitiveType", value: "string" },
  };
  const schemaParam: FunctionParameter = {
    type: "functionParameter",
    name: "s",
    typeHint: {
      type: "genericType",
      name: "Schema",
      typeArgs: [{ type: "primitiveType", value: "any" }],
    },
  };
  const schemaParam2: FunctionParameter = {
    type: "functionParameter",
    name: "t",
    typeHint: {
      type: "genericType",
      name: "Schema",
      typeArgs: [{ type: "primitiveType", value: "any" }],
    },
  };

  it("returns the unique Schema parameter with its index", () => {
    const result = findSchemaParam([stringParam, schemaParam], "parseValue");
    expect(result).toEqual({ param: schemaParam, index: 1 });
  });

  it("returns undefined when there are no Schema parameters", () => {
    expect(findSchemaParam([stringParam], "noSchema")).toBeUndefined();
  });

  it("throws when multiple Schema parameters are declared", () => {
    expect(() =>
      findSchemaParam([stringParam, schemaParam, schemaParam2], "twoSchemas"),
    ).toThrowError(/more than one Schema parameter/);
  });
});
