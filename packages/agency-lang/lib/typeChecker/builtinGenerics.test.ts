import { describe, it, expect } from "vitest";
import {
  evalBuiltinGeneric,
  isBuiltinGenericName,
  BUILTIN_GENERIC_ARITY,
  RESERVED_GENERIC_NAMES,
} from "./builtinGenerics.js";
import { resolveType } from "./assignability.js";
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

describe("the built-in generics registry", () => {
  it("covers all eight built-in generic forms with their arities", () => {
    expect(BUILTIN_GENERIC_ARITY).toEqual({
      Array: 1,
      Schema: 1,
      Record: 2,
      Partial: 1,
      Required: 1,
      NonNullable: 1,
      Pick: 2,
      Omit: 2,
    });
    expect(isBuiltinGenericName("Partial")).toBe(true);
    expect(isBuiltinGenericName("Record")).toBe(true);
    expect(isBuiltinGenericName("Unrelated")).toBe(false);
  });

  it("reserves exactly the five utility-type names (Array/Schema/Record stay shadowable)", () => {
    expect([...RESERVED_GENERIC_NAMES].sort()).toEqual(
      ["NonNullable", "Omit", "Partial", "Pick", "Required"].sort(),
    );
  });
});

describe("container forms through the registry", () => {
  it("Array lowers to arrayType", () => {
    expect(evalBuiltinGeneric("Array", [STR], id)).toEqual({
      type: "arrayType",
      elementType: STR,
    });
  });

  it("Schema lowers to schemaType", () => {
    expect(evalBuiltinGeneric("Schema", [NUM], id)).toEqual({
      type: "schemaType",
      inner: NUM,
    });
  });

  it("Record keeps its genericType wrapper with resolved args and use-site tags", () => {
    const tag = { type: "tag" as const, name: "validate", arguments: [] };
    const out = evalBuiltinGeneric("Record", [STR, NUM], id, [tag]);
    expect(out).toEqual({
      type: "genericType",
      name: "Record",
      typeArgs: [STR, NUM],
      tags: [tag],
    });
  });

  it("Record rejects an invalid key type", () => {
    expect(() =>
      evalBuiltinGeneric("Record", [{ type: "primitiveType", value: "boolean" }, NUM], id),
    ).toThrow(/Record key type must be/);
  });
});

describe("Partial", () => {
  it("adds null to every property and preserves descriptions", () => {
    const out = evalBuiltinGeneric("Partial", [user()], id);
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
    const out = evalBuiltinGeneric("Partial", [tagged], id);
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
    const out = evalBuiltinGeneric("Partial", [t], id);
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
    const out = evalBuiltinGeneric("Partial", [t], resolve);
    expect(out).toEqual(t); // written alias kept, no null bolted on
  });

  it("does not mutate the input type object", () => {
    // resolveTypeWithGuard can return the alias table's OWN stored body;
    // an in-place rewrite would corrupt the alias for the rest of the compile.
    const input = user();
    const snapshot = JSON.parse(JSON.stringify(input));
    evalBuiltinGeneric("Partial", [input], id);
    expect(input).toEqual(snapshot);
  });

  it("rejects a non-object argument", () => {
    expect(() => evalBuiltinGeneric("Partial", [NUM], id)).toThrow(
      /Partial expects an object type/,
    );
  });

  it("rejects wrong arity", () => {
    expect(() => evalBuiltinGeneric("Partial", [NUM, STR], id)).toThrow(
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
    const out = evalBuiltinGeneric("Required", [t], id);
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
    const out = evalBuiltinGeneric("Required", [t], id);
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
    const out = evalBuiltinGeneric("Required", [t], id);
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
    evalBuiltinGeneric("Required", [input], id);
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
    const out = evalBuiltinGeneric("Pick", [t, keys], id);
    expect(out).toEqual({
      type: "objectType",
      properties: [
        { key: "a", value: STR },
        { key: "c", value: STR },
      ],
    });
  });

  it("accepts a single literal key (not a union)", () => {
    const out = evalBuiltinGeneric("Pick", [user(), lit("name")], id);
    expect(out).toEqual({
      type: "objectType",
      properties: [{ key: "name", value: STR, description: "the name" }],
    });
  });

  it("rejects a key that does not exist, listing available keys", () => {
    expect(() => evalBuiltinGeneric("Pick", [user(), lit("nope")], id)).toThrow(
      /Pick key 'nope' does not exist.*name, age/,
    );
  });

  it("rejects a non-literal key argument", () => {
    expect(() => evalBuiltinGeneric("Pick", [user(), STR], id)).toThrow(
      /Pick expects string literal keys/,
    );
  });
});

describe("Omit", () => {
  it("removes named properties", () => {
    const out = evalBuiltinGeneric("Omit", [user(), lit("age")], id);
    expect(out).toEqual({
      type: "objectType",
      properties: [{ key: "name", value: STR, description: "the name" }],
    });
  });

  it("allows keys that do not exist (TS parity)", () => {
    const out = evalBuiltinGeneric("Omit", [user(), lit("nope")], id);
    expect(out).toEqual(user());
  });

  it("Omit of every key produces an empty object type", () => {
    const keys: VariableType = {
      type: "unionType",
      types: [lit("name"), lit("age")],
    };
    const out = evalBuiltinGeneric("Omit", [user(), keys], id);
    expect(out).toEqual({ type: "objectType", properties: [] });
  });
});

describe("NonNullable", () => {
  it("strips null from a union", () => {
    const out = evalBuiltinGeneric(
      "NonNullable",
      [{ type: "unionType", types: [STR, NUL] }],
      id,
    );
    expect(out).toEqual(STR);
  });

  it("is a no-op without null", () => {
    expect(evalBuiltinGeneric("NonNullable", [STR], id)).toEqual(STR);
  });

  it("resolves NonNullable<null> to never", () => {
    expect(evalBuiltinGeneric("NonNullable", [NUL], id)).toEqual({
      type: "primitiveType",
      value: "never",
    });
  });

  it("keeps a multi-member union a union", () => {
    const out = evalBuiltinGeneric(
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
    const out = evalBuiltinGeneric("Pick", [aliasRef, lit("name")], resolve);
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
    const out = evalBuiltinGeneric("Required", [t], resolve);
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
    const out = evalBuiltinGeneric("Partial", [t], resolve);
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
    expect(evalBuiltinGeneric("NonNullable", [aliasRef], resolve)).toEqual(STR);
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
      t.type === "genericType" ? evalBuiltinGeneric(t.name, t.typeArgs, resolve) : t;
    const out = evalBuiltinGeneric("Partial", [inner], resolve);
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
    // The null literal alongside the bad property also exercises the
    // synthObject null fix (see nullLiteralSynth.test.ts) — null used to
    // poison the whole literal to "any" and skip this check.
    const errors = typecheckSource(`
type User = { name: string, age: number }
node main() {
  const changes: Partial<User> = { name: 1, age: null }
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

describe("registry lookup safety (prototype chain)", () => {
  it("does not treat Object.prototype keys as utility types", () => {
    expect(isBuiltinGenericName("toString")).toBe(false);
    expect(isBuiltinGenericName("constructor")).toBe(false);
    expect(isBuiltinGenericName("hasOwnProperty")).toBe(false);
  });

  it("an unknown generic named like a prototype key does not misroute into the builtin path", () => {
    // The registry lookups are own-property guarded, so 'toString' is NOT
    // treated as a builtin generic (that used to produce a garbled arity
    // message quoting Object.prototype.toString). The residual diagnostic
    // wording comes from validate.ts indexing the ALIAS table bare —
    // typeAliases["toString"] finds Object.prototype.toString, so the
    // message says "not a generic type" instead of "Unknown generic type".
    // That alias-table prototype hazard is pre-existing and codebase-wide;
    // pinned here as-is.
    const errors = typecheckSource(`
type X = toString<number>
node main() {
  return 1
}
`);
    const messages = errors.map((e) => e.message).join("\n");
    expect(messages).not.toMatch(/expects function/); // the old garbled arity path
    expect(messages).toMatch(/Type 'toString' is not a generic type/);
  });
});

describe("use-site tag precedence", () => {
  it("use-site validate tags apply AFTER argument alias tags (alias first, use-site on top)", () => {
    // mergeTagSets contract: alias validators first, then use-site validators,
    // collapsed into one @validate tag. The resolver branch must pass the
    // genericType occurrence's own tags as the USE-SITE side.
    const aliasTag = {
      type: "tag" as const,
      name: "validate",
      arguments: [{ type: "variableName" as const, value: "fromAlias" }],
    };
    const useSiteTag = {
      type: "tag" as const,
      name: "validate",
      arguments: [{ type: "variableName" as const, value: "fromUseSite" }],
    };
    const aliases = {
      Tagged: {
        body: {
          type: "objectType" as const,
          properties: [{ key: "p", value: STR }],
        },
        tags: [aliasTag],
      },
    };
    const vt = {
      type: "genericType" as const,
      name: "Partial",
      typeArgs: [{ type: "typeAliasVariable" as const, aliasName: "Tagged" }],
      tags: [useSiteTag],
    };
    const resolved = resolveType(vt as any, aliases as any);
    expect(resolved.type).toBe("objectType");
    const validate = (resolved.tags ?? []).find((t) => t.name === "validate");
    expect(validate).toBeDefined();
    expect(
      validate!.arguments.map((a) => (a as { value: string }).value),
    ).toEqual(["fromAlias", "fromUseSite"]);
  });
});
