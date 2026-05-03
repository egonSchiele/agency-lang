import { describe, expect, it } from "vitest";
import { applyValidationFlag, effectiveReturnType } from "./validation.js";
import type { VariableType, FunctionDefinition } from "../types.js";

describe("applyValidationFlag", () => {
  const person: VariableType = { type: "typeAliasVariable", aliasName: "Person" };
  const stringT: VariableType = { type: "primitiveType", value: "string" };

  it("returns the type unchanged when validated is false/undefined", () => {
    expect(applyValidationFlag(person, false)).toEqual(person);
    expect(applyValidationFlag(person, undefined)).toEqual(person);
  });

  it("wraps a non-Result type in Result<T, string> when validated", () => {
    expect(applyValidationFlag(person, true)).toEqual({
      type: "resultType",
      successType: person,
      failureType: stringT,
    });
  });

  it("does not rewrap a Result type", () => {
    const result: VariableType = {
      type: "resultType",
      successType: person,
      failureType: stringT,
    };
    expect(applyValidationFlag(result, true)).toEqual(result);
  });

  it("wraps an array type in Result<T[], string>", () => {
    const arr: VariableType = { type: "arrayType", elementType: person };
    expect(applyValidationFlag(arr, true)).toEqual({
      type: "resultType",
      successType: arr,
      failureType: stringT,
    });
  });
});

describe("effectiveReturnType", () => {
  const person: VariableType = { type: "typeAliasVariable", aliasName: "Person" };
  const stringT: VariableType = { type: "primitiveType", value: "string" };

  function fn(returnType: VariableType | null | undefined, validated?: boolean): FunctionDefinition {
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
      failureType: stringT,
    });
  });
});
