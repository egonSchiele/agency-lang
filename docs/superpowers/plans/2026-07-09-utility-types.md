# Built-in Utility Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (owner preference: inline execution in the main session, NOT subagent-driven). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five built-in utility types — `Partial`, `Required`, `Pick`, `Omit`, `NonNullable` — eagerly evaluated at type resolution, per the approved spec `docs/superpowers/specs/2026-07-09-utility-types-design.md`.

**Architecture:** One new pure module (`lib/typeChecker/utilityTypes.ts`) owns all five transforms. One branch in `resolveTypeWithGuard` (`lib/typeChecker/assignability.ts`) delegates to it, beside the existing `Array`/`Schema`/`Record` branches. Arity diagnostics ride the existing `BUILTIN_GENERIC_ARITY` table; the five names join `RESERVED_TYPE_NAMES`. Nothing downstream changes — results are ordinary `objectType`/union types.

**Tech Stack:** TypeScript, vitest, the existing agency test runner (`pnpm run agency test`), `make fixtures`.

## Global Constraints

- Work on a branch, never on `main` (owner rule). `main` has unrelated uncommitted changes — use a worktree: `git worktree add .claude/worktrees/utility-types -b utility-types` and work there.
- **Worktree setup (do this before Task 1):** a fresh worktree has no `node_modules` and no `dist`, so the first test run would fail on missing vitest instead of the intended red. Run:

  ```bash
  cd .claude/worktrees/utility-types && pnpm install
  cd packages/agency-lang && make   # populates dist/ for the later CLI steps
  ```
- Optionality is `| null`; Agency has no `undefined`. All transforms are shallow.
- `Record<K,V>` arguments to the four object transforms are errors (v1 decision).
- No dynamic imports; objects not Maps; arrays not Sets; types not interfaces (repo rules).
- `utilityTypes.ts` must NOT import from `assignability.ts` (the resolver is injected) — this is the cycle-prevention rule.
- Commit messages: no apostrophes on the command line (repo rule); the messages below are apostrophe-free.
- Save test output to files (repo rule); run `make` before any step that uses the CLI (`pnpm run agency ...`), because the CLI runs from `dist/`.
- In Agency source, object keys are always required — `Partial` lets you pass `null`, not omit the key. Key omission is only forgiven by `schema(...).parseJSON` (optional-coalesce mode). The docs task must state this.

---

### Task 1: `utilityTypes.ts` module with unit tests

**Files:**
- Create: `lib/typeChecker/utilityTypes.ts`
- Test: `lib/typeChecker/utilityTypes.test.ts`

**Interfaces:**
- Consumes: `VariableType` (`lib/types.js`), `NEVER_T`/`NULL_T` (`./primitives.js`), `formatTypeHint` (`../utils/formatType.js`).
- Produces (later tasks rely on these exact names):
  - `UTILITY_TYPE_ARITY: Record<string, number>` — `{ Partial: 1, Required: 1, NonNullable: 1, Pick: 2, Omit: 2 }`
  - `isUtilityTypeName(name: string): boolean`
  - `evalUtilityType(name: string, typeArgs: VariableType[], resolve: (t: VariableType) => VariableType): VariableType` — throws `TypeError` on invalid input.
  - NOTE (intentional spec drift): the spec shows `evalUtilityType(name, typeArgs, aliases, resolve)`. The `aliases` parameter is deliberately dropped — the `resolve` closure carries the alias table. Do not restore it.

- [ ] **Step 1: Write the failing tests**

Create `lib/typeChecker/utilityTypes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evalUtilityType, isUtilityTypeName, UTILITY_TYPE_ARITY } from "./utilityTypes.js";
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
    const resolve = (x: VariableType) =>
      x.type === "typeAliasVariable" && x.aliasName === "MaybeStr"
        ? ({ type: "unionType", types: [STR, NUL] } as VariableType)
        : x.type === "objectType"
          ? x
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd .claude/worktrees/utility-types/packages/agency-lang
pnpm test:run lib/typeChecker/utilityTypes.test.ts > /tmp/ut-task1-red.log 2>&1; tail -5 /tmp/ut-task1-red.log
```

Expected: FAIL — cannot find module `./utilityTypes.js`.

- [ ] **Step 3: Implement the module**

Create `lib/typeChecker/utilityTypes.ts`:

```ts
import type { VariableType } from "../types.js";
import type { ObjectType } from "../types/typeHints.js";
import { formatTypeHint } from "../utils/formatType.js";
import { NEVER_T, NULL_T } from "./primitives.js";

/**
 * Built-in utility types (Partial, Required, Pick, Omit, NonNullable),
 * modeled on TypeScript and adapted to Agency null-based optionality
 * (`p?: V` desugars to `p: V | null` at parse time; there is no undefined).
 *
 * All transforms are EAGER: `evalUtilityType` runs during type resolution
 * (`resolveTypeWithGuard` in assignability.ts) and returns a plain
 * objectType / union, so nothing downstream (assignability, narrowing,
 * codegen) knows these types exist. See
 * docs/superpowers/specs/2026-07-09-utility-types-design.md.
 *
 * CYCLE RULE: this module must not import assignability.ts — the resolver
 * is injected as the `resolve` callback so alias arguments resolve with the
 * caller's in-progress guard (recursion degrades gracefully, see #470).
 */
type Resolve = (t: VariableType) => VariableType;

function isNullType(t: VariableType): boolean {
  return t.type === "primitiveType" && t.value === "null";
}

function includesNull(t: VariableType): boolean {
  if (isNullType(t)) return true;
  return t.type === "unionType" && t.types.some(isNullType);
}

/** V -> V | null. Caller has already checked `includesNull`. */
function addNull(t: VariableType): VariableType {
  if (t.type === "unionType") return { ...t, types: [...t.types, NULL_T] };
  return { type: "unionType", types: [t, NULL_T] };
}

/**
 * Strip null members; a type that is ONLY null becomes never.
 *
 * NEAR-DUPLICATE of the private `stripNullable` in synthesizer.ts — kept
 * separate ON PURPOSE: that copy serves value-level narrowing (returns
 * `undefined` for the empty case and also strips `undefined`); this one is
 * type-level and must produce `never`. Do not deduplicate them.
 */
function stripNull(t: VariableType): VariableType {
  if (isNullType(t)) return NEVER_T;
  if (t.type !== "unionType") return t;
  const kept = t.types.filter((m) => !isNullType(m));
  if (kept.length === 0) return NEVER_T;
  if (kept.length === 1) return kept[0];
  return { ...t, types: kept };
}

function resolveObjectArg(name: string, arg: VariableType, resolve: Resolve): ObjectType {
  const resolved = resolve(arg);
  if (resolved.type !== "objectType") {
    throw new TypeError(
      `${name} expects an object type, got '${formatTypeHint(resolved)}'`,
    );
  }
  return resolved;
}

/** K must resolve to a string literal or a union of string literals. */
function resolveKeysArg(name: string, arg: VariableType, resolve: Resolve): string[] {
  const resolved = resolve(arg);
  const members = resolved.type === "unionType" ? resolved.types : [resolved];
  return members.map((member) => {
    const resolvedMember = resolve(member);
    if (resolvedMember.type !== "stringLiteralType") {
      throw new TypeError(
        `${name} expects string literal keys, got '${formatTypeHint(resolved)}'`,
      );
    }
    return resolvedMember.value;
  });
}

/**
 * The single source of truth: name -> arity + transform. Adding a utility
 * type is one entry here; UTILITY_TYPE_ARITY (consumed by validate.ts and
 * RESERVED_TYPE_NAMES in index.ts) is derived from it.
 */
const UTILITY_TYPES: Record<
  string,
  { arity: number; apply: (typeArgs: VariableType[], resolve: Resolve) => VariableType }
> = {
  Partial: {
    arity: 1,
    apply: ([target], resolve) => {
      const obj = resolveObjectArg("Partial", target, resolve);
      return {
        ...obj,
        properties: obj.properties.map((p) =>
          // Resolve only to DECIDE nullability; keep the written value in the
          // output so alias references survive into codegen/doc output.
          includesNull(resolve(p.value)) ? p : { ...p, value: addNull(p.value) },
        ),
      };
    },
  },
  Required: {
    arity: 1,
    apply: ([target], resolve) => {
      const obj = resolveObjectArg("Required", target, resolve);
      return {
        ...obj,
        // Must resolve to rewrite: an alias to `string | null` has to strip.
        // This inlines aliased property types; acceptable, spec-noted.
        properties: obj.properties.map((p) => ({
          ...p,
          value: stripNull(resolve(p.value)),
        })),
      };
    },
  },
  Pick: {
    arity: 2,
    apply: ([target, keyArg], resolve) => {
      const obj = resolveObjectArg("Pick", target, resolve);
      const keys = resolveKeysArg("Pick", keyArg, resolve);
      const available = obj.properties.map((p) => p.key);
      for (const key of keys) {
        if (!available.includes(key)) {
          throw new TypeError(
            `Pick key '${key}' does not exist on the target type. Available keys: ${available.join(", ")}`,
          );
        }
      }
      return {
        ...obj,
        properties: obj.properties.filter((p) => keys.includes(p.key)),
      };
    },
  },
  Omit: {
    arity: 2,
    apply: ([target, keyArg], resolve) => {
      const obj = resolveObjectArg("Omit", target, resolve);
      const keys = resolveKeysArg("Omit", keyArg, resolve);
      return {
        ...obj,
        properties: obj.properties.filter((p) => !keys.includes(p.key)),
      };
    },
  },
  NonNullable: {
    arity: 1,
    apply: ([target], resolve) => stripNull(resolve(target)),
  },
};

/** Derived view for validate.ts (BUILTIN_GENERIC_ARITY) and index.ts. */
export const UTILITY_TYPE_ARITY: Record<string, number> = Object.fromEntries(
  Object.entries(UTILITY_TYPES).map(([name, entry]) => [name, entry.arity]),
);

export function isUtilityTypeName(name: string): boolean {
  return name in UTILITY_TYPES;
}

/**
 * Evaluate one utility-type application. Throws TypeError on invalid
 * input. VERIFIED surfacing (same as Record key errors today): at typecheck
 * time safeResolveType SWALLOWS the throw and the annotation degrades to
 * `any` with no diagnostic; the error becomes fatal at codegen when
 * resolveTypeDeep re-runs the resolver unwrapped. A Task 2 test pins this;
 * located diagnostics are a spec follow-up. Arity is ALSO validated as a
 * located diagnostic via BUILTIN_GENERIC_ARITY (validate.ts); the throw
 * here is the resolver-level backstop.
 */
export function evalUtilityType(
  name: string,
  typeArgs: VariableType[],
  resolve: Resolve,
): VariableType {
  const entry = UTILITY_TYPES[name];
  if (!entry) {
    throw new TypeError(`Unknown utility type ${name}`);
  }
  if (typeArgs.length !== entry.arity) {
    throw new TypeError(
      `${name} expects ${entry.arity} type argument${entry.arity === 1 ? "" : "s"}, got ${typeArgs.length}`,
    );
  }
  return entry.apply(typeArgs, resolve);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test:run lib/typeChecker/utilityTypes.test.ts > /tmp/ut-task1-green.log 2>&1; tail -5 /tmp/ut-task1-green.log
```

Expected: all PASS. If the `Partial keeps the alias reference` test fails on deep-equality, check that `addNull` receives `p.value` (the written type), not the resolved one.

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/utilityTypes.ts lib/typeChecker/utilityTypes.test.ts
git commit -m "Add utility-type evaluator module (Partial, Required, Pick, Omit, NonNullable)"
```

---

### Task 2: Wire into the resolver, arity table, and reserved names

**Files:**
- Modify: `lib/typeChecker/assignability.ts` (the `genericType` section of `resolveTypeWithGuard`, after the `Record` branch ending ~line 137)
- Modify: `lib/typeChecker/validate.ts:7-11` (`BUILTIN_GENERIC_ARITY`)
- Modify: `lib/typeChecker/index.ts:60` (`RESERVED_TYPE_NAMES`)
- Test: extend `lib/typeChecker/utilityTypes.test.ts`

**Interfaces:**
- Consumes: `evalUtilityType`, `isUtilityTypeName`, `UTILITY_TYPE_ARITY` from Task 1; `typecheckSource` from `lib/typeChecker/testUtils.ts`.
- Produces: `Partial<User>` etc. resolve everywhere `resolveType`/`safeResolveType`/`resolveTypeDeep` are used (typecheck AND codegen).

- [ ] **Step 1: Write the failing end-to-end typecheck tests**

Append to `lib/typeChecker/utilityTypes.test.ts` (place the `import` at the TOP of the file with the existing imports, not inline):

```ts
import { typecheckSource } from "./testUtils.js";

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
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
pnpm test:run lib/typeChecker/utilityTypes.test.ts > /tmp/ut-task2-red.log 2>&1; tail -15 /tmp/ut-task2-red.log
```

Expected: the pipeline tests FAIL (first with "Unknown generic type 'Partial'" diagnostics appearing in `errors`); Task 1 unit tests still PASS.

- [ ] **Step 3: Add the resolver branch**

In `lib/typeChecker/assignability.ts`, add the import at the top:

```ts
import { evalUtilityType, isUtilityTypeName } from "./utilityTypes.js";
```

Then in `resolveTypeWithGuard`, directly after the `Record` branch (the block ending `});` before the `// User-defined generic alias.` comment), insert:

```ts
    // Built-in utility types: eagerly evaluate to a plain objectType /
    // union so nothing downstream knows they exist. The resolver callback
    // carries this call's in-progress guard, so recursive alias arguments
    // degrade the same way Record args do (self-refs stay nominal).
    if (isUtilityTypeName(vt.name)) {
      const evaluated = evalUtilityType(vt.name, vt.typeArgs, (t) =>
        resolveTypeWithGuard(t, typeAliases, inProgress),
      );
      // Sibling branches (Array/Schema/Record) drop use-site tags; we keep
      // them DELIBERATELY so `@validate(...) Partial<User>` annotations
      // survive. The divergence is intentional, not an oversight.
      return attachAliasTags(evaluated, vt.tags);
    }
```

**Why located diagnostics for semantic argument errors are deferred (carry this rationale, do not "fix" it in this PR):** `validateTypeReferences` looks like the natural place to eagerly evaluate and report bad arguments with a `loc`. But it also validates generic alias *bodies* with type params stubbed as self-referential aliases (`index.ts:150-158`), so `type PartialOf<T> = Partial<T>` would resolve `T` to a nominal stub, fail the object-type check, and emit a false positive. Doing it right needs an "only when arguments are concrete" rule — the spec's named follow-up.

- [ ] **Step 4: Extend the arity table and reserved names**

In `lib/typeChecker/validate.ts`, add the import and spread:

```ts
import { UTILITY_TYPE_ARITY } from "./utilityTypes.js";

/** Built-in generic forms the typechecker / codegen know how to lower. */
const BUILTIN_GENERIC_ARITY: Record<string, number> = {
  Array: 1,
  Schema: 1,
  Record: 2,
  ...UTILITY_TYPE_ARITY,
};
```

In `lib/typeChecker/index.ts`, add the import and extend the set at line 60:

```ts
import { UTILITY_TYPE_ARITY } from "./utilityTypes.js";

/** Type-alias names that resolve to built-in types. */
const RESERVED_TYPE_NAMES = new Set<string>([
  "Result",
  "Success",
  "Failure",
  ...Object.keys(UTILITY_TYPE_ARITY),
]);
```

- [ ] **Step 5: Run the test file, then the structural linter**

```bash
pnpm test:run lib/typeChecker/utilityTypes.test.ts > /tmp/ut-task2-green.log 2>&1; tail -5 /tmp/ut-task2-green.log
pnpm run lint:structure > /tmp/ut-task2-lint.log 2>&1; tail -3 /tmp/ut-task2-lint.log
```

Expected: all PASS, linter clean. If the narrowing test fails, the likely cause is the resolver branch being placed AFTER the user-defined-generic lookup (which throws `Unknown generic type`) — it must come before.

- [ ] **Step 6: Run the neighboring typechecker suites to catch regressions**

```bash
pnpm test:run lib/typeChecker > /tmp/ut-task2-suite.log 2>&1; tail -5 /tmp/ut-task2-suite.log
```

Expected: PASS. A plausible regression: any existing test that defines an alias named `Partial`/`Pick`/etc. would now hit the reserved-name error — if one exists, rename the alias in that test (the reservation is the spec-approved breaking change).

- [ ] **Step 7: Commit**

```bash
git add lib/typeChecker/assignability.ts lib/typeChecker/validate.ts lib/typeChecker/index.ts lib/typeChecker/utilityTypes.test.ts
git commit -m "Resolve utility types in resolveTypeWithGuard; reserve names and arities"
```

---

### Task 3: Formatter round-trip

**Files:**
- Test: `lib/backends/agencyGenerator.test.ts` (append to the existing table-driven cases)

**Interfaces:**
- Consumes: existing `AgencyGenerator` test table pattern (input source → expected formatted output).
- Produces: guarantee that `pnpm run fmt` preserves utility types as written.

- [ ] **Step 1: Add the round-trip cases**

In `lib/backends/agencyGenerator.test.ts`, append to the `testCases` array in the "Function Parameter Type Hints" describe block:

```ts
      {
        description: "utility type hint is preserved as written",
        input: "def patch(c: Partial<User>) { c }",
        expectedOutput: "def patch(c: Partial<User>) {\nc\n}",
      },
      {
        description: "Pick with a literal-union key argument",
        input: 'def contact(c: Pick<User, "name" | "email">) { c }',
        expectedOutput: 'def contact(c: Pick<User, "name" | "email">) {\nc\n}',
      },
```

Also add one alias-declaration round-trip case (parameter positions and alias declarations print through the same type formatter, but pin both). Add a small standalone test at the end of the file, using the same parse-then-generate harness the existing table runner in this file uses (check the runner below the `testCases` array for the exact generator method name — it is the one method the table cases are fed through):

```ts
describe("AgencyGenerator - utility types in alias declarations", () => {
  it("preserves a utility type in a type alias declaration", () => {
    const parsed = parseAgency("type UserPatch = Partial<User>");
    if (!parsed.success) throw new Error("parse failed");
    // Use the same generator entry point as the table runner above.
    const output = generate(parsed.result); // adapt to the file's harness
    expect(output).toContain("Partial<User>");
  });
});
```

The `toContain` assertion is deliberate — it pins survival of the written form without coupling to whitespace canonicalization.

- [ ] **Step 2: Run**

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts > /tmp/ut-task3.log 2>&1; tail -5 /tmp/ut-task3.log
```

Expected: PASS with no production-code change (the AST keeps `genericType` nodes and the generator already prints them — that is the point of the test: pin the behavior). If it fails on spacing of the literal union, adjust `expectedOutput` to the generator's actual canonical spacing (e.g. `"name" | "email"` vs `"name"|"email"`) — the assertion that matters is that the `Pick<...>` form survives, not the whitespace.

- [ ] **Step 3: Commit**

```bash
git add lib/backends/agencyGenerator.test.ts
git commit -m "Pin formatter round-trip for utility type hints"
```

---

### Task 4: Codegen fixture

**Files:**
- Create: `tests/typescriptGenerator/utilityTypes.agency`
- Generated: `tests/typescriptGenerator/utilityTypes.mjs` (via `make fixtures`)

**Interfaces:**
- Consumes: the resolver branch from Task 2 (codegen resolves alias bodies via `resolveTypeDeep`, `lib/backends/typescriptBuilder.ts:793`).
- Produces: a checked-in fixture proving `Partial` reaches zod output identical to a hand-written `p?:` type.

- [ ] **Step 1: Create the fixture source**

Create `tests/typescriptGenerator/utilityTypes.agency`:

```
type User = {
  name: string,
  age?: number,
}

type UserPatch = Partial<User>

type Contact = Pick<User, "name">

def patch(changes: Partial<User>): string {
  return "ok"
}

node main() {
  const changes: UserPatch = { name: null, age: 1 }
  const c: Contact = { name: "a" }
  return patch(changes)
}
```

The `patch` function is load-bearing: function parameters lower through the `required-nullable` zod mapper (the LLM structured-output / tool-schema path), which no other test exercises — every runtime test uses `parseJSON`, which is `optional-coalesce` only. The golden `.mjs` pins BOTH `optionalKeyMode` shapes this way.

- [ ] **Step 2: Build and regenerate fixtures**

```bash
make > /tmp/ut-task4-make.log 2>&1; tail -3 /tmp/ut-task4-make.log
make fixtures > /tmp/ut-task4-fixtures.log 2>&1; tail -3 /tmp/ut-task4-fixtures.log
```

Expected: both succeed; `tests/typescriptGenerator/utilityTypes.mjs` now exists.

- [ ] **Step 3: Verify the generated schema shapes**

```bash
grep -n "UserPatch\|Contact\|patch" tests/typescriptGenerator/utilityTypes.mjs
```

Expected: `UserPatch` is a `z.object` whose `name` and `age` schemas both admit null (union with `z.null()` — the same shape the hand-written `age?:` property gets), `Contact` is a `z.object` with only `name`, and the `patch` tool schema shows the required-nullable shape for its `changes` parameter (nullable but NOT `.optional()`). If instead the build failed with `Unresolved generic type at codegen: Partial`, the Task 2 branch is not being reached from `resolveTypeDeep` — check `deepResolveNode` routes `genericType` through `resolveType` (it does; the failure would mean a typo in the branch condition).

- [ ] **Step 4: Confirm no other fixtures churned, then commit**

```bash
git status --short tests/ | tee /tmp/ut-task4-status.log
git add tests/typescriptGenerator/utilityTypes.agency tests/typescriptGenerator/utilityTypes.mjs
git commit -m "Add codegen fixture for utility types"
```

Expected `git status`: only the two new files. Unrelated fixture churn means `make fixtures` picked up drift from another change — stop and investigate before committing.

---

### Task 5: Agency execution tests (one per utility type)

**Files:**
- Create: `tests/agency/utility-partial.agency` + `tests/agency/utility-partial.test.json`
- Create: `tests/agency/utility-required.agency` + `tests/agency/utility-required.test.json`
- Create: `tests/agency/utility-pick.agency` + `tests/agency/utility-pick.test.json`
- Create: `tests/agency/utility-omit.agency` + `tests/agency/utility-omit.test.json`
- Create: `tests/agency/utility-nonnullable.agency` + `tests/agency/utility-nonnullable.test.json`

No LLM calls anywhere. Each file has an accept node and a reject node; each `.test.json` runs both with `exact` criteria.

- [ ] **Step 1: Partial — missing keys coalesce to null on parse**

`tests/agency/utility-partial.agency`:

```
// Partial<T>: schema parse (optional-coalesce mode) fills missing keys with
// null; a wrongly-typed present key still fails.
type User = {
  name: string,
  age: number,
}

node accepts() {
  const r = schema(Partial<User>).parseJSON("{}")
  if (isSuccess(r)) {
    return r.value
  }
  return "parse failed"
}

node rejects() {
  const r = schema(Partial<User>).parseJSON("{\"name\": 123}")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}
```

`tests/agency/utility-partial.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "accepts",
      "input": "",
      "expectedOutput": "{\"name\":null,\"age\":null}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "missing keys coalesce to null under Partial"
    },
    {
      "nodeName": "rejects",
      "input": "",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "wrong value type still rejected under Partial"
    }
  ]
}
```

- [ ] **Step 2: Required — formerly-optional key becomes mandatory**

`tests/agency/utility-required.agency`:

```
// Required<T>: strips null from every property, so a formerly-optional key
// must be present and non-null at parse time.
type User = {
  name: string,
  age?: number,
}

node accepts() {
  const r = schema(Required<User>).parseJSON("{\"name\": \"a\", \"age\": 1}")
  if (isSuccess(r)) {
    return r.value
  }
  return "parse failed"
}

node rejects() {
  const r = schema(Required<User>).parseJSON("{\"name\": \"a\"}")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}
```

`tests/agency/utility-required.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "accepts",
      "input": "",
      "expectedOutput": "{\"name\":\"a\",\"age\":1}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "all keys present passes Required"
    },
    {
      "nodeName": "rejects",
      "input": "",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "missing formerly-optional key fails Required"
    }
  ]
}
```

- [ ] **Step 3: Pick — schema has only the picked keys**

`tests/agency/utility-pick.agency`:

```
// Pick<T, K>: result schema contains exactly the picked keys; zod strips
// unknown keys on parse, so extra input keys vanish from the output.
type User = {
  name: string,
  age: number,
  email: string,
}

node accepts() {
  const r = schema(Pick<User, "name" | "age">).parseJSON("{\"name\": \"a\", \"age\": 1, \"email\": \"x@y.z\"}")
  if (isSuccess(r)) {
    return r.value
  }
  return "parse failed"
}

node rejects() {
  const r = schema(Pick<User, "name" | "age">).parseJSON("{\"name\": \"a\"}")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}
```

`tests/agency/utility-pick.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "accepts",
      "input": "",
      "expectedOutput": "{\"name\":\"a\",\"age\":1}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "picked keys survive; unpicked input keys are stripped"
    },
    {
      "nodeName": "rejects",
      "input": "",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "missing picked key fails"
    }
  ]
}
```

- [ ] **Step 4: Omit — complementary key set**

`tests/agency/utility-omit.agency`:

```
// Omit<T, K>: the omitted key is gone from the schema; remaining keys are
// still required.
type User = {
  name: string,
  age: number,
  email: string,
}

node accepts() {
  const r = schema(Omit<User, "email">).parseJSON("{\"name\": \"a\", \"age\": 1}")
  if (isSuccess(r)) {
    return r.value
  }
  return "parse failed"
}

node rejects() {
  const r = schema(Omit<User, "email">).parseJSON("{\"name\": \"a\"}")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}
```

`tests/agency/utility-omit.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "accepts",
      "input": "",
      "expectedOutput": "{\"name\":\"a\",\"age\":1}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "omitted key not required; others parse"
    },
    {
      "nodeName": "rejects",
      "input": "",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "remaining keys still required after Omit"
    }
  ]
}
```

- [ ] **Step 5: NonNullable — non-object transform, scalar schema**

`tests/agency/utility-nonnullable.agency`:

```
// NonNullable<T>: the one non-object transform. The schema is the stripped
// scalar, so null is rejected where string | null would have accepted it.
node accepts() {
  const r = schema(NonNullable<string | null>).parseJSON("\"x\"")
  if (isSuccess(r)) {
    return r.value
  }
  return "parse failed"
}

node rejects() {
  const r = schema(NonNullable<string | null>).parseJSON("null")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}
```

`tests/agency/utility-nonnullable.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "accepts",
      "input": "",
      "expectedOutput": "\"x\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "non-null value passes NonNullable"
    },
    {
      "nodeName": "rejects",
      "input": "",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "null rejected by NonNullable"
    }
  ]
}
```

- [ ] **Step 6: Run each test individually (NOT the full agency suite — repo rule)**

```bash
make > /tmp/ut-task5-make.log 2>&1; tail -3 /tmp/ut-task5-make.log
for t in partial required pick omit nonnullable; do
  pnpm run agency test tests/agency/utility-$t.agency > /tmp/ut-task5-$t.log 2>&1
  echo "$t: $?"
done
```

Expected: exit 0 for all five. Two known adjustment points, both legitimate observations rather than failures of the feature:
- **Key order in `expectedOutput`:** zod emits parsed objects in schema declaration order; if a log shows a different serialization, update the `.test.json` to the observed order.
- **`optional-coalesce` scope:** if the `Partial` accept case fails because missing keys are NOT coalesced (parse errors instead), then `parseJSON` runs in `required-nullable` mode — change the accept input from `"{}"` to `"{\"name\": null, \"age\": null}"` and the expected output stays the same. Check `/tmp/ut-task5-partial.log` before touching anything else; the reject cases are mode-independent.

- [ ] **Step 7: Commit**

```bash
git add tests/agency/utility-*.agency tests/agency/utility-*.test.json
git commit -m "Add agency execution tests for the five utility types"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/site/guide/types.md` (add a "Utility types" section)
- Modify: `docs/dev/typechecker/README.md` (extend the built-in generics passage)

**Interfaces:**
- Consumes: final behavior from Tasks 1–5 (use observed outputs, not guesses).
- Produces: user-facing and dev-facing docs.

- [ ] **Step 1: Guide section**

Append to `docs/site/guide/types.md`:

````markdown
## Utility types

Agency ships five built-in utility types modeled on TypeScript, adapted to
Agency optionality (optional means `| null`; there is no `undefined`):

| Type | What it does |
|---|---|
| `Partial<T>` | Every property becomes nullable: `p: V` → `p: V \| null` |
| `Required<T>` | The inverse: strips `null` from every property |
| `Pick<T, K>` | Keeps only the listed keys: `Pick<User, "name" \| "email">` |
| `Omit<T, K>` | Removes the listed keys |
| `NonNullable<T>` | Strips `null` from a single type: `NonNullable<string \| null>` is `string` |

```ts
type User = {
  name: string,
  age?: number,
}

def updateUser(id: string, changes: Partial<User>): User {
  // changes.name is string | null — guard before use:
  if (changes.name != null) {
    // changes.name is string here
  }
  ...
}
```

Details worth knowing:

- All transforms are **shallow** — nested object types are not transformed.
- In Agency source, object keys are always required. `Partial` means you can
  pass `null` for a value, not omit the key. Key omission is only forgiven
  when parsing JSON with `schema(...)`: missing keys coalesce to `null`.
- Because `p?: V` and `p: V | null` are the same type after parsing,
  `Required` un-optionalizes both — it cannot distinguish a property you
  marked optional from one you declared nullable on purpose.
- `Pick` errors on a key that does not exist on the target; `Omit` allows it
  (matching TypeScript).
- The transforms need concrete object types: applying them to `Record<K, V>`,
  arrays, primitives, or unions is an error.
- A bad `Pick` key or a non-object argument is reported when the program
  **compiles**, not as an editor/typecheck diagnostic — `agency typecheck`
  will not flag it today.
````

Adjust the narrowing comment if Task 2's narrowing test revealed different behavior. Follow `agency doc` conventions if `types.md` is a generated page — it is hand-written today (verify: it has no generated-file header), so direct editing is correct.

- [ ] **Step 2: Dev docs**

In `docs/dev/typechecker/README.md`, find the passage listing built-in generic handling (the `resolveType` discussion) and add:

```markdown
### Built-in utility types

`Partial`, `Required`, `Pick`, `Omit`, and `NonNullable` are built-in
generics evaluated EAGERLY by `resolveTypeWithGuard` (see
`lib/typeChecker/utilityTypes.ts`): they resolve to plain object/union
types at resolution time, so no downstream pass knows they exist. This is
the litmus test for Agency type features: a type must be eagerly evaluable
to a concrete, JSON-schema-able shape (which is why mapped and conditional
types are permanently out of scope). Arity lives in `BUILTIN_GENERIC_ARITY`
(validate.ts); the five names are in `RESERVED_TYPE_NAMES` (index.ts).
Semantic argument errors throw `TypeError` from the resolver, surfacing the
same way `Record` key errors do.
```

- [ ] **Step 3: Commit**

```bash
git add docs/site/guide/types.md docs/dev/typechecker/README.md
git commit -m "Document built-in utility types"
```

---

### Task 7: Full verification and wrap-up

**Files:** none new.

- [ ] **Step 1: Run the unit/typecheck suites once, saving output**

```bash
pnpm test:run lib > /tmp/ut-task7-lib.log 2>&1; tail -5 /tmp/ut-task7-lib.log
pnpm run lint:structure > /tmp/ut-task7-lint.log 2>&1; tail -3 /tmp/ut-task7-lint.log
```

Expected: PASS / clean. Do NOT run the full agency test suite locally (repo rule — CI runs it on the PR).

- [ ] **Step 2: Push branch and open the PR**

Write the PR description to a file first (apostrophe rule), reference the spec path and note the reserved-names breaking change, then:

```bash
git push -u origin utility-types
gh pr create --title "Add built-in utility types: Partial, Required, Pick, Omit, NonNullable" --body-file /tmp/ut-pr-body.md
```
