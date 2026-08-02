import { describe, it, expect } from "vitest";
import { variableTypeToString } from "./typeToString.js";
import type { ObjectType, VariableType } from "../../types.js";

const numberType: VariableType = { type: "primitiveType", value: "number" };
const stringType: VariableType = { type: "primitiveType", value: "string" };

function objectOf(value: VariableType): ObjectType {
  return {
    type: "objectType",
    properties: [{ key: "value", value }],
  };
}

describe("variableTypeToString: genericType", () => {
  it("renders Record<string, number>", () => {
    const t: VariableType = {
      type: "genericType",
      name: "Record",
      typeArgs: [
        { type: "primitiveType", value: "string" },
        { type: "primitiveType", value: "number" },
      ],
    };
    expect(variableTypeToString(t, {})).toBe("Record<string, number>");
  });

  it("renders user-defined generics like Container<T>", () => {
    const t: VariableType = {
      type: "genericType",
      name: "Container",
      typeArgs: [{ type: "primitiveType", value: "string" }],
    };
    expect(variableTypeToString(t, {})).toBe("Container<string>");
  });

  it("renders nested generics", () => {
    const t: VariableType = {
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
    };
    expect(variableTypeToString(t, {})).toBe(
      "Record<string, Record<string, number>>",
    );
  });

  it("renders generics with multiple args", () => {
    const t: VariableType = {
      type: "genericType",
      name: "Pair",
      typeArgs: [
        { type: "primitiveType", value: "string" },
        { type: "primitiveType", value: "number" },
      ],
    };
    expect(variableTypeToString(t, {})).toBe("Pair<string, number>");
  });
});

describe("variableTypeToString: object rendering hook", () => {
  it("preserves exact output when the object hook delegates", () => {
    const type: VariableType = {
      type: "genericType",
      name: "Container",
      typeArgs: [objectOf(numberType)],
      valueArgs: [{ type: "number", value: "3" }],
    };
    const visited: ObjectType[] = [];

    const rendered = variableTypeToString(type, {}, true, {
      objectType: (objectType) => {
        visited.push(objectType);
        return undefined;
      },
    });

    expect(rendered).toBe("Container<{ value: number }>(3)");
    expect(visited).toHaveLength(1);
  });

  const cases: { name: string; type: VariableType; expected: string }[] = [
    {
      name: "array elements and nested object children",
      type: { type: "arrayType", elementType: objectOf(objectOf(numberType)) },
      expected: "OBJECT<OBJECT<number>>[]",
    },
    {
      name: "union members",
      type: { type: "unionType", types: [objectOf(numberType), stringType] },
      expected: "OBJECT<number> | string",
    },
    {
      name: "intersection members",
      type: {
        type: "intersectionType",
        types: [objectOf(numberType), objectOf(stringType)],
      },
      expected: "OBJECT<number> & OBJECT<string>",
    },
    {
      name: "keyof operands",
      type: { type: "keyofType", operand: objectOf(numberType) },
      expected: "keyof OBJECT<number>",
    },
    {
      name: "indexed access object and index operands",
      type: {
        type: "indexedAccessType",
        objectType: objectOf(numberType),
        index: objectOf(stringType),
      },
      expected: "OBJECT<number>[OBJECT<string>]",
    },
    {
      name: "generic type arguments with value arguments",
      type: {
        type: "genericType",
        name: "Container",
        typeArgs: [objectOf(numberType)],
        valueArgs: [{ type: "number", value: "3" }],
      },
      expected: "Container<OBJECT<number>>(3)",
    },
    {
      name: "Result success and failure types",
      type: {
        type: "resultType",
        successType: objectOf(numberType),
        failureType: objectOf(stringType),
      },
      expected: "Result<OBJECT<number>, OBJECT<string>>",
    },
    {
      name: "Result success type with string failure shorthand",
      type: {
        type: "resultType",
        successType: objectOf(numberType),
        failureType: stringType,
      },
      expected: "Result<OBJECT<number>>",
    },
    {
      name: "block parameters, return type, and raises type",
      type: {
        type: "blockType",
        params: [{ name: "input", typeAnnotation: objectOf(numberType) }],
        returnType: objectOf(stringType),
        raises: objectOf({ type: "primitiveType", value: "boolean" }),
      },
      expected:
        "(input: OBJECT<number>) -> OBJECT<string> raises OBJECT<boolean>",
    },
  ];

  it.each(cases)("forwards the hook through $name", ({ type, expected }) => {
    const rendered = variableTypeToString(type, {}, true, {
      objectType: (objectType, printChild) =>
        `OBJECT<${printChild(objectType.properties[0].value)}>`,
    });

    expect(rendered).toBe(expected);
  });
});
