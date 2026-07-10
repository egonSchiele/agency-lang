import { describe, it, expect } from "vitest";
import { evalKeyof, evalIndexedAccess } from "./typeOperators.js";
import { typecheckSource } from "./testUtils.js";
import type { VariableType } from "../types.js";

const STR: VariableType = { type: "primitiveType", value: "string" };
const NUM: VariableType = { type: "primitiveType", value: "number" };
const AGE_TAG = { type: "tag" as const, name: "validate", arguments: [] };
const id = (t: VariableType) => t;

function user(): VariableType {
  return {
    type: "objectType",
    properties: [
      { key: "name", value: STR },
      { key: "age", value: { ...NUM, tags: [AGE_TAG] } },
    ],
  };
}

function lit(value: string): VariableType {
  return { type: "stringLiteralType", value };
}

describe("evalKeyof", () => {
  it("returns the union of key literals", () => {
    expect(evalKeyof(user(), id)).toEqual({
      type: "unionType",
      types: [lit("name"), lit("age")],
    });
  });

  it("returns a single literal for a one-key object (no union wrapper)", () => {
    const one: VariableType = {
      type: "objectType",
      properties: [{ key: "only", value: STR }],
    };
    expect(evalKeyof(one, id)).toEqual(lit("only"));
  });

  it("returns never for an empty object", () => {
    expect(evalKeyof({ type: "objectType", properties: [] }, id)).toEqual({
      type: "primitiveType",
      value: "never",
    });
  });

  it("resolves alias operands through the injected resolver", () => {
    const ref: VariableType = { type: "typeAliasVariable", aliasName: "User" };
    const resolve = (t: VariableType) =>
      t.type === "typeAliasVariable" && t.aliasName === "User" ? user() : t;
    expect(evalKeyof(ref, resolve)).toMatchObject({ type: "unionType" });
  });

  it("rejects every non-object operand form in the spec table", () => {
    expect(() => evalKeyof(NUM, id)).toThrow(/keyof expects an object type/);
    expect(() =>
      evalKeyof({ type: "arrayType", elementType: STR }, id),
    ).toThrow(/keyof expects an object type/);
    const rec: VariableType = {
      type: "genericType",
      name: "Record",
      typeArgs: [STR, NUM],
    };
    expect(() => evalKeyof(rec, id)).toThrow(/keyof expects an object type/);
    const union: VariableType = { type: "unionType", types: [user(), user()] };
    expect(() => evalKeyof(union, id)).toThrow(/keyof expects an object type/);
  });

  it("does not mutate its input", () => {
    const input = user();
    const snapshot = JSON.parse(JSON.stringify(input));
    evalKeyof(input, id);
    expect(input).toEqual(snapshot);
  });
});

describe("evalIndexedAccess", () => {
  it("returns the property type WITH its tags", () => {
    expect(evalIndexedAccess(user(), lit("age"), id)).toEqual({
      type: "primitiveType",
      value: "number",
      tags: [AGE_TAG],
    });
  });

  it("a union index yields the union of property VALUE types (exact members)", () => {
    const idx: VariableType = {
      type: "unionType",
      types: [lit("name"), lit("age")],
    };
    expect(evalIndexedAccess(user(), idx, id)).toEqual({
      type: "unionType",
      types: [STR, { ...NUM, tags: [AGE_TAG] }],
    });
  });

  it("composes: indexing by keyof gives all VALUE types (exact members)", () => {
    expect(evalIndexedAccess(user(), evalKeyof(user(), id), id)).toEqual({
      type: "unionType",
      types: [STR, { ...NUM, tags: [AGE_TAG] }],
    });
  });

  it("rejects a missing key in the Pick wording family", () => {
    expect(() => evalIndexedAccess(user(), lit("nope"), id)).toThrow(
      /indexed access key 'nope' does not exist on the target type.*name, age/,
    );
  });

  it("rejects a non-literal index (shared resolveKeysArg wording)", () => {
    expect(() => evalIndexedAccess(user(), STR, id)).toThrow(
      /expects string literal keys/,
    );
  });

  it("rejects a non-object base", () => {
    expect(() => evalIndexedAccess(NUM, lit("a"), id)).toThrow(
      /expects an object type/,
    );
  });
});

describe("type operators through the full pipeline", () => {
  it("keyof produces a closed union: match gets exhaustiveness checking", () => {
    const errors = typecheckSource(`
type User = { name: string, age: number }
def label(field: keyof User): string {
  return match (field) {
    "name" => "the name"
    "age" => "the age"
  }
}
node main() {
  return label("name")
}
`);
    expect(errors).toEqual([]);
  });

  it("a match missing a key case is reported", () => {
    const errors = typecheckSource(`
type User = { name: string, age: number }
def label(field: keyof User): string {
  return match (field) {
    "name" => "the name"
  }
}
node main() {
  return label("name")
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/age/);
  });

  it("rejects a non-key value against a keyof annotation (direct negative)", () => {
    const errors = typecheckSource(`
type User = { name: string, age: number }
node main() {
  const k: keyof User = "bogus"
  return k
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });

  it("indexed access types an annotation, and rejects a mismatch", () => {
    const ok = typecheckSource(`
type User = { name: string, age: number }
node main() {
  const n: User["name"] = "x"
  return n
}
`);
    expect(ok).toEqual([]);
    const bad = typecheckSource(`
type User = { name: string, age: number }
node main() {
  const n: User["name"] = 5
  return n
}
`);
    expect(bad.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });

  it("indexing an optional property includes null (desugared p?: interaction)", () => {
    const errors = typecheckSource(`
type User = { name: string, nickname?: string }
node main() {
  const n: User["nickname"] = null
  return n
}
`);
    expect(errors).toEqual([]);
  });

  it("keyof works on a recursive alias (keys are top-level)", () => {
    const errors = typecheckSource(`
type Tree = {
  value: number,
  children: Tree[],
}
node main() {
  const k: keyof Tree = "children"
  return k
}
`);
    expect(errors).toEqual([]);
  });

  it("chained indexed access resolves left to right", () => {
    const errors = typecheckSource(`
type User = {
  name: string,
  address: {
    city: string,
  },
}
node main() {
  const c: User["address"]["city"] = "sf"
  return c
}
`);
    expect(errors).toEqual([]);
  });

  it("composes with the utility types: Pick by keyof, Partial of an indexed type", () => {
    const errors = typecheckSource(`
type User = {
  name: string,
  address: {
    city: string,
  },
}
node main() {
  const u: Pick<User, keyof User> = { name: "a", address: { city: "sf" } }
  const a: Partial<User["address"]> = { city: null }
  return u
}
`);
    expect(errors).toEqual([]);
  });

  it("a generic alias can delegate: type Keys<T> = keyof T", () => {
    const errors = typecheckSource(`
type User = { name: string, age: number }
type Keys<T> = keyof T
node main() {
  const k: Keys<User> = "name"
  return k
}
`);
    expect(errors).toEqual([]);
  });

  it("semantic errors stay swallowed at typecheck time: keyof number", () => {
    const errors = typecheckSource(`
node main() {
  const k: keyof number = "x"
  return k
}
`);
    expect(errors).toEqual([]);
  });

  it("semantic errors stay swallowed: missing key in source, and keyof of an UNKNOWN alias", () => {
    // Both land in the swallowed-TypeError family (safeResolveType
    // degrades to any; codegen surfaces fatally). Pinned as tripwires for
    // the located-diagnostics follow-up.
    const missingKey = typecheckSource(`
type User = { name: string }
node main() {
  const x: User["nope"] = 1
  return x
}
`);
    expect(missingKey).toEqual([]);
    const unknownAlias = typecheckSource(`
node main() {
  const k: keyof NotDefined = "x"
  return k
}
`);
    // The undefined-alias diagnostic may legitimately fire here (operand
    // reference validation); assert only that nothing CRASHES.
    expect(Array.isArray(unknownAlias)).toBe(true);
  });

  it("user redefinition of keyof as an alias name is rejected", () => {
    const errors = typecheckSource(`
type keyof = { x: number }
node main() {
  return 1
}
`);
    expect(errors.length).toBeGreaterThan(0);
  });
});
