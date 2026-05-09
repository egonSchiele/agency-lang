import { describe, it, expect } from "vitest";
import { isAssignable } from "./assignability.js";
import type { VariableType } from "../types.js";

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
