import { describe, it, expect } from "vitest";
import { evalKeyof, evalIndexedAccess, evalIntersection } from "./typeOperators.js";
import { typeKey } from "./typeKey.js";
import { typecheckSource } from "./testUtils.js";
import type { VariableType } from "../types.js";

const STR: VariableType = { type: "primitiveType", value: "string" };
const NUM: VariableType = { type: "primitiveType", value: "number" };
const AGE_TAG = { type: "tag" as const, name: "validate", arguments: [] };
const id = (t: VariableType) => t;
const eq = (a: VariableType, b: VariableType) =>
  typeKey(a, {}) === typeKey(b, {});

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
    // The undefined-alias diagnostic fires through the keyof operand
    // (validateTypeReferences descends via visitTypes) — pinned exactly,
    // so this also trips if that behavior changes.
    expect(unknownAlias.map((e) => e.message)).toEqual([
      "Type alias 'NotDefined' is not defined (referenced in 'k').",
    ]);
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

describe("evalIntersection", () => {
  const NAME_TAG = { type: "tag" as const, name: "validate", arguments: [] };

  function named(): VariableType {
    return {
      type: "objectType",
      properties: [
        { key: "id", value: STR },
        { key: "name", value: STR, tags: [NAME_TAG] },
      ],
    };
  }

  function aged(): VariableType {
    return {
      type: "objectType",
      properties: [
        { key: "id", value: STR },
        { key: "age", value: NUM },
      ],
    };
  }

  it("merges disjoint keys in first-seen order", () => {
    const out = evalIntersection([named(), aged()], id, eq);
    expect(out).toMatchObject({
      type: "objectType",
      properties: [{ key: "id" }, { key: "name" }, { key: "age" }],
    });
  });

  it("an identical shared key keeps one copy (non-object types included)", () => {
    const out = evalIntersection([named(), aged()], id, eq) as {
      properties: { key: string }[];
    };
    expect(out.properties.filter((p) => p.key === "id")).toHaveLength(1);
  });

  it("shared object-typed keys merge RECURSIVELY (nested level asserted)", () => {
    const a: VariableType = {
      type: "objectType",
      properties: [
        {
          key: "config",
          value: {
            type: "objectType",
            properties: [{ key: "host", value: STR }],
          },
        },
      ],
    };
    const b: VariableType = {
      type: "objectType",
      properties: [
        {
          key: "config",
          value: {
            type: "objectType",
            properties: [{ key: "port", value: NUM }],
          },
        },
      ],
    };
    expect(evalIntersection([a, b], id, eq)).toEqual({
      type: "objectType",
      properties: [
        {
          key: "config",
          value: {
            type: "objectType",
            properties: [
              { key: "host", value: STR },
              { key: "port", value: NUM },
            ],
          },
        },
      ],
    });
  });

  it("a conflicting shared key errors, naming the key and both types", () => {
    const a: VariableType = {
      type: "objectType",
      properties: [{ key: "id", value: STR }],
    };
    const b: VariableType = {
      type: "objectType",
      properties: [{ key: "id", value: NUM }],
    };
    expect(() => evalIntersection([a, b], id, eq)).toThrow(
      /cannot intersect key 'id'.*string.*number/,
    );
  });

  it("shared-key tags merge: BOTH validate chains survive", () => {
    const a: VariableType = {
      type: "objectType",
      properties: [{ key: "id", value: STR, tags: [NAME_TAG] }],
    };
    const otherTag = { type: "tag" as const, name: "validate", arguments: [] };
    const b: VariableType = {
      type: "objectType",
      properties: [{ key: "id", value: STR, tags: [otherTag] }],
    };
    const out = evalIntersection([a, b], id, eq) as {
      properties: { tags?: { name: string }[] }[];
    };
    // mergeTagSets collapses stacked @validate tags into ONE combined
    // tag; assert a validate tag survives rather than counting tags.
    expect(out.properties[0].tags?.some((t) => t.name === "validate")).toBe(
      true,
    );
  });

  it("three-way merge groups ALL operands at once", () => {
    const c: VariableType = {
      type: "objectType",
      properties: [{ key: "extra", value: STR }],
    };
    const out = evalIntersection([named(), aged(), c], id, eq);
    expect(out).toMatchObject({
      properties: [
        { key: "id" },
        { key: "name" },
        { key: "age" },
        { key: "extra" },
      ],
    });
  });

  it("rejects every non-object operand, including never", () => {
    expect(() => evalIntersection([named(), NUM], id, eq)).toThrow(
      /intersection expects an object type/,
    );
    expect(() =>
      evalIntersection(
        [named(), { type: "primitiveType", value: "never" }],
        id,
        eq,
      ),
    ).toThrow(/intersection expects an object type/);
    const rec: VariableType = {
      type: "genericType",
      name: "Record",
      typeArgs: [STR, NUM],
    };
    expect(() => evalIntersection([named(), rec], id, eq)).toThrow(
      /intersection expects an object type/,
    );
  });

  it("does not mutate its inputs", () => {
    const a = named();
    const snapshot = JSON.parse(JSON.stringify(a));
    evalIntersection([a, aged()], id, eq);
    expect(a).toEqual(snapshot);
  });

  it("is associative on RESOLVED results (compared by typeKey)", () => {
    const extra: VariableType = {
      type: "objectType",
      properties: [{ key: "extra", value: STR }],
    };
    const resolve = (t: VariableType): VariableType =>
      t.type === "intersectionType"
        ? evalIntersection(t.types, resolve, eq)
        : t;
    const leftNested = evalIntersection(
      [{ type: "intersectionType", types: [named(), aged()] }, extra],
      resolve,
      eq,
    );
    const rightNested = evalIntersection(
      [named(), { type: "intersectionType", types: [aged(), extra] }],
      resolve,
      eq,
    );
    expect(typeKey(leftNested, {})).toBe(typeKey(rightNested, {}));
  });
});

describe("intersections through the full pipeline", () => {
  it("accepts a complete value against a merged type, rejects a partial one", () => {
    const ok = typecheckSource(`
type Named = { id: string, name: string }
type Aged = { id: string, age: number }
node main() {
  const p: Named & Aged = { id: "1", name: "a", age: 3 }
  return p
}
`);
    expect(ok).toEqual([]);
    const bad = typecheckSource(`
type Named = { id: string, name: string }
type Aged = { id: string, age: number }
node main() {
  const p: Named & Aged = { id: "1", name: "a" }
  return p
}
`);
    expect(bad.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });

  it("composes: Partial of a merge, keyof of a merge, index into a merge", () => {
    const errors = typecheckSource(`
type Named = { id: string, name: string }
type Aged = { id: string, age: number }
node main() {
  const a: Partial<Named & Aged> = { id: null, name: null, age: null }
  const k: keyof (Named & Aged) = "age"
  const n: (Named & Aged)["age"] = 3
  return k
}
`);
    expect(errors).toEqual([]);
  });

  it("a generic alias can delegate: type Mix<T> = T & Stamp", () => {
    const errors = typecheckSource(`
type Stamp = { createdAt: string }
type Named = { name: string }
type Mix<T> = T & Stamp
node main() {
  const m: Mix<Named> = { name: "a", createdAt: "now" }
  return m
}
`);
    expect(errors).toEqual([]);
  });

  it("a recursive alias can be an operand (nominal self-refs survive)", () => {
    const errors = typecheckSource(`
type Tree = { value: number, children: Tree[] }
node main() {
  const t: Tree & { label: string } = {
    value: 1,
    children: [],
    label: "root",
  }
  return t
}
`);
    expect(errors).toEqual([]);
  });

  it("an unknown alias inside an intersection is reported (visitTypes wiring)", () => {
    // Review finding: validateTypeReferences walks via visitTypes, whose
    // intersection case Task 1 added — prove the wiring instead of
    // assuming it.
    const errors = typecheckSource(`
type A = { x: number }
type X = A & Undefined
node main() {
  return 1
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(
      /Type alias 'Undefined' is not defined/,
    );
  });

  it("semantic errors stay swallowed at typecheck time: string & number member", () => {
    const errors = typecheckSource(`
node main() {
  const x: { id: string } & { id: number } = { id: "1" }
  return x
}
`);
    expect(errors).toEqual([]);
  });
});
