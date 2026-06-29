import { describe, it, expect } from "vitest";
import { isAssignable, isNever, widenType } from "./assignability.js";
import { formatTypeHint } from "../cli/util.js";
import { NEVER_T, STRING_T, NUMBER_T } from "./primitives.js";
import type { VariableType } from "../types.js";

describe("never (bottom type)", () => {
  const obj: VariableType = {
    type: "objectType",
    properties: [{ key: "a", value: STRING_T }],
  };
  const union: VariableType = { type: "unionType", types: [STRING_T, NUMBER_T] };

  it("never is assignable to every type", () => {
    expect(isAssignable(NEVER_T, STRING_T, {})).toBe(true);
    expect(isAssignable(NEVER_T, NUMBER_T, {})).toBe(true);
    expect(isAssignable(NEVER_T, obj, {})).toBe(true);
    expect(isAssignable(NEVER_T, union, {})).toBe(true);
    expect(isAssignable(NEVER_T, { type: "primitiveType", value: "any" }, {})).toBe(true);
  });

  it("nothing is assignable to never, except never", () => {
    expect(isAssignable(STRING_T, NEVER_T, {})).toBe(false);
    expect(isAssignable(obj, NEVER_T, {})).toBe(false);
    expect(isAssignable(union, NEVER_T, {})).toBe(false);
    expect(isAssignable(NEVER_T, NEVER_T, {})).toBe(true);
  });

  it("isNever recognizes only the never primitive", () => {
    expect(isNever(NEVER_T)).toBe(true);
    expect(isNever(STRING_T)).toBe(false);
    expect(isNever("any")).toBe(false);
  });

  it("widenType passes never through unchanged", () => {
    expect(widenType(NEVER_T)).toEqual(NEVER_T);
  });
});

describe("functionRefType assignability", () => {
  const fnRef: VariableType = {
    type: "functionRefType",
    name: "deploy",
    params: [
      { type: "functionParameter", name: "env", typeHint: { type: "primitiveType", value: "string" } },
    ],
    returnType: { type: "primitiveType", value: "void" },
  };

  it("is assignable to any", () => {
    expect(isAssignable(fnRef, { type: "primitiveType", value: "any" }, {})).toBe(true);
  });

  it("is assignable to function primitive", () => {
    expect(isAssignable(fnRef, { type: "primitiveType", value: "function" }, {})).toBe(true);
  });

  it("function primitive is assignable to any", () => {
    expect(
      isAssignable(
        { type: "primitiveType", value: "function" },
        { type: "primitiveType", value: "any" },
        {},
      ),
    ).toBe(true);
  });

  it("two functionRefTypes with compatible signatures are mutually assignable", () => {
    const other: VariableType = {
      type: "functionRefType",
      name: "redeploy",
      params: [
        { type: "functionParameter", name: "environment", typeHint: { type: "primitiveType", value: "string" } },
      ],
      returnType: { type: "primitiveType", value: "void" },
    };
    expect(isAssignable(fnRef, other, {})).toBe(true);
    expect(isAssignable(other, fnRef, {})).toBe(true);
  });

  it("two functionRefTypes with incompatible params are not assignable", () => {
    const other: VariableType = {
      type: "functionRefType",
      name: "add",
      params: [
        { type: "functionParameter", name: "a", typeHint: { type: "primitiveType", value: "number" } },
        { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "number" } },
      ],
      returnType: { type: "primitiveType", value: "number" },
    };
    expect(isAssignable(fnRef, other, {})).toBe(false);
  });

  it("functionRefType is not assignable to string", () => {
    expect(isAssignable(fnRef, { type: "primitiveType", value: "string" }, {})).toBe(false);
  });

  it("function primitive is not assignable to functionRefType", () => {
    expect(
      isAssignable({ type: "primitiveType", value: "function" }, fnRef, {}),
    ).toBe(false);
  });

  it("formats functionRefType with formatTypeHint", () => {
    expect(formatTypeHint(fnRef)).toBe("function deploy(env: string): void");
    const noParams: VariableType = {
      type: "functionRefType",
      name: "ping",
      params: [],
      returnType: null,
    };
    expect(formatTypeHint(noParams)).toBe("function ping()");
  });

  describe("object primitive ↔ objectType", () => {
    const objectPrim: VariableType = { type: "primitiveType", value: "object" };
    const emptyStruct: VariableType = { type: "objectType", properties: [] };
    const nonEmptyStruct: VariableType = {
      type: "objectType",
      properties: [
        { key: "foo", value: { type: "primitiveType", value: "string" } },
      ],
    };

    it("objectType is assignable to object primitive", () => {
      expect(isAssignable(emptyStruct, objectPrim, {})).toBe(true);
      expect(isAssignable(nonEmptyStruct, objectPrim, {})).toBe(true);
    });

    it("object primitive is assignable to the empty objectType {}", () => {
      // {} imposes no structural requirements, so any object satisfies it.
      expect(isAssignable(objectPrim, emptyStruct, {})).toBe(true);
    });

    it("object primitive is NOT assignable to a non-empty objectType", () => {
      // An arbitrary object isn't guaranteed to have specific properties.
      expect(isAssignable(objectPrim, nonEmptyStruct, {})).toBe(false);
    });
  });

  it("two functionRefTypes with incompatible return types are not assignable", () => {
    const other: VariableType = {
      type: "functionRefType",
      name: "deploy2",
      params: [
        { type: "functionParameter", name: "env", typeHint: { type: "primitiveType", value: "string" } },
      ],
      returnType: { type: "primitiveType", value: "number" },
    };
    expect(isAssignable(fnRef, other, {})).toBe(false);
  });
});

describe("unresolved typeAliasVariable assignability", () => {
  // Regression: if a user references an undeclared type name (typo,
  // forgotten import, missing export) on both sides of an assignment,
  // `isAssignable` used to fall through to its `return false` tail
  // and emit the confusing diagnostic "Foo is not assignable to Foo".
  // Two unresolved aliases with the same name are now treated as
  // equal; the real diagnostic ("type alias not defined") is the
  // job of validateTypeReferences.
  const undefinedFoo: VariableType = {
    type: "typeAliasVariable",
    aliasName: "Foo",
  };
  const undefinedFooAgain: VariableType = {
    type: "typeAliasVariable",
    aliasName: "Foo",
  };
  const undefinedBar: VariableType = {
    type: "typeAliasVariable",
    aliasName: "Bar",
  };

  it("same-name unresolved aliases are assignable to each other", () => {
    expect(isAssignable(undefinedFoo, undefinedFooAgain, {})).toBe(true);
  });

  it("different-name unresolved aliases are NOT assignable", () => {
    expect(isAssignable(undefinedFoo, undefinedBar, {})).toBe(false);
  });

  it("does not affect aliases that ARE defined", () => {
    // A normal defined alias resolves to its body and goes through the
    // structural-equality path, not the unresolved-equality short-circuit.
    const aliases = {
      Color: {
        body: {
          type: "stringLiteralType" as const,
          value: "red",
        } as VariableType,
      },
    };
    const colorRef: VariableType = {
      type: "typeAliasVariable",
      aliasName: "Color",
    };
    // "red" is assignable to "red" (resolves through alias body)
    expect(isAssignable(colorRef, colorRef, aliases)).toBe(true);
    // The new short-circuit must NOT fire here: source resolves to
    // stringLiteralType, target stays as the unresolved Foo. They are
    // not the same type, so the result is `false`.
    expect(isAssignable(colorRef, undefinedFoo, aliases)).toBe(false);
  });
});
