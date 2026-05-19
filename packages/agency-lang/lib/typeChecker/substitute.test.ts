import { describe, it, expect } from "vitest";
import { substituteTypeParams } from "./substitute.js";
import type { VariableType } from "../types.js";

const stringType: VariableType = { type: "primitiveType", value: "string" };
const numberType: VariableType = { type: "primitiveType", value: "number" };
const nullType: VariableType = { type: "primitiveType", value: "null" };

const tparam = (name: string): VariableType => ({
  type: "typeAliasVariable",
  aliasName: name,
});

describe("substituteTypeParams", () => {
  it("substitutes T in { value: T }", () => {
    const body: VariableType = {
      type: "objectType",
      properties: [{ key: "value", value: tparam("T") }],
    };
    const result = substituteTypeParams(body, ["T"], [stringType]);
    expect(result).toEqual({
      type: "objectType",
      properties: [{ key: "value", value: stringType }],
    });
  });

  it("substitutes T in nested T[][] (Array<T>[])", () => {
    const body: VariableType = {
      type: "arrayType",
      elementType: { type: "arrayType", elementType: tparam("T") },
    };
    const result = substituteTypeParams(body, ["T"], [stringType]);
    expect(result).toEqual({
      type: "arrayType",
      elementType: { type: "arrayType", elementType: stringType },
    });
  });

  it("substitutes T inside a union (T | null)", () => {
    const body: VariableType = {
      type: "unionType",
      types: [tparam("T"), nullType],
    };
    const result = substituteTypeParams(body, ["T"], [stringType]);
    expect(result).toEqual({
      type: "unionType",
      types: [stringType, nullType],
    });
  });

  it("substitutes inside genericType typeArgs but preserves the generic name", () => {
    const body: VariableType = {
      type: "genericType",
      name: "Wrapper",
      typeArgs: [tparam("T")],
    };
    const result = substituteTypeParams(body, ["T"], [stringType]);
    expect(result).toEqual({
      type: "genericType",
      name: "Wrapper",
      typeArgs: [stringType],
    });
  });

  it("substitutes multiple params in one call", () => {
    const body: VariableType = {
      type: "objectType",
      properties: [
        { key: "a", value: tparam("A") },
        { key: "b", value: tparam("B") },
      ],
    };
    const result = substituteTypeParams(
      body,
      ["A", "B"],
      [stringType, numberType],
    );
    expect(result).toEqual({
      type: "objectType",
      properties: [
        { key: "a", value: stringType },
        { key: "b", value: numberType },
      ],
    });
  });

  it("leaves unrelated typeAliasVariables unchanged", () => {
    const body: VariableType = tparam("Other");
    const result = substituteTypeParams(body, ["T"], [stringType]);
    expect(result).toEqual({ type: "typeAliasVariable", aliasName: "Other" });
  });

  it("substitutes inside resultType success and failure", () => {
    const body: VariableType = {
      type: "resultType",
      successType: tparam("T"),
      failureType: tparam("E"),
    };
    const result = substituteTypeParams(
      body,
      ["T", "E"],
      [stringType, numberType],
    );
    expect(result).toEqual({
      type: "resultType",
      successType: stringType,
      failureType: numberType,
    });
  });

  it("substitutes inside schemaType inner", () => {
    const body: VariableType = { type: "schemaType", inner: tparam("T") };
    const result = substituteTypeParams(body, ["T"], [stringType]);
    expect(result).toEqual({ type: "schemaType", inner: stringType });
  });

  it("substitutes inside blockType params and return", () => {
    const body: VariableType = {
      type: "blockType",
      params: [{ name: "x", typeAnnotation: tparam("T") }],
      returnType: tparam("T"),
    };
    const result = substituteTypeParams(body, ["T"], [stringType]);
    expect(result).toEqual({
      type: "blockType",
      params: [{ name: "x", typeAnnotation: stringType }],
      returnType: stringType,
    });
  });

  it("is a no-op when typeParams list is empty", () => {
    const body: VariableType = {
      type: "objectType",
      properties: [{ key: "value", value: stringType }],
    };
    const result = substituteTypeParams(body, [], []);
    expect(result).toEqual(body);
  });

  it("does not mutate the input", () => {
    const body: VariableType = {
      type: "arrayType",
      elementType: tparam("T"),
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    substituteTypeParams(body, ["T"], [stringType]);
    expect(body).toEqual(snapshot);
  });

  it("preserves a self-referential genericType after substitution", () => {
    // Mimics `type Tree<T> = { value: T, children: Tree<T>[] }`
    const body: VariableType = {
      type: "objectType",
      properties: [
        { key: "value", value: tparam("T") },
        {
          key: "children",
          value: {
            type: "arrayType",
            elementType: {
              type: "genericType",
              name: "Tree",
              typeArgs: [tparam("T")],
            },
          },
        },
      ],
    };
    const result = substituteTypeParams(body, ["T"], [stringType]);
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
});
