import { describe, it, expect } from "vitest";
import { evalUtilityType, isUtilityTypeName, UTILITY_TYPE_ARITY } from "./utilityTypes.js";
import { typecheckSource } from "./testUtils.js";
import type { VariableType } from "../types.js";

const STR: VariableType = { type: "primitiveType", value: "string" };
const NUM: VariableType = { type: "primitiveType", value: "number" };
const NUL: VariableType = { type: "primitiveType", value: "null" };
const id = (t: VariableType) => t;

function user(): VariableType {
  return {
    type: "objectType",
    properties: [
      { key: "name", value: STR, description: "the name" },
      { key: "age", value: NUM },
    ],
  };
}

function lit(value: string): VariableType {
  return { type: "stringLiteralType", value };
}

describe("UTILITY_TYPE_ARITY / isUtilityTypeName", () => {
  it("covers exactly the five names", () => {
    expect(UTILITY_TYPE_ARITY).toEqual({
      Partial: 1,
      Required: 1,
      NonNullable: 1,
      Pick: 2,
      Omit: 2,
    });
    expect(isUtilityTypeName("Partial")).toBe(true);
    expect(isUtilityTypeName("Record")).toBe(false);
  });
});

describe("Partial", () => {
  it("adds null to every property and preserves descriptions", () => {
    const out = evalUtilityType("Partial", [user()], id);
    expect(out).toEqual({
      type: "objectType",
      properties: [
        {
          key: "name",
          value: { type: "unionType", types: [STR, NUL] },
          description: "the name",
        },
        { key: "age", value: { type: "unionType", types: [NUM, NUL] } },
      ],
    });
  });

  it("preserves property tags through the transform", () => {
    const tagged: VariableType = {
      type: "objectType",
      properties: [
        {
          key: "name",
          value: STR,
          tags: [{ type: "tag", name: "validate", arguments: [] }],
        },
      ],
    };
    const out = evalUtilityType("Partial", [tagged], id);
    expect(out).toMatchObject({
      properties: [
        { key: "name", tags: [{ type: "tag", name: "validate", arguments: [] }] },
      ],
    });
  });

  it("does not double-add null to an already-nullable property", () => {
    const t: VariableType = {
      type: "objectType",
      properties: [{ key: "p", value: { type: "unionType", types: [STR, NUL] } }],
    };
    const out = evalUtilityType("Partial", [t], id);
    expect(out).toEqual(t);
  });

  it("does not add null when a property is an ALIAS to a nullable union", () => {
    // Kills the mutation that drops `resolve` from the nullability check:
    // without it, an alias resolving to `string | null` gets a second null.
    const maybe: VariableType = { type: "typeAliasVariable", aliasName: "MaybeStr" };
    const t: VariableType = {
      type: "objectType",
      properties: [{ key: "p", value: maybe }],
    };
    const resolve = (x: VariableType): VariableType =>
      x.type === "typeAliasVariable" && x.aliasName === "MaybeStr"
        ? { type: "unionType", types: [STR, NUL] }
        : x;
    const out = evalUtilityType("Partial", [t], resolve);
    expect(out).toEqual(t); // written alias kept, no null bolted on
  });

  it("does not mutate the input type object", () => {
    // resolveTypeWithGuard can return the alias table's OWN stored body;
    // an in-place rewrite would corrupt the alias for the rest of the compile.
    const input = user();
    const snapshot = JSON.parse(JSON.stringify(input));
    evalUtilityType("Partial", [input], id);
    expect(input).toEqual(snapshot);
  });

  it("rejects a non-object argument", () => {
    expect(() => evalUtilityType("Partial", [NUM], id)).toThrow(
      /Partial expects an object type/,
    );
  });

  it("rejects wrong arity", () => {
    expect(() => evalUtilityType("Partial", [NUM, STR], id)).toThrow(
      /Partial expects 1 type argument, got 2/,
    );
  });
});

describe("Required", () => {
  it("strips null from every property", () => {
    const t: VariableType = {
      type: "objectType",
      properties: [
        { key: "name", value: STR },
        { key: "age", value: { type: "unionType", types: [NUM, NUL] } },
      ],
    };
    const out = evalUtilityType("Required", [t], id);
    expect(out).toEqual({
      type: "objectType",
      properties: [
        { key: "name", value: STR },
        { key: "age", value: NUM },
      ],
    });
  });

  it("turns an exactly-null property into never", () => {
    const t: VariableType = {
      type: "objectType",
      properties: [{ key: "gone", value: NUL }],
    };
    const out = evalUtilityType("Required", [t], id);
    expect(out).toEqual({
      type: "objectType",
      properties: [
        { key: "gone", value: { type: "primitiveType", value: "never" } },
      ],
    });
  });

  it("preserves descriptions and tags (Required rebuilds every property)", () => {
    const t: VariableType = {
      type: "objectType",
      properties: [
        {
          key: "age",
          value: { type: "unionType", types: [NUM, NUL] },
          description: "the age",
          tags: [{ type: "tag", name: "validate", arguments: [] }],
        },
      ],
    };
    const out = evalUtilityType("Required", [t], id);
    expect(out).toMatchObject({
      properties: [
        {
          key: "age",
          value: NUM,
          description: "the age",
          tags: [{ type: "tag", name: "validate", arguments: [] }],
        },
      ],
    });
  });

  it("does not mutate the input type object", () => {
    const input: VariableType = {
      type: "objectType",
      properties: [{ key: "p", value: { type: "unionType", types: [STR, NUL] } }],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    evalUtilityType("Required", [input], id);
    expect(input).toEqual(snapshot);
  });
});

describe("Pick", () => {
  it("keeps named properties in declaration order", () => {
    const t: VariableType = {
      type: "objectType",
      properties: [
        { key: "a", value: STR },
        { key: "b", value: NUM },
        { key: "c", value: STR },
      ],
    };
    // Keys listed out of declaration order — result follows declaration order.
    const keys: VariableType = {
      type: "unionType",
      types: [lit("c"), lit("a")],
    };
    const out = evalUtilityType("Pick", [t, keys], id);
    expect(out).toEqual({
      type: "objectType",
      properties: [
        { key: "a", value: STR },
        { key: "c", value: STR },
      ],
    });
  });

  it("accepts a single literal key (not a union)", () => {
    const out = evalUtilityType("Pick", [user(), lit("name")], id);
    expect(out).toEqual({
      type: "objectType",
      properties: [{ key: "name", value: STR, description: "the name" }],
    });
  });

  it("rejects a key that does not exist, listing available keys", () => {
    expect(() => evalUtilityType("Pick", [user(), lit("nope")], id)).toThrow(
      /Pick key 'nope' does not exist.*name, age/,
    );
  });

  it("rejects a non-literal key argument", () => {
    expect(() => evalUtilityType("Pick", [user(), STR], id)).toThrow(
      /Pick expects string literal keys/,
    );
  });
});

describe("Omit", () => {
  it("removes named properties", () => {
    const out = evalUtilityType("Omit", [user(), lit("age")], id);
    expect(out).toEqual({
      type: "objectType",
      properties: [{ key: "name", value: STR, description: "the name" }],
    });
  });

  it("allows keys that do not exist (TS parity)", () => {
    const out = evalUtilityType("Omit", [user(), lit("nope")], id);
    expect(out).toEqual(user());
  });

  it("Omit of every key produces an empty object type", () => {
    const keys: VariableType = {
      type: "unionType",
      types: [lit("name"), lit("age")],
    };
    const out = evalUtilityType("Omit", [user(), keys], id);
    expect(out).toEqual({ type: "objectType", properties: [] });
  });
});

describe("NonNullable", () => {
  it("strips null from a union", () => {
    const out = evalUtilityType(
      "NonNullable",
      [{ type: "unionType", types: [STR, NUL] }],
      id,
    );
    expect(out).toEqual(STR);
  });

  it("is a no-op without null", () => {
    expect(evalUtilityType("NonNullable", [STR], id)).toEqual(STR);
  });

  it("resolves NonNullable<null> to never", () => {
    expect(evalUtilityType("NonNullable", [NUL], id)).toEqual({
      type: "primitiveType",
      value: "never",
    });
  });

  it("keeps a multi-member union a union", () => {
    const out = evalUtilityType(
      "NonNullable",
      [{ type: "unionType", types: [STR, NUM, NUL] }],
      id,
    );
    expect(out).toEqual({ type: "unionType", types: [STR, NUM] });
  });
});

describe("argument resolution", () => {
  it("resolves alias arguments through the injected resolver", () => {
    const aliasRef: VariableType = { type: "typeAliasVariable", aliasName: "User" };
    const resolve = (t: VariableType) =>
      t.type === "typeAliasVariable" && t.aliasName === "User" ? user() : t;
    const out = evalUtilityType("Pick", [aliasRef, lit("name")], resolve);
    expect(out).toEqual({
      type: "objectType",
      properties: [{ key: "name", value: STR, description: "the name" }],
    });
  });

  it("Required resolves property values so aliased nullables strip", () => {
    const maybe: VariableType = { type: "typeAliasVariable", aliasName: "MaybeStr" };
    const t: VariableType = {
      type: "objectType",
      properties: [{ key: "p", value: maybe }],
    };
    const resolve = (x: VariableType): VariableType =>
      x.type === "typeAliasVariable" && x.aliasName === "MaybeStr"
        ? { type: "unionType", types: [STR, NUL] }
        : x;
    const out = evalUtilityType("Required", [t], resolve);
    expect(out).toEqual({
      type: "objectType",
      properties: [{ key: "p", value: STR }],
    });
  });

  it("Partial keeps the alias reference when it is not nullable", () => {
    const aliasVal: VariableType = { type: "typeAliasVariable", aliasName: "Name" };
    const t: VariableType = {
      type: "objectType",
      properties: [{ key: "p", value: aliasVal }],
    };
    const resolve = (x: VariableType) =>
      x.type === "typeAliasVariable" && x.aliasName === "Name" ? STR : x;
    const out = evalUtilityType("Partial", [t], resolve);
    // The written alias survives inside the union; null is appended.
    expect(out).toEqual({
      type: "objectType",
      properties: [{ key: "p", value: { type: "unionType", types: [aliasVal, NUL] } }],
    });
  });

  it("NonNullable resolves alias arguments", () => {
    // Kills the mutation that drops `resolve` from NonNullable — every other
    // NonNullable test hands in an already-concrete type.
    const aliasRef: VariableType = { type: "typeAliasVariable", aliasName: "MaybeStr" };
    const resolve = (x: VariableType): VariableType =>
      x.type === "typeAliasVariable" && x.aliasName === "MaybeStr"
        ? { type: "unionType", types: [STR, NUL] }
        : x;
    expect(evalUtilityType("NonNullable", [aliasRef], resolve)).toEqual(STR);
  });

  it("composes when the argument is itself a utility application", () => {
    // Partial<Pick<User, "name">> — the inner application arrives as a
    // genericType arg and evaluates through the injected resolver, exactly
    // as the real resolveTypeWithGuard callback does.
    const inner: VariableType = {
      type: "genericType",
      name: "Pick",
      typeArgs: [user(), lit("name")],
    };
    const resolve = (t: VariableType): VariableType =>
      t.type === "genericType" ? evalUtilityType(t.name, t.typeArgs, resolve) : t;
    const out = evalUtilityType("Partial", [inner], resolve);
    expect(out).toEqual({
      type: "objectType",
      properties: [
        {
          key: "name",
          value: { type: "unionType", types: [STR, NUL] },
          description: "the name",
        },
      ],
    });
  });
});

describe("utility types through the full typecheck pipeline", () => {
  it("accepts a valid Partial assignment (keys still required, values nullable)", () => {
    const errors = typecheckSource(`
type User = { name: string, age: number }
node main() {
  const changes: Partial<User> = { name: null, age: 1 }
  return changes
}
`);
    expect(errors).toEqual([]);
  });

  it("rejects a wrongly-typed property under Partial", () => {
    // The anti-any sentinel: if the resolver branch threw and safeResolveType
    // silently degraded Partial<User> to any, this would pass with 0 errors.
    // NOTE: the RHS deliberately contains no null literal — a null literal
    // synths to "any" (no case "null" in synthType), which makes synthObject
    // bail and skip the check entirely. Pre-existing lenience, not utility-
    // type behavior.
    const errors = typecheckSource(`
type User = { name: string, age: number }
node main() {
  const changes: Partial<User> = { name: 1, age: 2 }
  return changes
}
`);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });

  it("narrows a Partial property with a null guard", () => {
    const errors = typecheckSource(`
type User = { name: string }
def f(c: Partial<User>): string {
  if (c.name != null) {
    return c.name
  }
  return "none"
}
node main() {
  return f({ name: "x" })
}
`);
    expect(errors).toEqual([]);
  });

  it("Pick produces a subset type", () => {
    const errors = typecheckSource(`
type User = { name: string, age: number }
node main() {
  const c: Pick<User, "name"> = { name: "x" }
  return c
}
`);
    expect(errors).toEqual([]);
  });

  it("reports arity errors as located diagnostics", () => {
    const errors = typecheckSource(`
type User = { name: string }
type Bad = Partial<User, User>
node main() {
  return 1
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(
      /Partial expects 1 type argument, got 2/,
    );
  });

  it("rejects user redefinition of the five reserved names", () => {
    const errors = typecheckSource(`
type Partial = { x: number }
node main() {
  return 1
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(
      /'Partial' is a reserved built-in type/,
    );
  });

  it("semantic argument errors do NOT surface as typecheck diagnostics (known gap, spec follow-up)", () => {
    // Pins verified current behavior: the resolver TypeError is swallowed by
    // safeResolveType (annotation degrades to any); the user first sees the
    // error at codegen via resolveTypeDeep. Same as Record key errors today.
    const errors = typecheckSource(`
type User = { name: string }
node main() {
  const c: Pick<User, "nope"> = {}
  return 1
}
`);
    expect(errors).toEqual([]);
  });

  it("bare Partial without type arguments: pin the current diagnostic", () => {
    // Parses as a typeAliasVariable, missing the genericType branch entirely.
    // The message is confusing for a reserved name, but pinning it makes the
    // behavior a decision rather than an accident.
    const errors = typecheckSource(`
node main() {
  const c: Partial = { }
  return 1
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(
      /Type alias 'Partial' is not defined/,
    );
  });

  it("a user generic alias can delegate to a utility type", () => {
    // type PartialOf<T> = Partial<T>: the declaration validates clean (T is
    // stubbed as a self-referential alias, no eager evaluation happens);
    // the use site substitutes T := User, then re-resolves into the branch.
    const errors = typecheckSource(`
type User = { name: string, age: number }
type PartialOf<T> = Partial<T>
node main() {
  const c: PartialOf<User> = { name: null, age: null }
  return c
}
`);
    expect(errors).toEqual([]);
  });
});
