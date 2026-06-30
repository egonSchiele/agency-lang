import { describe, it, expect } from "vitest";
import { decomposeCases } from "./typeCases.js";
import { STRING_T, NUMBER_T } from "./primitives.js";
import type { VariableType } from "../types.js";
import type { TypeAliasEntry } from "../types/typeHints.js";

const RESULT: VariableType = {
  type: "resultType",
  successType: NUMBER_T,
  failureType: STRING_T,
};
const lit = (value: string): VariableType => ({ type: "stringLiteralType", value });
const numLit = (value: string): VariableType => ({ type: "numberLiteralType", value });
const boolLit = (value: "true" | "false"): VariableType => ({ type: "booleanLiteralType", value });
const union = (...types: VariableType[]): VariableType => ({ type: "unionType", types });

describe("decomposeCases", () => {
  it("Result → resultSuccess + resultFailure, closed", () => {
    const r = decomposeCases(RESULT, {});
    expect(r.closed).toBe(true);
    expect(r.cases.map((c) => c.kind).sort()).toEqual(["resultFailure", "resultSuccess"]);
  });

  it("literal union '\"a\" | \"b\"' → two literal cases, closed", () => {
    const r = decomposeCases(union(lit("a"), lit("b")), {});
    expect(r.closed).toBe(true);
    expect(r.cases).toEqual([
      { kind: "literal", value: "a" },
      { kind: "literal", value: "b" },
    ]);
  });

  it("string → open (no cases)", () => {
    expect(decomposeCases(STRING_T, {})).toEqual({ cases: [], closed: false });
  });

  it("any → open", () => {
    expect(decomposeCases("any", {})).toEqual({ cases: [], closed: false });
  });

  it("union containing any → open", () => {
    expect(decomposeCases(union(lit("a"), { type: "primitiveType", value: "any" }), {}).closed).toBe(false);
  });

  it("object union → member cases, closed (coverage is B2; enumeration is here)", () => {
    const obj = (k: string): VariableType => ({
      type: "objectType",
      properties: [{ key: "kind", value: lit(k) }],
    });
    const r = decomposeCases(union(obj("a"), obj("b")), {});
    expect(r.closed).toBe(true);
    expect(r.cases.every((c) => c.kind === "member")).toBe(true);
  });

  it("effect-set union → open (owned by resolveEffectSet, never enumerated here)", () => {
    const eff: VariableType = { type: "unionType", types: [lit("Timeout"), lit("Cancelled")], isEffectSet: true };
    expect(decomposeCases(eff, {})).toEqual({ cases: [], closed: false });
  });

  it("number-literal union → two literal cases, closed", () => {
    const r = decomposeCases(union(numLit("1"), numLit("2")), {});
    expect(r.closed).toBe(true);
    expect(r.cases).toEqual([
      { kind: "literal", value: 1 },
      { kind: "literal", value: 2 },
    ]);
  });

  it("boolean-literal union → two literal cases, closed", () => {
    const r = decomposeCases(union(boolLit("true"), boolLit("false")), {});
    expect(r.closed).toBe(true);
    expect(r.cases).toEqual([
      { kind: "literal", value: true },
      { kind: "literal", value: false },
    ]);
  });

  it("type alias to a literal union resolves through safeResolveType", () => {
    const aliases: Record<string, TypeAliasEntry> = {
      Status: { body: union(lit("a"), lit("b")) },
    };
    const ref: VariableType = { type: "typeAliasVariable", aliasName: "Status" };
    const r = decomposeCases(ref, aliases);
    expect(r.closed).toBe(true);
    expect(r.cases).toEqual([
      { kind: "literal", value: "a" },
      { kind: "literal", value: "b" },
    ]);
  });

  it("mixed literal + member union → [literal, member], closed (contract)", () => {
    const obj: VariableType = { type: "objectType", properties: [{ key: "kind", value: lit("b") }] };
    const r = decomposeCases(union(lit("a"), obj), {});
    expect(r.closed).toBe(true);
    expect(r.cases.map((c) => c.kind)).toEqual(["literal", "member"]);
  });

  it("non-union objectType → open (default fall-through)", () => {
    const obj: VariableType = { type: "objectType", properties: [{ key: "a", value: STRING_T }] };
    expect(decomposeCases(obj, {})).toEqual({ cases: [], closed: false });
  });

  it("boolean primitive → open (NOT enumerated as true|false)", () => {
    expect(decomposeCases({ type: "primitiveType", value: "boolean" }, {})).toEqual({ cases: [], closed: false });
  });

  it("generic/parameterized type → open (conservative)", () => {
    const g: VariableType = { type: "genericType", name: "Box", typeArgs: [STRING_T] };
    expect(decomposeCases(g, {})).toEqual({ cases: [], closed: false });
  });
});
