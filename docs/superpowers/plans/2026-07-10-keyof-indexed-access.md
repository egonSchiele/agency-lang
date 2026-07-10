# keyof + Indexed Access Implementation Plan — rev 2 (review applied)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (owner preference: inline execution in the main session, NOT subagent-driven). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `keyof T` and `T["key"]` type operators per the approved spec `docs/superpowers/specs/2026-07-10-keyof-indexed-access-design.md`.

**Architecture:** Two new `VariableType` variants (`keyofType`, `indexedAccessType`) that exist only between parse and resolution. The parser splits into a shared base chain plus a `typeSuffix` parser; `arrayTypeParser` keeps its exported name and or-chain behavior (base + at-least-one suffix), while keyof's operand uses a private zero-or-more-suffix variant (review finding 1). Evaluation is eager in `resolveTypeWithGuard`, implemented in `lib/typeChecker/typeOperators.ts`, CONSUMING the helpers `builtinGenerics.ts` already owns (review finding 2). `deepResolveNode` routes the two variants so alias bodies resolve before codegen.

**Verified facts (plan author + independent reviewer):**
- `arrayTypeParser` (`lib/parsers/parsers.ts:995`): its own base or-chain plus `count(str("[]"))`, and `count` FAILS on zero matches — so today's or-chain member never matches a bare type. The rework must preserve that (finding 1): a zero-suffix postfix parser placed in the or-chain would swallow `keyof` as `typeAliasVariable("keyof")` and break every keyof annotation, because `or()` commits to the first success.
- `builtinGenerics.ts` owns `resolveObjectArg` (:105) and `resolveKeysArg` (:120) — currently private. `typeOperators.ts` consumes them (exported, parameterized by operator name) instead of re-implementing. `withUseSiteTags` is also there for tag threading.
- `typeKey`'s `canonical()` and `valueParamSubstitution`'s switches have `never`-defaults: tsc fails until their cases exist. That is the FULL reach of compile-time enforcement — `formatTypeHint`'s default throws at runtime, the zod mapper falls back to `z.string()` silently, and `mapTypes`/`visitTypes` pass unknown nodes through silently. Each of those gets an explicit step; do not treat `make` as the complete checklist.
- The zod mapper's fallback for unresolved nodes is `z.string()` — which is why codegen pins must use NON-string properties (review test-audit).
- `deepResolveNode` (`lib/typeChecker/assignability.ts`) routes only `genericType` and `typeAliasVariable` — the spec's trap.
- Codegen harness: `generate()` from `lib/backends/recursiveAliases.codegen.test.ts`. Execution tests bind `schema(...)` to a variable first (#480). `parseAgency(source, {}, false)` is the right signature; Tag literals are `{ type, name, arguments }`.
- Unknown aliases resolve to themselves, so `keyof UnknownAlias` lands in the swallowed-TypeError family (pin it, review finding 5).
- `type keyof = ...` still parses as a declaration (alias names use `many1WithJoin(varNameChar)`), so the reserved-name check in `lib/typeChecker/index.ts` is what rejects it.

## Global Constraints

- Fresh worktree: `git worktree add .claude/worktrees/keyof-indexed -b keyof-indexed origin/main`, then `cd .claude/worktrees/keyof-indexed && pnpm install && cd packages/agency-lang && make`.
- Never commit to `main`. No apostrophes in commit-message command lines. Save test output to files. Run `make` before CLI steps. Do NOT run the full agency suite locally.
- `typeOperators.ts` must NOT import `assignability.ts` (resolver injected).
- Zero churn in existing `tests/typescriptGenerator` fixtures is a hard gate.
- Both operators are object-only in v1.
- Reserved-name pre-check (spec requirement): before Task 1, run
  `grep -rn "keyof" stdlib/ tests/agency/ tests/typescriptGenerator/ lib/agents/ --include="*.agency" | grep -v "keyof "` and expect zero hits — no existing `.agency` code uses `keyof` as an identifier. Record the result in the Task 1 commit message.

---

### Task 1: AST variants + parser + printers

**Files:**
- Modify: `lib/types/typeHints.ts` (two variants + header checklist update)
- Modify: `lib/parsers/parsers.ts` (base/suffix split; `keyofTypeParser`)
- Modify: `lib/utils/formatType.ts` (+ the generator's type printer if separate)
- Test: `lib/parsers/typeOperatorParsing.test.ts` (new), `lib/backends/agencyGenerator.test.ts`

**Interfaces produced:**

```ts
export type KeyofType = {
  type: "keyofType";
  operand: VariableType;
  tags?: Tag[];
};

export type IndexedAccessType = {
  type: "indexedAccessType";
  objectType: VariableType;
  index: VariableType;
  tags?: Tag[];
};
```

The `tags` fields are NOT dead (review finding 3): Task 2's resolver branches thread them through `withUseSiteTags`, mirroring the adjacent `genericType` branch.

- [ ] **Step 1: Write the failing parse tests**

Create `lib/parsers/typeOperatorParsing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

function firstParamHint(source: string): unknown {
  const parsed = parseAgency(source, {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("unreachable");
  const def = parsed.result.nodes.find((n) => n.type === "function") as {
    parameters: { typeHint?: unknown }[];
  };
  return def.parameters[0].typeHint;
}

describe("keyof parsing", () => {
  it("parses keyof over an alias reference", () => {
    expect(firstParamHint("def f(k: keyof User) { k }")).toMatchObject({
      type: "keyofType",
      operand: { type: "typeAliasVariable", aliasName: "User" },
    });
  });

  it("binds tighter than union: keyof A | keyof B is a union of keyofs", () => {
    expect(firstParamHint("def f(k: keyof A | keyof B) { k }")).toMatchObject({
      type: "unionType",
      types: [
        { type: "keyofType", operand: { aliasName: "A" } },
        { type: "keyofType", operand: { aliasName: "B" } },
      ],
    });
  });

  it("postfix binds tighter than keyof: keyof User[] is keyof (User[])", () => {
    expect(firstParamHint("def f(k: keyof User[]) { k }")).toMatchObject({
      type: "keyofType",
      operand: { type: "arrayType" },
    });
  });

  it("parenthesized keyof takes a suffix: (keyof User)[] is an ARRAY of keyofs", () => {
    expect(firstParamHint("def f(k: (keyof User)[]) { k }")).toMatchObject({
      type: "arrayType",
      elementType: { type: "keyofType" },
    });
  });

  it("keyword boundary: keyofish stays a plain identifier", () => {
    // The required whitespace after `keyof` is load-bearing: it is what
    // stops the keyword from eating identifier prefixes. Pin it so nobody
    // makes the spaces optional (review test-audit #5).
    expect(firstParamHint("def f(k: keyofish) { k }")).toMatchObject({
      type: "typeAliasVariable",
      aliasName: "keyofish",
    });
  });
});

describe("indexed access parsing", () => {
  it("parses a string-literal index", () => {
    expect(firstParamHint('def f(x: User["name"]) { x }')).toMatchObject({
      type: "indexedAccessType",
      objectType: { type: "typeAliasVariable", aliasName: "User" },
      index: { type: "stringLiteralType", value: "name" },
    });
  });

  it("parses a union index", () => {
    expect(firstParamHint('def f(x: User["a" | "b"]) { x }')).toMatchObject({
      type: "indexedAccessType",
      index: { type: "unionType" },
    });
  });

  it("chains left to right", () => {
    expect(
      firstParamHint('def f(x: User["address"]["city"]) { x }'),
    ).toMatchObject({
      type: "indexedAccessType",
      objectType: {
        type: "indexedAccessType",
        index: { value: "address" },
      },
      index: { value: "city" },
    });
  });

  it("accepts a full type expression as the index (keyof composes)", () => {
    expect(firstParamHint("def f(x: User[keyof User]) { x }")).toMatchObject({
      type: "indexedAccessType",
      index: { type: "keyofType" },
    });
  });

  it('mixes with arrays: User["tags"][] is an array of the indexed type', () => {
    expect(firstParamHint('def f(x: User["tags"][]) { x }')).toMatchObject({
      type: "arrayType",
      elementType: { type: "indexedAccessType" },
    });
  });

  it("empty brackets still mean array", () => {
    expect(firstParamHint("def f(x: number[]) { x }")).toMatchObject({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });
});
```

- [ ] **Step 2: Run to verify red**

```bash
pnpm test:run lib/parsers/typeOperatorParsing.test.ts > /tmp/ki-task1-red.log 2>&1; tail -5 /tmp/ki-task1-red.log
```

Expected: keyof/indexed tests FAIL; the plain-array and keyofish tests PASS (pinning existing behavior first).

- [ ] **Step 3: Add the variants + checklist update to `typeHints.ts`**

Add both types to the file and the `VariableType` union. In the SAME edit, update the header checklist comment: add `typeKey` (`lib/typeChecker/typeKey.ts` — never-enforced, tsc catches it) and `deepResolveNode` (`lib/typeChecker/assignability.ts` — NOT enforced; passing nodes through unchanged is its correct behavior for most variants, so a miss silently sends unresolved nodes to the zod mapper's `z.string()` fallback; pin new variants with a codegen test. See docs/dev/adding-features.md).

- [ ] **Step 4: The base/suffix parser split (review finding 1 — follow exactly)**

In `lib/parsers/parsers.ts`, three pieces:

1. **Extract the base chain** currently inside `arrayTypeParser` into a shared `typePostfixBase` parser (parenthesized, object, result, angle-array, generic, primitive, typeAliasVariable — unchanged membership and order).
2. **A `typeSuffix` step**: given a current type, try `[]` → wrap in arrayType; else `[` + `variableTypeParser` + `]` → wrap in indexedAccessType. Implemented as a loop in the two consuming parsers (the file's existing mutate-and-wrap style is fine here; parsers are exempt from the accumulator rule).
3. **Two consumers with different suffix arities:**
   - `arrayTypeParser` (exported name and or-chain positions UNCHANGED) = base + AT LEAST ONE suffix. This preserves today's or-chain behavior exactly: bare types still fail through to later alternatives, and `User["name"]` matches because the index bracket is the one required suffix.
   - A private `postfixOperandParser` = base + ZERO OR MORE suffixes. ONLY `keyofTypeParser` uses it, so its bare-match greediness leaks nowhere.

```ts
// keyof binds to the full postfix expression that follows: `keyof
// User["address"]` means keyof (User["address"]) and `keyof User[]`
// means keyof (User[]). Union binds looser. The whitespace after the
// keyword is REQUIRED and load-bearing: it is the keyword boundary that
// lets `keyofish` parse as a plain identifier. Do not make it optional.
export const keyofTypeParser: Parser<KeyofType> = memo(
  "keyofTypeParser",
  seqC(
    set("type", "keyofType"),
    str("keyof"),
    spaces,
    capture(lazy(() => postfixOperandParser), "operand"),
  ),
);
```

Slot `keyofTypeParser` into `unionItemParser` and `variableTypeParser` BEFORE `arrayTypeParser` and `typeAliasVariableParser`. `(keyof User)[]` needs no extra code: `parenthesizedTypeParser` sits in the base chain and routes through `variableTypeParser`, which now contains `keyofTypeParser`.

- [ ] **Step 5: Printers, with parenthesization (review finding 4)**

`lib/utils/formatType.ts`:
- `keyofType` → `keyof <operand>`.
- `indexedAccessType` → `<object>[<index>]` with the index recursing normally (a string-literal index prints quoted).
- `arrayType` printing: when the element is a `keyofType`, parenthesize — `(keyof User)[]`, never `keyof User[]` (which re-parses as `keyof (User[])`).
- `indexedAccessType` printing: when the OBJECT is a `keyofType`, parenthesize it for the same reason.

Locate the `AgencyGenerator` type-printing path (follow `arrayType`) and mirror all four rules if it does not delegate.

- [ ] **Step 6: Fix the compile fan-out**

```bash
make > /tmp/ki-task1-make.log 2>&1; grep -E "error TS" /tmp/ki-task1-make.log | head -20
```

tsc reports `typeKey` and `valueParamSubstitution` (never-defaults). Fix those, PLUS the two silent sites tsc cannot report: `mapTypes` AND `visitTypes` in `typeWalker.ts` (add both, per the file's own pairing rule). `typeKey` cases: `keyofType` → `` `{"keyof":${canonical(t.operand)}}` ``; `indexedAccessType` → `` `{"index":[${canonical(t.objectType)},${canonical(t.index)}]}` ``.

- [ ] **Step 7: Green + round-trips (flat, nested, and alias positions)**

```bash
pnpm test:run lib/parsers/typeOperatorParsing.test.ts > /tmp/ki-task1-green.log 2>&1; tail -3 /tmp/ki-task1-green.log
```

Append to `lib/backends/agencyGenerator.test.ts` — table cases:

```ts
      {
        description: "keyof type hint round-trips",
        input: "def f(k: keyof User) { k }",
        expectedOutput: "def f(k: keyof User) {\nk\n}",
      },
      {
        description: "indexed access type hint round-trips",
        input: 'def f(x: User["name"]) { x }',
        expectedOutput: 'def f(x: User["name"]) {\nx\n}',
      },
      {
        description: "array-of-keyof keeps its parens (distinct from keyof-of-array)",
        input: "def f(k: (keyof User)[]) { k }",
        expectedOutput: "def f(k: (keyof User)[]) {\nk\n}",
      },
      {
        description: "keyof-of-array stays unparenthesized",
        input: "def f(k: keyof User[]) { k }",
        expectedOutput: "def f(k: keyof User[]) {\nk\n}",
      },
```

Plus alias-position round-trips (spec requirement; standalone tests in the same file, following the Type-preservation describe pattern): `type F = keyof User` and `type N = User["name"]` through the generator, asserting the output contains the written forms.

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts > /tmp/ki-task1-fmt.log 2>&1; tail -3 /tmp/ki-task1-fmt.log
pnpm test:run lib > /tmp/ki-task1-lib.log 2>&1; tail -3 /tmp/ki-task1-lib.log
pnpm run lint:structure > /tmp/ki-task1-lint.log 2>&1; tail -2 /tmp/ki-task1-lint.log
```

The full-lib run is the guard for the parser split: `arrayTypeParser` feeds every existing annotation.

- [ ] **Step 8: Commit** (note the reserved-name grep result in the message)

```bash
git add lib/types/typeHints.ts lib/parsers/parsers.ts lib/parsers/typeOperatorParsing.test.ts lib/utils/formatType.ts lib/backends/agencyGenerator.test.ts lib/typeChecker/typeKey.ts lib/typeChecker/valueParamSubstitution.ts lib/typeChecker/typeWalker.ts
git commit -m "Add keyofType and indexedAccessType variants with split postfix parser and printers"
```

---

### Task 2: Evaluation — typeOperators.ts consuming builtinGenerics helpers

**Files:**
- Modify: `lib/typeChecker/builtinGenerics.ts` (export `resolveObjectArg`, `resolveKeysArg`, `withUseSiteTags`)
- Create: `lib/typeChecker/typeOperators.ts`
- Test: `lib/typeChecker/typeOperators.test.ts`
- Modify: `lib/typeChecker/assignability.ts` (two resolver branches, tag-threading)
- Modify: `lib/typeChecker/index.ts` (`RESERVED_TYPE_NAMES` gains `"keyof"`)

**Interfaces:**
- `evalKeyof(operand, resolve): VariableType` — union of key literals; empty → `NEVER_T`; single unwraps; non-object → `TypeError` via the SHARED `resolveObjectArg` (so the message is the same family as Partial's).
- `evalIndexedAccess(objectType, index, resolve): VariableType` — `resolveKeysArg` resolves the index to literal strings (shared error wording for non-literals); missing key → `TypeError` in Pick's wording family: `indexed access key 'nope' does not exist on the target type. Available keys: ...`; union of results (single unwraps); property tags ride along.

- [ ] **Step 1: Export the shared helpers**

In `builtinGenerics.ts`, add `export` to `resolveObjectArg`, `resolveKeysArg`, and `withUseSiteTags`. No behavior change; the existing callers keep working.

- [ ] **Step 2: Write the failing unit tests**

Create `lib/typeChecker/typeOperators.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evalKeyof, evalIndexedAccess } from "./typeOperators.js";
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
```

- [ ] **Step 3: Red, then implement**

```bash
pnpm test:run lib/typeChecker/typeOperators.test.ts > /tmp/ki-task2-red.log 2>&1; tail -3 /tmp/ki-task2-red.log
```

Create `lib/typeChecker/typeOperators.ts`:

```ts
import type { VariableType } from "../types.js";
import { resolveKeysArg, resolveObjectArg } from "./builtinGenerics.js";
import { NEVER_T } from "./primitives.js";

/**
 * Eager evaluation for the type operators `keyof T` and `T["key"]`.
 * Both run during type resolution and produce ordinary types, so nothing
 * downstream knows the operator nodes exist.
 *
 * Argument validation is SHARED with the builtin generics
 * (resolveObjectArg / resolveKeysArg) so the error wording stays one
 * family across Partial, Pick, keyof, and indexed access.
 *
 * CYCLE RULE: this module must not import assignability.ts. The resolver
 * arrives as the `resolve` callback, carrying the caller's in-progress
 * guard, so recursive alias operands degrade the same way they do
 * everywhere else.
 */
type Resolve = (t: VariableType) => VariableType;

export function evalKeyof(
  operand: VariableType,
  resolve: Resolve,
): VariableType {
  const obj = resolveObjectArg("keyof", operand, resolve);
  const keys: VariableType[] = obj.properties.map((p) => ({
    type: "stringLiteralType",
    value: p.key,
  }));
  if (keys.length === 0) return NEVER_T;
  if (keys.length === 1) return keys[0];
  return { type: "unionType", types: keys };
}

export function evalIndexedAccess(
  objectType: VariableType,
  index: VariableType,
  resolve: Resolve,
): VariableType {
  const obj = resolveObjectArg("indexed access", objectType, resolve);
  const keys = resolveKeysArg("indexed access", index, resolve);
  const results = keys.map((key) => {
    const prop = obj.properties.find((p) => p.key === key);
    if (!prop) {
      const available = obj.properties.map((p) => p.key).join(", ");
      throw new TypeError(
        `indexed access key '${key}' does not exist on the target type. Available keys: ${available}`,
      );
    }
    return prop.value;
  });
  if (results.length === 1) return results[0];
  return { type: "unionType", types: results };
}
```

CHECK during execution: `resolveKeysArg`'s current error text is
`` `${name} expects string literal keys, got '...'` `` — the unit regex
matches it. If its signature or wording differs from this plan's memory
of it, adapt the TEST to the shared helper, not the helper to the test.

- [ ] **Step 4: Wire the resolver with tag threading (review finding 3)**

In `resolveTypeWithGuard`, before the `genericType` block:

```ts
  if (vt.type === "keyofType") {
    // Thread occurrence tags like the genericType branch does.
    return withUseSiteTags(
      evalKeyof(vt.operand, (t) =>
        resolveTypeWithGuard(t, typeAliases, inProgress),
      ),
      vt.tags,
    );
  }
  if (vt.type === "indexedAccessType") {
    return withUseSiteTags(
      evalIndexedAccess(vt.objectType, vt.index, (t) =>
        resolveTypeWithGuard(t, typeAliases, inProgress),
      ),
      vt.tags,
    );
  }
```

`index.ts`: add `"keyof"` to `RESERVED_TYPE_NAMES` with a one-line comment (keyword in type position; an alias named keyof would silently change parse).

- [ ] **Step 5: Pipeline tests**

Append to `lib/typeChecker/typeOperators.test.ts`:

```ts
import { typecheckSource } from "./testUtils.js";

describe("type operators through the full pipeline", () => {
  it("keyof produces a closed union: match gets exhaustiveness checking", () => {
    const errors = typecheckSource(`
type User = { name: string, age: number }
def label(field: keyof User): string {
  match (field) {
    "name" => { return "the name" }
    "age" => { return "the age" }
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
  match (field) {
    "name" => { return "the name" }
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
    // reference validation); assert only that nothing CRASHES and record
    // the observed diagnostics in the test.
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
```

- [ ] **Step 6: Verify, sweep, commit**

```bash
pnpm test:run lib/typeChecker/typeOperators.test.ts > /tmp/ki-task2-green.log 2>&1; tail -3 /tmp/ki-task2-green.log
pnpm test:run lib/typeChecker > /tmp/ki-task2-suite.log 2>&1; tail -3 /tmp/ki-task2-suite.log
git add lib/typeChecker/typeOperators.ts lib/typeChecker/typeOperators.test.ts lib/typeChecker/builtinGenerics.ts lib/typeChecker/assignability.ts lib/typeChecker/index.ts
git commit -m "Evaluate keyof and indexed access eagerly, sharing builtinGenerics helpers"
```

---

### Task 3: Codegen — deepResolveNode routing + non-fakeable pins

**Files:**
- Modify: `lib/typeChecker/assignability.ts` (`deepResolveNode`)
- Test: `lib/backends/typeOperators.codegen.test.ts` (new)
- Create: `tests/typescriptGenerator/typeOperators.agency` (+ `.mjs`)
- Create: `tests/agency/keyof-type.agency` + `.test.json`

- [ ] **Step 1: Write the failing codegen tests (fallback-proof assertions)**

Create `lib/backends/typeOperators.codegen.test.ts` (copy the `generate()` helper from `recursiveAliases.codegen.test.ts`). The zod mapper's unresolved-node fallback is `z.string()`, so every assertion here uses a shape the fallback cannot fake (review test-audit):

```ts
describe("type operators in alias bodies (deepResolveNode routing)", () => {
  it("type K = keyof User emits the literal-key union, NOT z.string()", () => {
    const out = generate(`
type User = {
  name: string,
  age: number,
}
type K = keyof User
node main() {
  return 1
}
`);
    expect(out).toMatch(
      /const K = z\.union\(\[z\.literal\("name"\), z\.literal\("age"\)\]\)/,
    );
  });

  it("an indexed-access alias emits the property schema (non-string property)", () => {
    const out = generate(`
type User = {
  name: string,
  age: number,
}
type A = User["age"]
node main() {
  return 1
}
`);
    expect(out).toMatch(/const A = z\.number\(\)/);
  });

  it("keyof of a FORWARD alias still emits literal keys (alias table is order-independent)", () => {
    const out = generate(`
type K = keyof Later
type Later = {
  a: string,
  b: number,
}
node main() {
  return 1
}
`);
    expect(out).toContain('z.literal("a")');
  });

  it("an indexed property carrying @validate keeps enforcement (descriptor path)", () => {
    // Tag ride-along must survive codegen, not just unit evaluation:
    // the extracted property type carries the validate tag, so the alias
    // gets a descriptor assignment, not just a bare schema const.
    const out = generate(`
def positive(n: number): Result<number, string> {
  if (n > 0) {
    return success(n)
  }
  return failure("must be positive")
}
type User = {
  name: string,
  @validate(positive)
  age: number,
}
type A = User["age"]
node main() {
  return 1
}
`);
    expect(out).toContain("A.__agency_descriptor");
  });
});
```

- [ ] **Step 2: Red, then route the variants**

```bash
pnpm test:run lib/backends/typeOperators.codegen.test.ts > /tmp/ki-task3-red.log 2>&1; tail -6 /tmp/ki-task3-red.log
```

Expected red: the `K` and `A` assertions fail with `z.string()` emissions — the trap, observed. Fix in `deepResolveNode`:

```ts
  if (n.type === "keyofType" || n.type === "indexedAccessType") {
    // Same routing as genericType: these evaluate to concrete types and
    // must never reach the zod mapper unresolved — the mapper's fallback
    // silently emits z.string(). See docs/dev/adding-features.md.
    return resolveType(n, typeAliases);
  }
```

Re-run: green. If the `@validate` descriptor test stays red, the tag
ride-along is dropping somewhere between `evalIndexedAccess` and
`hasAnyValidateTag` — debug there before touching the test.

- [ ] **Step 3: Fixture + execution test**

`tests/typescriptGenerator/typeOperators.agency`:

```
type User = {
  name: string,
  age: number,
}

type Field = keyof User

type Age = User["age"]

node main() {
  const f: Field = "name"
  const a: Age = 1
  return f
}
```

```bash
make > /tmp/ki-task3-make.log 2>&1; make fixtures > /tmp/ki-task3-fixtures.log 2>&1
grep -n "const Field\|const Age" tests/typescriptGenerator/typeOperators.mjs
git status --short tests/
```

Zero churn outside the new files (hard gate). `tests/agency/keyof-type.agency`:

```
// keyof produces a closed key union; the schema accepts real keys and
// rejects anything else. (Schema bound to a variable first — #480.)
type User = {
  name: string,
  age: number,
}

node accepts() {
  const s = schema(keyof User)
  const r = s.parseJSON("\"name\"")
  if (isSuccess(r)) {
    return r.value
  }
  return "parse failed"
}

node rejects() {
  const s = schema(keyof User)
  const r = s.parseJSON("\"email\"")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}
```

`tests/agency/keyof-type.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "accepts",
      "input": "",
      "expectedOutput": "\"name\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "a real key parses"
    },
    {
      "nodeName": "rejects",
      "input": "",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "a non-key is rejected (would pass under a z.string fallback)"
    }
  ]
}
```

```bash
pnpm run agency test tests/agency/keyof-type.agency > /tmp/ki-task3-exec.log 2>&1; echo "exit=$?"
```

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/assignability.ts lib/backends/typeOperators.codegen.test.ts tests/typescriptGenerator/typeOperators.agency tests/typescriptGenerator/typeOperators.mjs tests/agency/keyof-type.agency tests/agency/keyof-type.test.json
git commit -m "Route type operators through deepResolveNode; pin codegen with fallback-proof assertions"
```

---

### Task 4: Documentation (including the owner-requested checklist fix)

**Files:**
- Modify: `docs/site/guide/types.md`
- Modify: `docs/dev/typechecker/README.md`
- Modify: `docs/dev/adding-features.md`

- [ ] **Step 1: Guide section** (append before References; short sentences, active voice):

```markdown
## keyof and indexed access

`keyof T` is the union of an object type's key names. `T["key"]` is the
type of one field. Both update automatically when the source type
changes:

```ts
type User = {
  name: string,
  email: string,
}

type Field = keyof User        // "name" | "email"
type Name = User["name"]       // string
```

`keyof` produces a closed union, so `match` over a `keyof` value gets
exhaustiveness checking. Add a field to `User` and every match over its
keys reports a missing case.

Both operators need a concrete object type. Records, arrays, and
primitives are errors. Index keys must be string literals. A union of
keys returns a union of field types, so `User[keyof User]` is the type
of every value in `User`.
```

- [ ] **Step 2: Dev docs.** `docs/dev/typechecker/README.md`: one short paragraph next to the built-in generics section — the operators evaluate eagerly in `resolveTypeWithGuard` via `lib/typeChecker/typeOperators.ts`, sharing `builtinGenerics.ts` argument helpers; downstream never sees them; `keyof` is in `RESERVED_TYPE_NAMES`.

- [ ] **Step 3: `docs/dev/adding-features.md` — "Adding a `VariableType` variant" section** (owner-requested). Point at the `typeHints.ts` header checklist as the source of truth. State exactly what is and is not compiler-enforced: `typeKey` and `valueParamSubstitution` fail the build via `never` defaults; `formatTypeHint`'s default throws at RUNTIME only; `mapTypes`/`visitTypes` pass unknown nodes through silently (hand-maintained pair); `deepResolveNode` passes nodes through silently AND that is its correct behavior for most variants, so a missing case sends unresolved nodes to the zod mapper's `z.string()` fallback with no error anywhere. Close with the rule: every new variant gets a codegen test asserting its emitted schema against a NON-string shape, because that test is the only net that catches a `deepResolveNode` miss.

- [ ] **Step 4: Commit**

```bash
git add docs/site/guide/types.md docs/dev/typechecker/README.md docs/dev/adding-features.md
git commit -m "Document keyof, indexed access, and the VariableType variant checklist"
```

---

### Task 5: Full verification, push, PR

- [ ] **Step 1: Sweep**

```bash
pnpm test:run lib > /tmp/ki-task5-lib.log 2>&1; tail -3 /tmp/ki-task5-lib.log
pnpm run lint:structure > /tmp/ki-task5-lint.log 2>&1; echo "lint=$?"
make > /tmp/ki-task5-make.log 2>&1; echo "make=$?"
for t in keyof-type utility-partial recursive-type recursive-type-validated; do pnpm run agency test tests/agency/$t.agency > /tmp/ki-task5-$t.log 2>&1; echo "$t: $?"; done
```

The three re-runs guard the merged features against the parser split (`arrayTypeParser` sits under every type annotation; `recursive-type-validated` also exercises the descriptor path the tag ride-along touches).

- [ ] **Step 2: PR** (body file; no apostrophes on the command line). Cover: the two operators with the drift example and the match-exhaustiveness payoff; the parser split (call the reviewer's attention to the many1/many0 asymmetry and WHY — the bare-match greediness finding); the reserved-`keyof` note with the grep result; the `deepResolveNode` trap observed red before fixed; helper sharing with builtinGenerics; the checklist documentation fix; scope-outs (`Record` support, `typeof` with the architecture reasoning, `T[number]`).

```bash
git push -u origin keyof-indexed
gh pr create --title "Add keyof and indexed access type operators" --body-file /tmp/ki-pr-body.md
```
