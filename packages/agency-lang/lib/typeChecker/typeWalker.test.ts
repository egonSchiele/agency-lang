import { describe, it, expect } from "vitest";
import { mapTypes, visitTypes } from "./typeWalker.js";
import type { VariableType } from "../types.js";

const numberType: VariableType = { type: "primitiveType", value: "number" };
const stringType: VariableType = { type: "primitiveType", value: "string" };
const booleanType: VariableType = {
  type: "primitiveType",
  value: "boolean",
};

const isNumber = (t: VariableType): boolean =>
  t.type === "primitiveType" && t.value === "number";

describe("mapTypes", () => {
  it("returns a primitive unchanged when fn is identity", () => {
    const result = mapTypes(numberType, (t) => t);
    expect(result).toEqual(numberType);
  });

  it("transforms a primitive via fn", () => {
    const result = mapTypes(numberType, (t) => (isNumber(t) ? stringType : t));
    expect(result).toEqual(stringType);
  });

  it("recurses into arrayType element", () => {
    const arr: VariableType = { type: "arrayType", elementType: numberType };
    const result = mapTypes(arr, (t) =>
      isNumber(t) ? stringType : t,
    );
    expect(result).toEqual({ type: "arrayType", elementType: stringType });
  });

  it("recurses into unionType members", () => {
    const u: VariableType = {
      type: "unionType",
      types: [numberType, booleanType],
    };
    const result = mapTypes(u, (t) =>
      isNumber(t) ? stringType : t,
    );
    expect(result).toEqual({
      type: "unionType",
      types: [stringType, booleanType],
    });
  });

  it("recurses into objectType property values", () => {
    const obj: VariableType = {
      type: "objectType",
      properties: [
        { key: "a", value: numberType },
        { key: "b", value: booleanType },
      ],
    };
    const result = mapTypes(obj, (t) =>
      isNumber(t) ? stringType : t,
    );
    expect(result).toEqual({
      type: "objectType",
      properties: [
        { key: "a", value: stringType },
        { key: "b", value: booleanType },
      ],
    });
  });

  it("recurses into resultType success and failure", () => {
    const r: VariableType = {
      type: "resultType",
      successType: numberType,
      failureType: booleanType,
    };
    const result = mapTypes(r, (t) =>
      isNumber(t) ? stringType : t,
    );
    expect(result).toEqual({
      type: "resultType",
      successType: stringType,
      failureType: booleanType,
    });
  });

  it("recurses into schemaType inner", () => {
    const s: VariableType = { type: "schemaType", inner: numberType };
    const result = mapTypes(s, (t) =>
      isNumber(t) ? stringType : t,
    );
    expect(result).toEqual({ type: "schemaType", inner: stringType });
  });

  it("recurses into blockType params and return type", () => {
    const b: VariableType = {
      type: "blockType",
      params: [{ name: "x", typeAnnotation: numberType }],
      returnType: booleanType,
    };
    const result = mapTypes(b, (t) =>
      isNumber(t) ? stringType : t,
    );
    expect(result).toEqual({
      type: "blockType",
      params: [{ name: "x", typeAnnotation: stringType }],
      returnType: booleanType,
    });
  });

  it("recurses into genericType typeArgs", () => {
    const g: VariableType = {
      type: "genericType",
      name: "Container",
      typeArgs: [numberType, booleanType],
    };
    const result = mapTypes(g, (t) =>
      isNumber(t) ? stringType : t,
    );
    expect(result).toEqual({
      type: "genericType",
      name: "Container",
      typeArgs: [stringType, booleanType],
    });
  });

  it("applies fn post-order (children transformed before parent sees them)", () => {
    const seen: VariableType[] = [];
    const arr: VariableType = { type: "arrayType", elementType: numberType };
    mapTypes(arr, (t) => {
      seen.push(t);
      return t;
    });
    expect(seen.map((t) => t.type)).toEqual(["primitiveType", "arrayType"]);
  });

  it("does not mutate the input", () => {
    const arr: VariableType = { type: "arrayType", elementType: numberType };
    const snapshot = JSON.parse(JSON.stringify(arr));
    mapTypes(arr, (t) => (isNumber(t) ? stringType : t));
    expect(arr).toEqual(snapshot);
  });

  it("recurses into functionRefType params and returnType", () => {
    const fn: VariableType = {
      type: "functionRefType",
      name: "f",
      params: [
        { type: "functionParameter", name: "x", typeHint: numberType },
        { type: "functionParameter", name: "y", typeHint: booleanType },
      ],
      returnType: numberType,
    };
    const result = mapTypes(fn, (t) =>
      isNumber(t) ? stringType : t,
    );
    expect(result).toEqual({
      type: "functionRefType",
      name: "f",
      params: [
        { type: "functionParameter", name: "x", typeHint: stringType },
        { type: "functionParameter", name: "y", typeHint: booleanType },
      ],
      returnType: stringType,
    });
  });

  it("leaves functionRefType params without typeHint untouched", () => {
    const fn: VariableType = {
      type: "functionRefType",
      name: "f",
      params: [{ type: "functionParameter", name: "x" }],
      returnType: numberType,
    };
    const result = mapTypes(fn, (t) =>
      isNumber(t) ? stringType : t,
    );
    expect(result).toEqual({
      type: "functionRefType",
      name: "f",
      params: [{ type: "functionParameter", name: "x" }],
      returnType: stringType,
    });
  });

  it("substitutes a typeAliasVariable (the substitute pattern)", () => {
    const tParam: VariableType = { type: "typeAliasVariable", aliasName: "T" };
    const tree: VariableType = {
      type: "objectType",
      properties: [
        { key: "value", value: tParam },
        {
          key: "list",
          value: { type: "arrayType", elementType: tParam },
        },
      ],
    };
    const result = mapTypes(tree, (t) =>
      t.type === "typeAliasVariable" && t.aliasName === "T" ? numberType : t,
    );
    expect(result).toEqual({
      type: "objectType",
      properties: [
        { key: "value", value: numberType },
        { key: "list", value: { type: "arrayType", elementType: numberType } },
      ],
    });
  });
});

describe("visitTypes (sanity check that walker still works)", () => {
  it("visits every node pre-order", () => {
    const arr: VariableType = { type: "arrayType", elementType: numberType };
    const seen: string[] = [];
    visitTypes(arr, (t) => {
      seen.push(t.type);
    });
    expect(seen).toEqual(["arrayType", "primitiveType"]);
  });

  it("visits functionRefType param types and returnType", () => {
    const fn: VariableType = {
      type: "functionRefType",
      name: "f",
      params: [
        { type: "functionParameter", name: "x", typeHint: numberType },
        { type: "functionParameter", name: "y" }, // untyped — should be skipped
        { type: "functionParameter", name: "z", typeHint: stringType },
      ],
      returnType: booleanType,
    };
    const seen: VariableType[] = [];
    visitTypes(fn, (t) => {
      seen.push(t);
    });
    // root, then param[0].typeHint, then param[2].typeHint, then returnType
    expect(seen).toEqual([fn, numberType, stringType, booleanType]);
  });

  it("short-circuits when visitor returns true inside functionRefType", () => {
    const fn: VariableType = {
      type: "functionRefType",
      name: "f",
      params: [{ type: "functionParameter", name: "x", typeHint: numberType }],
      returnType: stringType,
    };
    let count = 0;
    const halted = visitTypes(fn, (t) => {
      count++;
      return t.type === "primitiveType" && t.value === "number";
    });
    expect(halted).toBe(true);
    // root + numberType only; should not visit returnType
    expect(count).toBe(2);
  });
});
