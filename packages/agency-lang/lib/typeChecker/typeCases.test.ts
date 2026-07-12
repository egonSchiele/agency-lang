import { ANY_T } from "./primitives.js";
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
const obj = (props: Record<string, VariableType>): VariableType => ({
  type: "objectType",
  properties: Object.entries(props).map(([key, value]) => ({ key, value })),
});

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
    expect(decomposeCases(ANY_T, {})).toEqual({ cases: [], closed: false });
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

  it("boolean primitive → true | false, closed (B2 enumerates it)", () => {
    expect(decomposeCases({ type: "primitiveType", value: "boolean" }, {})).toEqual({
      cases: [{ kind: "literal", value: true }, { kind: "literal", value: false }],
      closed: true,
    });
  });

  it("generic/parameterized type → open (conservative)", () => {
    const g: VariableType = { type: "genericType", name: "Box", typeArgs: [STRING_T] };
    expect(decomposeCases(g, {})).toEqual({ cases: [], closed: false });
  });
});

describe("decomposeCases — discriminated object unions (B2)", () => {
  it("tags a discriminated object union by its discriminant", () => {
    const ev = union(obj({ kind: lit("click"), x: NUMBER_T }), obj({ kind: lit("scroll"), d: NUMBER_T }));
    const cs = decomposeCases(ev, {});
    expect(cs.closed).toBe(true);
    expect(cs.cases).toEqual([
      { kind: "member", type: expect.anything(), disc: { prop: "kind", value: "click" } },
      { kind: "member", type: expect.anything(), disc: { prop: "kind", value: "scroll" } },
    ]);
  });

  it("leaves a non-discriminated object union as opaque members", () => {
    const u = union(obj({ a: NUMBER_T }), obj({ b: STRING_T }));
    expect(decomposeCases(u, {}).cases.every((c) => c.kind === "member" && c.disc === undefined)).toBe(true);
  });

  it("does not discriminate a union with a shared tag value", () => {
    const u = union(obj({ kind: lit("a"), x: NUMBER_T }), obj({ kind: lit("a"), y: STRING_T }));
    expect(decomposeCases(u, {}).cases.every((c) => c.kind === "member" && c.disc === undefined)).toBe(true);
  });

  it("does not discriminate when a member is not an object", () => {
    const u = union(obj({ kind: lit("a") }), STRING_T);
    expect(decomposeCases(u, {}).cases.some((c) => c.kind === "member" && c.disc)).toBe(false);
  });

  it("discriminates a 3-member union", () => {
    const u = union(obj({ kind: lit("a") }), obj({ kind: lit("b") }), obj({ kind: lit("c") }));
    const disc = decomposeCases(u, {}).cases.map((c) => (c.kind === "member" ? c.disc?.value : null));
    expect(disc).toEqual(["a", "b", "c"]);
  });

  it("discriminates a boolean-tagged union", () => {
    const u = union(obj({ open: boolLit("true"), x: NUMBER_T }), obj({ open: boolLit("false"), y: STRING_T }));
    const disc = decomposeCases(u, {}).cases.map((c) => (c.kind === "member" ? c.disc : null));
    expect(disc).toEqual([{ prop: "open", value: true }, { prop: "open", value: false }]);
  });

  it("advances past a shared-value literal prop to a later discriminating one", () => {
    const u = union(
      obj({ version: numLit("1"), kind: lit("a") }),
      obj({ version: numLit("1"), kind: lit("b") }),
    );
    const disc = decomposeCases(u, {}).cases.map((c) => (c.kind === "member" ? c.disc : null));
    expect(disc).toEqual([{ prop: "kind", value: "a" }, { prop: "kind", value: "b" }]);
  });

  it("does not discriminate when a member is itself a nested union", () => {
    const u = union(obj({ kind: lit("a") }), union(obj({ kind: lit("b") }), STRING_T));
    expect(decomposeCases(u, {}).cases.some((c) => c.kind === "member" && c.disc)).toBe(false);
  });

  it("discriminates through a type alias of the union", () => {
    const ev = union(obj({ kind: lit("a") }), obj({ kind: lit("b") }));
    const aliases: Record<string, TypeAliasEntry> = { Ev: { body: ev } };
    const ref: VariableType = { type: "typeAliasVariable", aliasName: "Ev" };
    const disc = decomposeCases(ref, aliases).cases.map((c) => (c.kind === "member" ? c.disc?.value : null));
    expect(disc).toEqual(["a", "b"]);
  });
});
