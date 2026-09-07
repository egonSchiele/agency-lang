import { describe, expect, it } from "vitest";
import { resultTypeForValidation, effectiveReturnType } from "./validation.js";
import type { VariableType, FunctionDefinition } from "../types.js";

describe("applyValidationFlag", () => {
  const person: VariableType = {
    type: "typeAliasVariable",
    aliasName: "Person",
  };
  const stringT: VariableType = { type: "primitiveType", value: "string" };
  const anyT: VariableType = { type: "primitiveType", value: "any" };

  it("returns the type unchanged when validated is false/undefined", () => {
    expect(resultTypeForValidation(person, false)).toEqual(person);
    expect(resultTypeForValidation(person, undefined)).toEqual(person);
  });

  it("wraps a non-Result type in Result<T, any> when validated", () => {
    // The data type is left open. A validation failure carries a message and
    // no structured data, so naming `string` here would claim string data.
    expect(resultTypeForValidation(person, true)).toEqual({
      type: "resultType",
      successType: person,
      dataType: anyT,
    });
  });

  it("does not rewrap a Result type", () => {
    const result: VariableType = {
      type: "resultType",
      successType: person,
      dataType: stringT,
    };
    expect(resultTypeForValidation(result, true)).toEqual(result);
  });

  it("wraps an array type in Result<T[], any>", () => {
    const arr: VariableType = { type: "arrayType", elementType: person };
    expect(resultTypeForValidation(arr, true)).toEqual({
      type: "resultType",
      successType: arr,
      dataType: anyT,
    });
  });
});

describe("effectiveReturnType", () => {
  const person: VariableType = {
    type: "typeAliasVariable",
    aliasName: "Person",
  };
  const stringT: VariableType = { type: "primitiveType", value: "string" };
  const anyT: VariableType = { type: "primitiveType", value: "any" };

  function fn(
    returnType: VariableType | null | undefined,
    validated?: boolean,
  ): FunctionDefinition {
    return {
      type: "function",
      functionName: "f",
      parameters: [],
      body: [],
      returnType: returnType,
      returnTypeValidated: validated,
    };
  }

  it("returns undefined / null unchanged", () => {
    expect(effectiveReturnType(fn(undefined))).toBeUndefined();
    expect(effectiveReturnType(fn(null))).toBeNull();
  });

  it("returns the type unchanged when not validated", () => {
    expect(effectiveReturnType(fn(person))).toEqual(person);
  });

  it("wraps in Result when returnTypeValidated", () => {
    expect(effectiveReturnType(fn(person, true))).toEqual({
      type: "resultType",
      successType: person,
      dataType: anyT,
    });
  });
});
