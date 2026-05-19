import { describe, it, expect } from "vitest";
import { isAssignable } from "./assignability.js";
import type { VariableType } from "../types.js";

const stringType: VariableType = { type: "primitiveType", value: "string" };
const numberType: VariableType = { type: "primitiveType", value: "number" };
const anyType: VariableType = { type: "primitiveType", value: "any" };

const stringLit = (value: string): VariableType => ({
  type: "stringLiteralType",
  value,
});

const record = (k: VariableType, v: VariableType): VariableType => ({
  type: "genericType",
  name: "Record",
  typeArgs: [k, v],
});

const obj = (
  props: { key: string; value: VariableType }[],
): VariableType => ({
  type: "objectType",
  properties: props,
});

const union = (...types: VariableType[]): VariableType => ({
  type: "unionType",
  types,
});

describe("isAssignable: Record-to-Record", () => {
  it("Record<string, string> is assignable to Record<string, string>", () => {
    expect(
      isAssignable(record(stringType, stringType), record(stringType, stringType), {}),
    ).toBe(true);
  });

  it('covariant in values: Record<string, "approve"> -> Record<string, string>', () => {
    expect(
      isAssignable(
        record(stringType, stringLit("approve")),
        record(stringType, stringType),
        {},
      ),
    ).toBe(true);
  });

  it("rejects when value types are incompatible", () => {
    expect(
      isAssignable(record(stringType, numberType), record(stringType, stringType), {}),
    ).toBe(false);
  });

  it("rejects when key types are incompatible", () => {
    expect(
      isAssignable(record(numberType, stringType), record(stringType, stringType), {}),
    ).toBe(false);
  });
});

describe("isAssignable: object -> Record", () => {
  it("all properties match V", () => {
    expect(
      isAssignable(
        obj([
          { key: "a", value: numberType },
          { key: "b", value: numberType },
        ]),
        record(stringType, numberType),
        {},
      ),
    ).toBe(true);
  });

  it("empty object is assignable to any Record (vacuously true)", () => {
    expect(
      isAssignable(obj([]), record(stringType, numberType), {}),
    ).toBe(true);
  });

  it("rejects when a property value does not match V", () => {
    expect(
      isAssignable(
        obj([
          { key: "a", value: numberType },
          { key: "b", value: stringType },
        ]),
        record(stringType, numberType),
        {},
      ),
    ).toBe(false);
  });

  it("with literal-key union K, all listed keys must be present", () => {
    const keyUnion = union(stringLit("active"), stringLit("inactive"));
    expect(
      isAssignable(
        obj([
          { key: "active", value: numberType },
          { key: "inactive", value: numberType },
        ]),
        record(keyUnion, numberType),
        {},
      ),
    ).toBe(true);
  });

  it("rejects when a required literal key is missing", () => {
    const keyUnion = union(stringLit("active"), stringLit("inactive"));
    expect(
      isAssignable(
        obj([{ key: "active", value: numberType }]),
        record(keyUnion, numberType),
        {},
      ),
    ).toBe(false);
  });
});

describe("isAssignable: Record -> object", () => {
  it("Record is assignable to the empty object {}", () => {
    expect(isAssignable(record(stringType, anyType), obj([]), {})).toBe(true);
  });

  it("Record is NOT assignable to a non-empty object", () => {
    expect(
      isAssignable(
        record(stringType, anyType),
        obj([{ key: "a", value: stringType }]),
        {},
      ),
    ).toBe(false);
  });
});
