import { describe, it, expect } from "vitest";
import { paramAcceptsFailure } from "./utils.js";
import type { FunctionParameter } from "../types/function.js";

const ANY = { type: "primitiveType", value: "any" } as const;
const STR = { type: "primitiveType", value: "string" } as const;
const RESULT = { type: "resultType", successType: ANY, failureType: ANY } as const;

function makeParam(overrides: Record<string, unknown>): FunctionParameter {
  return { name: "x", ...overrides } as unknown as FunctionParameter;
}

describe("paramAcceptsFailure", () => {
  it("unannotated rejects", () => {
    expect(paramAcceptsFailure(makeParam({}))).toBe(false);
  });
  it("concrete types reject", () => {
    expect(paramAcceptsFailure(makeParam({ typeHint: STR }))).toBe(false);
  });
  it("explicit any accepts", () => {
    expect(paramAcceptsFailure(makeParam({ typeHint: ANY }))).toBe(true);
  });
  it("Result and Result<...> accept", () => {
    expect(paramAcceptsFailure(makeParam({ typeHint: RESULT }))).toBe(true);
    expect(
      paramAcceptsFailure(makeParam({ typeHint: { type: "resultType", successType: STR, failureType: STR } })),
    ).toBe(true);
  });
  it("unions accept iff an arm accepts", () => {
    expect(paramAcceptsFailure(makeParam({ typeHint: { type: "unionType", types: [STR, RESULT] } }))).toBe(true);
    expect(paramAcceptsFailure(makeParam({ typeHint: { type: "unionType", types: [STR, STR] } }))).toBe(false);
  });
  it("variadic checks the element type", () => {
    expect(
      paramAcceptsFailure(makeParam({ variadic: true, typeHint: { type: "arrayType", elementType: ANY } })),
    ).toBe(true);
    expect(
      paramAcceptsFailure(makeParam({ variadic: true, typeHint: { type: "arrayType", elementType: STR } })),
    ).toBe(false);
    expect(paramAcceptsFailure(makeParam({ variadic: true }))).toBe(false);
  });
  it("alias-wrapped Result rejects (v1 limitation, no alias resolution)", () => {
    expect(
      paramAcceptsFailure(makeParam({ typeHint: { type: "typeAliasVariable", aliasName: "MyR" } })),
    ).toBe(false);
  });
});
