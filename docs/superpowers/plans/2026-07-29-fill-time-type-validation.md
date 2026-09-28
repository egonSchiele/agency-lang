# Fill-time type validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `fill` reject a plain value that does not match the hole's declared type — including records, arrays and type aliases — instead of letting the mistake surface when the generated program is compiled.

**Architecture:** Three pieces. A pure function that works out the type of a plain JS value. A small table of the template's own type aliases, built from its AST. And the type checker's existing `isAssignable` doing the comparison, so there is no second implementation of "does this type fit that type".

**Tech Stack:** TypeScript, vitest, the existing type checker under `lib/typeChecker/`.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-28-fill-time-type-validation-design.md`
**Review of that spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-28-fill-time-type-validation-design-REVIEW.md`

## Global Constraints

- **THE DESIGN INVARIANT: fill may only reject a value the completed program's compile would also reject.** Fill is allowed to miss things — that is what "validation, not a guarantee" means. It is never allowed to refuse something that would have compiled. False rejection is the one unforgivable failure for a check running on model-supplied data, because the caller has no way to argue with it.

  This has a concrete consequence, verified: the checker infers a plain string as a **string-literal type** and leaves numbers and booleans **widened** (`synthesizer.ts:406-417`, deliberately, per the comment there). So `const mode: "fast" | "slow" = "fast"` compiles, while `const n: 1 | 2 = 1` does not. Fill's synthesis has to mirror that policy exactly or it invents rejections the compile would never make.

- **Three definitions must agree, and drift between them is the long-term risk.** `liftValue` decides what a value becomes in the generated program; `synthesizeType` decides what type fill says it has; the checker's `synthType` decides what type the compile infers for what it became. Drift toward fail-open silently stops checking; drift toward fail-closed invents false rejections. Say so in the doc comments of the first two, and keep the execution fixture — currently the only thing that exercises all three together.

- **Never commit to `main`.** Task 0 creates the branch. Check `git branch --show-current` before every commit.
- **Do not write a second type comparer.** `isAssignable` decides accept or reject, always. The explanatory walk in Task 4 may only annotate a rejection it has already made.
- **Unknowable means skip, never reject.** This cuts both ways and both directions are load bearing:
  - A **value** the synthesizer cannot describe returns `null`, and validation is skipped.
  - An **expected type** that cannot be fully resolved is also skipped. A template whose types come from an `import`, or that declares an alias inside a body, has names the alias table does not contain. Verified: an unknown alias resolves to itself, and a synthesized record compared against it returns `false` — so without this rule every record fill in such a template is rejected. That is the exact over-rejection this constraint exists to prevent, on an ordinary template shape.

  Guessing is worse than not checking, because fills run on model-supplied data.
- **"Expected FAIL, observed PASS" is a stop condition.** Every run-to-fail step exists to prove the test is not vacuous. If a test passes before its fix is written, stop and find out why.
- Unit tests: `pnpm test:run <path>`. Execution fixtures: `pnpm run a test <path>`, after `make`. Do not run the full agency suite locally.

---

# Background: what is broken

A template can say a hole needs a `Person`. `fill` does not check that it got one.

```ts
static const template = [|
  type Person = {
    name: string;
    age: number
  }

  node main(): string {
    const person: Person = #person
    return "ok ${person.name}"
  }
|]

fill(template, { person: { name: "Alice" } })   // succeeds
```

`age` is required and absent. The failure appears later, when `runCode` compiles the generated program, in a message about source the caller never wrote.

The simpler tell is that this also succeeds:

```ts
type Name = string
const n: Name = #who

fill(t, { who: 42 })    // a number where a string is wanted
```

So the problem is not that records are hard. The hole's type is essentially never checked unless it is spelled `string`, `number` or `boolean` literally.

## Two independent causes

**The expected type is flattened to text before anything compares it.** Upstream, Agency has the hole's type as a structured `VariableType`. By the time it reaches `assertFillerType` (`lib/runtime/template/fill.ts:215`) it is the string `"Person"`, and the check is:

```ts
const primitives = ["string", "number", "boolean"];
if (!primitives.includes(expectedType)) return;   // "Person" is not here → give up
```

**The value cannot be described either.** `certainTypeOf` (`fill.ts:228-242`) handles strings, numbers, booleans and single-literal `Code` fragments. Every object and array returns `null`, meaning unknowable, meaning skip.

Either cause alone is enough. Fixing one without the other changes nothing.

## The two easy-to-miss parts

**One check already exists and must not be lost.** `certainTypeOf`'s fragment handling makes this a rejection today — verified by repro:

```ts
fill(t, { who: [| 42 |] })      // hole annotated `: string` → rejected
```

If the rewrite makes every `Code` value unknowable, that rejection silently stops firing. The synthesizer has to absorb it.

**Splices check one element at a time.** `fillOne` (`fill.ts:168-173`) requires an array for a splice hole and validates **each element** against the hole's expected type. Verified by repro, in argument position (splices are illegal in expression position):

```ts
[| print(#...items: string) |]

fill(t, { items: ["a", "b"] })   // passes
fill(t, { items: ["a", 1] })     // "The hole `#items` expects `string`,
                                 //  but the fill supplies `number`."
```

So a splice annotation describes **one spliced element**, not the array. That is invisible today because only primitive expected types fire. Once records are checked it becomes visible, and it creates a trap: `#...items: Person[]` parses fine (verified — the annotation becomes an array type), and under the new checking every element is rejected for not being an array.

---

# File structure

| File | Responsibility |
| --- | --- |
| `lib/runtime/template/synthesizeType.ts` | **New.** Plain JS value → `VariableType`, or null for unknowable. Pure, no imports from fill. |
| `lib/runtime/template/synthesizeType.test.ts` | **New.** Unit tests for the above, including the dedupe cost bound. |
| `lib/runtime/template/aliasTable.ts` | **New.** A template's `typeAlias` nodes → `Record<string, TypeAliasEntry>`. |
| `lib/runtime/template/explainMismatch.ts` | **New (Task 4).** Failure-only walk that localizes a rejection into a sentence. Returns null when it cannot. |
| `lib/utils/holes.ts` | Add a `VariableType`-returning sibling to `positionInferredTypes`; the string version is built on it. |
| `lib/runtime/template/fill.ts` | Thread `VariableType` instead of printed strings; compare with `isAssignable`. |
| `lib/runtime/template/fill.test.ts` | The behavior tests. |
| `tests/agency/templates/fillTypeMismatch.agency` + `.test.json` | End-to-end fixture: the guide's `Person` example. |
| `docs/site/guide/template-agency.md` | Document record checking and the splice-annotation rule. |

---

### Task 0: Branch

- [ ] **Step 1: Check where you are**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
git branch --show-current
```

- [ ] **Step 2: Create a worktree and branch**

Worktrees go inside the `agency-lang` directory, never the home directory.

```bash
cd /Users/adityabhargava/agency-lang
git worktree add worktree-fill-types -b adit/fill-time-type-validation origin/main
cd worktree-fill-types && pnpm install
git branch --show-current
```

Expected: `adit/fill-time-type-validation`. All later paths are relative to `worktree-fill-types/packages/agency-lang`.

---

### Task 1: Work out the type of a plain value

A pure function with no dependency on the rest of the change, so it is fully testable on its own.

**Files:**
- Create: `lib/runtime/template/synthesizeType.ts`
- Test: `lib/runtime/template/synthesizeType.test.ts`

**Interfaces:**
- Consumes: `isCode` / `kindOf` from `./code.js`; `STRING_T`, `NUMBER_T`, `BOOLEAN_T`, `NULL_T`, `ANY_T` from `../../typeChecker/primitives.js`; `typeKey` from `../../typeChecker/typeKey.js`.
- Produces: `synthesizeType(value: unknown): VariableType | null`. Task 2 calls it.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { synthesizeType } from "./synthesizeType.js";
import { _parseExpr } from "../../stdlib/template.js";

describe("synthesizeType: primitives", () => {
  it("describes strings, numbers, booleans and null", () => {
    expect(synthesizeType("a")).toEqual({ type: "primitiveType", value: "string" });
    expect(synthesizeType(1)).toEqual({ type: "primitiveType", value: "number" });
    expect(synthesizeType(true)).toEqual({ type: "primitiveType", value: "boolean" });
    expect(synthesizeType(null)).toEqual({ type: "primitiveType", value: "null" });
  });
});

describe("synthesizeType: records and arrays", () => {
  it("describes a record property by property", () => {
    expect(synthesizeType({ name: "Alice", age: 30 })).toEqual({
      type: "objectType",
      properties: [
        { key: "name", value: { type: "primitiveType", value: "string" } },
        { key: "age", value: { type: "primitiveType", value: "number" } },
      ],
    });
  });

  it("describes a homogeneous array with a single element type", () => {
    expect(synthesizeType([1, 2, 3])).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });

  it("describes a mixed array as a union of its element types", () => {
    const result = synthesizeType([1, "a"]) as { elementType: { types: unknown[] } };
    expect(result.elementType).toMatchObject({ type: "unionType" });
    expect(result.elementType.types).toHaveLength(2);
  });

  it("describes an empty array as an array of any, which fits anything", () => {
    expect(synthesizeType([])).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "any" },
    });
  });

  it("deduplicates identical element types instead of one per element", () => {
    // Fills run on model-supplied data. Without dedupe a 10,000-element
    // array becomes a 10,000-member union handed to isAssignable.
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `p${i}`, age: i }));
    const result = synthesizeType(many) as { elementType: { type: string } };
    expect(result.elementType.type).toBe("objectType");
  });
});

describe("synthesizeType: literal Code fragments", () => {
  // This is certainTypeOf's existing behavior, absorbed. Losing it would
  // silently drop the one fragment check that exists today.
  it("describes a single-literal expression fragment by its literal", () => {
    expect(synthesizeType(_parseExpr("42"))).toEqual({ type: "primitiveType", value: "number" });
    expect(synthesizeType(_parseExpr(`"hi"`))).toEqual({ type: "primitiveType", value: "string" });
    expect(synthesizeType(_parseExpr("true"))).toEqual({ type: "primitiveType", value: "boolean" });
  });

  it("cannot describe an interpolated string — its value depends on scope", () => {
    expect(synthesizeType(_parseExpr('"${getCount()}"'))).toBeNull();
  });

  it("cannot describe any other fragment", () => {
    expect(synthesizeType(_parseExpr("getGreeting()"))).toBeNull();
  });
});

describe("synthesizeType: what it refuses to guess", () => {
  it("cannot describe a value containing a fragment, at any depth", () => {
    expect(synthesizeType({ body: _parseExpr("getGreeting()") })).toBeNull();
    expect(synthesizeType([_parseExpr("getGreeting()")])).toBeNull();
  });

  it("cannot describe a function", () => {
    expect(synthesizeType(() => 1)).toBeNull();
  });

  it("cannot describe a Date, a Map or a class instance", () => {
    // These are objects to `typeof`. Describing one as a record of its
    // enumerable keys produces a type that REJECTS, which is the opposite
    // of skipping — so they must come back unknowable.
    expect(synthesizeType(new Date())).toBeNull();
    expect(synthesizeType(new Map())).toBeNull();
    expect(synthesizeType(new (class Thing {})())).toBeNull();
  });

  it("treats undefined the same as null", () => {
    expect(synthesizeType(undefined)).toEqual({ type: "primitiveType", value: "null" });
  });
});

describe("synthesizeType: mirroring what the checker infers", () => {
  it("widens strings by default and describes them literally on request", () => {
    expect(synthesizeType("fast")).toEqual({ type: "primitiveType", value: "string" });
    expect(synthesizeType("fast", { stringsAsLiterals: true })).toEqual({
      type: "stringLiteralType",
      value: "fast",
    });
  });

  it("keeps numbers and booleans widened in BOTH modes", () => {
    // synthType does not infer numeric or boolean literal types, so the
    // compile rejects `const n: 1 | 2 = 1`. Describing them literally here
    // would make fill ACCEPT what the compile refuses — drift the other
    // way, and just as wrong.
    expect(synthesizeType(1, { stringsAsLiterals: true })).toEqual({
      type: "primitiveType",
      value: "number",
    });
    expect(synthesizeType(true, { stringsAsLiterals: true })).toEqual({
      type: "primitiveType",
      value: "boolean",
    });
  });

  it("applies the mode inside records and arrays", () => {
    expect(synthesizeType({ mode: "fast" }, { stringsAsLiterals: true })).toEqual({
      type: "objectType",
      properties: [{ key: "mode", value: { type: "stringLiteralType", value: "fast" } }],
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm test:run lib/runtime/template/synthesizeType.test.ts
```

Expected: FAIL, module not found. That is the correct first failure.

- [ ] **Step 3: Write the function**

Create `lib/runtime/template/synthesizeType.ts`:

```ts
import { isCode, kindOf, type Code } from "./code.js";
import { typeKey } from "../../typeChecker/typeKey.js";
import {
  ANY_T,
  BOOLEAN_T,
  NULL_T,
  NUMBER_T,
  STRING_T,
} from "../../typeChecker/primitives.js";
import type { StringLiteral, VariableType } from "../../types.js";

/**
 * The type of a plain runtime value, or null when it cannot be known.
 *
 * Null means "do not check", never "reject". Fills run at run time on
 * model-supplied data, so a guess here would reject correct programs; the
 * completed program's own compile is the backstop for everything this
 * declines to describe.
 *
 * Absorbs what `certainTypeOf` used to do for single-literal fragments —
 * that check predates this function and must not be lost. Moving it here
 * also makes it alias-aware for free, since the caller now resolves the
 * expected type instead of string-matching it.
 *
 * The result may share structure with the shared primitive singletons
 * (`STRING_T` and friends), so treat it as read-only. Nothing should ever
 * mutate a synthesized type.
 *
 * THREE-WAY AGREEMENT, and the reason this file needs care. `liftValue`
 * decides what a value BECOMES in the generated program. This function
 * decides what type fill SAYS it has. The checker's `synthType` decides
 * what type the compile INFERS for what it became. If those three drift
 * apart, fill either stops checking things (harmless, and invisible) or
 * rejects values that compile fine (not harmless). The mirroring that
 * matters today: `synthType` infers a plain string as a string-literal
 * type and leaves numbers and booleans widened
 * (`lib/typeChecker/synthesizer.ts:406-417`) — which is what
 * `stringsAsLiterals` exists to reproduce. Verified: `const mode:
 * "fast" | "slow" = "fast"` compiles, `const n: 1 | 2 = 1` does not.
 */
export type SynthesizeOptions = {
  /**
   * Describe a string as its literal type (`"fast"`) rather than as
   * `string`.
   *
   * Off by default because a large array of distinct strings would become
   * an equally large union. On for the second pass in `assertFillerType`,
   * which runs only when the widened pass has already decided to reject —
   * so the cost lands only on a fill that was about to throw.
   *
   * Numbers and booleans stay widened in BOTH modes, mirroring `synthType`
   * (`synthesizer.ts:406-417`): the compile rejects `const n: 1 | 2 = 1`,
   * so accepting it here would be drift in the other direction.
   */
  stringsAsLiterals?: boolean;
};

export function synthesizeType(
  value: unknown,
  options: SynthesizeOptions = {},
): VariableType | null {
  if (value === null || value === undefined) return NULL_T;
  if (typeof value === "string") {
    return options.stringsAsLiterals === true
      ? { type: "stringLiteralType", value }
      : STRING_T;
  }
  if (typeof value === "number") return NUMBER_T;
  if (typeof value === "boolean") return BOOLEAN_T;
  // Before the object branch: a Code value is an object, and describing it
  // as a record of its own internals would be nonsense.
  if (isCode(value)) return literalFragmentType(value);
  if (Array.isArray(value)) return arrayTypeOf(value, options);
  // Plain objects only. A Date, Map, Set or class instance is an object to
  // `typeof`, and describing one as a record of its own enumerable keys
  // would produce a type that rejects — the opposite of skipping.
  if (isPlainObject(value)) {
    return objectTypeOf(value as Record<string, unknown>, options);
  }
  return null;
}

/** Built by an object literal or `JSON.parse`, not by a constructor. */
function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A fragment holding exactly one uninterpolated literal, and nothing else.
 *  An interpolated string could render anything the generated program's
 *  scope produces, so it stays unknowable in both directions. */
function literalFragmentType(code: Code): VariableType | null {
  if (kindOf(code) !== "expr" || code.nodes.length !== 1) return null;
  const node = code.nodes[0];
  if (node.type === "number") return NUMBER_T;
  if (node.type === "boolean") return BOOLEAN_T;
  if (node.type === "string") {
    const literal = node as StringLiteral;
    const interpolated = literal.segments.some((segment) => segment.type === "interpolation");
    return interpolated ? null : STRING_T;
  }
  return null;
}

/** Member types are deduplicated by canonical key, so a homogeneous array
 *  of 10,000 records yields one member rather than 10,000. Dedupe rather
 *  than sampling a prefix: sampling would make the answer depend on where
 *  an odd element happened to sit. */
function arrayTypeOf(
  value: unknown[],
  options: SynthesizeOptions,
): VariableType | null {
  const members: VariableType[] = [];
  // Keys come from user data, so the seen-set is null-prototype and
  // membership goes through Object.hasOwn (house pattern).
  const seen: Record<string, true> = Object.create(null);
  for (const item of value) {
    const member = synthesizeType(item, options);
    // One unknowable element makes the whole array unknowable: a union
    // missing a member would reject values that are actually fine.
    if (member === null) return null;
    const key = typeKey(member, {});
    if (Object.hasOwn(seen, key)) continue;
    seen[key] = true;
    members.push(member);
  }
  if (members.length === 0) return { type: "arrayType", elementType: ANY_T };
  return {
    type: "arrayType",
    elementType: members.length === 1 ? members[0] : { type: "unionType", types: members },
  };
}

function objectTypeOf(
  value: Record<string, unknown>,
  options: SynthesizeOptions,
): VariableType | null {
  const properties: { key: string; value: VariableType }[] = [];
  for (const key of Object.keys(value)) {
    const propertyType = synthesizeType(value[key], options);
    if (propertyType === null) return null;
    properties.push({ key, value: propertyType });
  }
  return { type: "objectType", properties };
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test:run lib/runtime/template/synthesizeType.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must not be main
git add lib/runtime/template/synthesizeType.ts lib/runtime/template/synthesizeType.test.ts
git commit -F - <<'EOF'
feat: describe a plain value as a type, for fill-time checking

A pure function from a runtime value to a VariableType, or null when the
value cannot be described. Absorbs certainTypeOf's single-literal
fragment handling so that check is not lost when fill switches to
structural comparison. Array member types are deduplicated so a large
homogeneous array does not become an equally large union.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Compare the value against the hole's real type

The core change. After this, records and aliases are checked.

**Files:**
- Create: `lib/runtime/template/aliasTable.ts`
- Modify: `lib/utils/holes.ts` (add the `VariableType` sibling)
- Modify: `lib/runtime/template/fill.ts`
- Test: `lib/runtime/template/fill.test.ts`

**Interfaces:**
- Consumes: `synthesizeType` from Task 1; `isAssignable(source, target, typeAliases)` from `../../typeChecker/assignability.js`; `variableTypeToString` (already imported by fill.ts).
- Produces: `aliasTableFrom(nodes: AgencyNode[]): Record<string, TypeAliasEntry>` and `positionInferredVariableTypes(nodes: AgencyNode[]): Record<string, VariableType>`. Task 4 uses both.

- [ ] **Step 1: Write the failing tests**

Add to `lib/runtime/template/fill.test.ts`, inside the existing
`describe("fill-time type checking", ...)` block or right after it. It
already has a `load` helper and `fillAndPrint`.

```ts
describe("fill-time type checking: records and aliases", () => {
  const personTemplate = [
    "type Person = {",
    "  name: string;",
    "  age: number",
    "}",
    "",
    "node main(): string {",
    "  const person: Person = #person",
    '  return "ok"',
    "}",
    "",
  ].join("\n");

  // These assert THAT the fill is rejected and which hole is named — not
  // the wording. Task 2 throws the general two-types message; the messages
  // that name a property arrive in Task 3, and their assertions live
  // there. Asserting content here would fail at the end of Task 2 and stop
  // the executor for the wrong reason.

  it("rejects a record missing a required property", () => {
    expect(() => fillHoles(load(personTemplate), { person: { name: "Alice" } })).toThrow(
      /#person.*expects/,
    );
  });

  it("rejects a primitive where a record is wanted", () => {
    // The simplest shape of the headline change: expected types that are
    // not one of the three primitive spellings are now checked at all.
    expect(() => fillHoles(load(personTemplate), { person: 42 })).toThrow(/expects/);
  });

  it("accepts a complete record", () => {
    expect(fillAndPrint(personTemplate, { person: { name: "Alice", age: 30 } })).toContain(
      "Alice",
    );
  });

  it("resolves an alias for a primitive", () => {
    const aliased = [
      "type Name = string",
      "",
      "node main(): string {",
      "  const n: Name = #who",
      "  return n",
      "}",
      "",
    ].join("\n");
    expect(() => fillHoles(load(aliased), { who: 42 })).toThrow(/string|Name/);
    expect(fillAndPrint(aliased, { who: "Alice" })).toContain("Alice");
  });

  it("checks a nested record", () => {
    const nested = [
      "type Address = {",
      "  city: string",
      "}",
      "type Person = {",
      "  name: string;",
      "  address: Address",
      "}",
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(nested), { person: { name: "A", address: {} } }),
    ).toThrow(/expects/);
  });

  it("checks an array of records", () => {
    const list = [
      "type Person = {",
      "  name: string;",
      "  age: number",
      "}",
      "",
      "node main(): string {",
      "  const people: Person[] = #people",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(list), { people: [{ name: "A", age: 1 }, { name: "B" }] }),
    ).toThrow(/expects/);
    expect(fillAndPrint(list, { people: [{ name: "A", age: 1 }] })).toContain("A");
  });

  it("accepts an absent optional property", () => {
    const optional = [
      "type Person = {",
      "  name: string;",
      "  nickname?: string",
      "}",
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(optional, { person: { name: "A" } })).toContain("A");
  });

  it("accepts any arm of a union and rejects something outside it", () => {
    const union = [
      "node main(): string {",
      "  const v: string | number = #v",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(union, { v: "a" })).toContain('"a"');
    expect(fillAndPrint(union, { v: 1 })).toContain("1");
    expect(() => fillHoles(load(union), { v: true })).toThrow(/expects/);
  });

  it("accepts a string against a union of string literals", () => {
    // THE INVARIANT TEST. `const mode: "fast" | "slow" = "fast"` compiles,
    // so fill must not refuse it. The widened description does not fit the
    // union; the literal-accurate second pass does.
    const literals = [
      "node main(): string {",
      '  const mode: "fast" | "slow" = #mode',
      "  return mode",
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(literals, { mode: "fast" })).toContain('"fast"');
    // And still rejects one that is genuinely outside the union — the
    // compile rejects this too.
    expect(() => fillHoles(load(literals), { mode: "medium" })).toThrow(/expects/);
  });

  it("rejects a number against a union of number literals, as the compile does", () => {
    // synthType widens numbers, so `const n: 1 | 2 = 1` does NOT compile.
    // Fill agreeing with that is the invariant working in both directions.
    const numeric = [
      "node main(): number {",
      "  const n: 1 | 2 = #n",
      "  return n",
      "}",
      "",
    ].join("\n");
    expect(() => fillHoles(load(numeric), { n: 1 })).toThrow(/expects/);
  });

  it("accepts an empty array for an array hole", () => {
    const list = [
      "node main(): string {",
      "  const xs: number[] = #xs",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(list, { xs: [] })).toContain("[]");
  });

  it("does not hang on a recursive alias", () => {
    // isAssignable's cycle guard is the reason this reuses the checker
    // rather than hand-rolling a comparison, so it is worth a test.
    const recursive = [
      "type Tree = {",
      "  value: number;",
      "  children: Tree[]",
      "}",
      "",
      "node main(): string {",
      "  const t: Tree = #tree",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(
      fillAndPrint(recursive, { tree: { value: 1, children: [{ value: 2, children: [] }] } }),
    ).toContain("value");
  });

  it("still lets an unknowable fragment through", () => {
    expect(
      fillAndPrint(personTemplate, { person: _parseExpr("buildPerson()") }),
    ).toContain("buildPerson()");
  });

  it("checks a hole with an inline record annotation", () => {
    // Every other record test reaches the type through the assignment
    // position. This is the `hole.typeAnnotation` branch with a named type,
    // which is the other half of how a hole gets its expected type.
    const inline = [
      "type Person = {",
      "  name: string;",
      "  age: number",
      "}",
      "",
      "node main() {",
      "  f(#person: Person)",
      "}",
      "",
    ].join("\n");
    expect(() => fillHoles(load(inline), { person: { name: "A" } })).toThrow(/expects/);
    expect(fillAndPrint(inline, { person: { name: "A", age: 1 } })).toContain("A");
  });

  it("rejects null for a non-nullable hole and accepts it for a nullable one", () => {
    const strict = `node main() {\n  const s: string = #v\n  return s\n}\n`;
    expect(() => fillHoles(load(strict), { v: null })).toThrow(/expects/);
    const nullable = `node main() {\n  const s: string | null = #v\n  return "ok"\n}\n`;
    expect(fillAndPrint(nullable, { v: null })).toContain("null");
  });

  it("rejects a bad element inside a recursive alias, and terminates", () => {
    // The accepting recursive case exercises the cycle guard; a rejection
    // INSIDE the cycle is the riskier path through it.
    const recursive = [
      "type Tree = {",
      "  value: number;",
      "  children: Tree[]",
      "}",
      "",
      "node main(): string {",
      "  const t: Tree = #tree",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(recursive), { tree: { value: 1, children: [{ value: 2 }] } }),
    ).toThrow(/expects/);
  });
});

describe("fill-time type checking: a type it cannot resolve is not checked", () => {
  // The rule that keeps this feature from rejecting ordinary templates.
  // An unknown alias resolves to itself, and a synthesized record compared
  // against it is not assignable — so without the guard, every one of
  // these templates would reject every record fill.

  it("accepts a record when the type comes from an import", () => {
    const imported = [
      'import { Person } from "./types.agency"',
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(imported, { person: { name: "A" } })).toContain("A");
  });

  it("accepts a record when the alias is declared inside a body", () => {
    const bodyAlias = [
      "node main(): string {",
      "  type Local = {",
      "    name: string;",
      "    age: number",
      "  }",
      "  const p: Local = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    // `aliasTableFrom` collects top-level aliases only, so `Local` is
    // unresolvable here and the fill is not checked.
    expect(fillAndPrint(bodyAlias, { person: { name: "A" } })).toContain("A");
  });

  it("accepts a record when an unresolved name is nested deep in the type", () => {
    const deep = [
      "type Person = {",
      "  name: string;",
      "  pet: Animal",
      "}",
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    // `Animal` is undeclared, so `Person` is not fully resolvable even
    // though `Person` itself is in the table.
    expect(fillAndPrint(deep, { person: { name: "A" } })).toContain("A");
  });

  it("still rejects a literal fragment of the wrong primitive", () => {
    // The pre-existing check, which must survive the rewrite.
    const t = `node main() {\n  const prompt: string = #text\n  return prompt\n}\n`;
    expect(() => fillHoles(load(t), { text: _parseExpr("42") })).toThrow(/string/);
  });

  it("now rejects a literal fragment against an alias, which it could not before", () => {
    const aliased = [
      "type Name = string",
      "",
      "node main(): string {",
      "  const n: Name = #who",
      "  return n",
      "}",
      "",
    ].join("\n");
    expect(() => fillHoles(load(aliased), { who: _parseExpr("42") })).toThrow(/string|Name/);
  });
});

describe("fill-time type checking: splices check one element at a time", () => {
  // A splice annotation describes ONE spliced element, not the array. This
  // is what the code already does; these tests make it deliberate.
  const spliceTemplate = `node main() {\n  f(#...items: string)\n}\n`;

  it("accepts an array whose every element matches", () => {
    expect(fillAndPrint(spliceTemplate, { items: ["a", "b"] })).toContain('f("a", "b")');
  });

  it("rejects the element that does not match", () => {
    expect(() => fillHoles(load(spliceTemplate), { items: ["a", 1] })).toThrow(/number/);
  });

  it("checks record elements property by property", () => {
    const records = [
      "type Person = {",
      "  name: string;",
      "  age: number",
      "}",
      "",
      "node main() {",
      "  f(#...people: Person)",
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(records), { people: [{ name: "A", age: 1 }, { name: "B" }] }),
    ).toThrow(/age/);
  });

  it("rejects an array-typed splice annotation, which is the easy mistake", () => {
    // `#...items: Person[]` parses, and each ELEMENT is then checked
    // against `Person[]` — so a correct list of people is rejected. Task 4
    // adds a message for this; here we pin that it is a rejection.
    const arrayAnnotated = [
      "type Person = {",
      "  name: string;",
      "  age: number",
      "}",
      "",
      "node main() {",
      "  f(#...people: Person[])",
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(arrayAnnotated), { people: [{ name: "A", age: 1 }] }),
    ).toThrow();
  });
});
```

`_parseExpr` is already imported at the top of this test file.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm test:run lib/runtime/template/fill.test.ts -t "records and aliases"
```

Expected: the rejection tests FAIL (they currently pass through and throw nothing); the acceptance tests PASS. If a rejection test passes now, stop — it means something else is rejecting and the test is not measuring what it claims.

- [ ] **Step 3: Add the alias table**

Create `lib/runtime/template/aliasTable.ts`:

```ts
import type { AgencyNode, TypeAlias, TypeAliasEntry } from "../../types.js";

/**
 * A template's own type aliases, in the shape the type checker's resolver
 * expects.
 *
 * A template carries its type declarations with it — `type Person = { … }`
 * is part of the same `Code` value being filled — which is what makes
 * resolving a hole's declared type possible at run time without a compile.
 *
 * Top level only. Aliases declared inside a body are not in scope at a
 * top-level hole, and an alias this table cannot find is treated as
 * unknowable by the caller rather than as an error.
 *
 * `typeParams`, `valueParams` and `tags` are carried, not just `body`:
 * generic and value-parameterized aliases are legal in templates, and
 * dropping those fields would make such an alias resolve WRONGLY rather
 * than not at all — the worse failure.
 */
export function aliasTableFrom(nodes: AgencyNode[]): Record<string, TypeAliasEntry> {
  // Alias names come from user source, so null-prototype (house pattern).
  const table: Record<string, TypeAliasEntry> = Object.create(null);
  for (const node of nodes) {
    if (node.type !== "typeAlias") continue;
    const alias = node as TypeAlias;
    const entry: TypeAliasEntry = { body: alias.aliasedType };
    if (alias.typeParams !== undefined) {
      entry.typeParams = alias.typeParams;
    }
    if (alias.valueParams !== undefined) {
      entry.valueParams = alias.valueParams;
    }
    if (alias.tags !== undefined) {
      entry.tags = alias.tags;
    }
    if (alias.isEffectSet !== undefined) {
      entry.isEffectSet = alias.isEffectSet;
    }
    table[alias.aliasName] = entry;
  }
  return table;
}
```

Plain `if` assignments, not conditional spreads — `{ ...(x ? { x } : {}) }` is
banned by name in `docs/dev/anti-patterns.md`.

- [ ] **Step 4: Give `positionInferredTypes` a structured sibling**

In `lib/utils/holes.ts`, replace the body of `positionInferredTypes` so that
exactly one place decides what type a position supplies, and the printed
form is derived from it:

```ts
/** Types the hole's POSITION supplies, keyed by hole name — today the
 *  annotated-assignment position (`const x: string = #text`). First
 *  occurrence wins, matching holeInfos: when the same name appears in
 *  positions of DIFFERENT types, only the first is validated against, and
 *  a mismatch at the second falls through to the completed program. */
export function positionInferredVariableTypes(
  nodes: AgencyNode[],
): Record<string, VariableType> {
  // Null-prototype: keyed by user-controlled hole names.
  const inferred: Record<string, VariableType> = Object.create(null);
  for (const visit of walkNodesArray(nodes)) {
    if (visit.node.type !== "hole") continue;
    const hole = visit.node as Hole;
    if (hole.typeAnnotation || inferred[hole.name]) continue;
    const parent = visit.ancestors[visit.ancestors.length - 1] as
      | AgencyNode
      | undefined;
    if (parent && parent.type === "assignment" && parent.typeHint) {
      inferred[hole.name] = parent.typeHint;
    }
  }
  return inferred;
}

/** The printed form of the above, for `holesOf` and for error messages.
 *  Derived, never re-derived: one place decides what a position supplies. */
export function positionInferredTypes(nodes: AgencyNode[]): Record<string, string> {
  const printed: Record<string, string> = Object.create(null);
  for (const [name, type] of Object.entries(positionInferredVariableTypes(nodes))) {
    printed[name] = variableTypeToString(type, {}, true);
  }
  return printed;
}
```

`VariableType` needs adding to this file's type imports if it is not already there.

- [ ] **Step 5: Thread the real type through `fill.ts`**

Four edits, all mechanical once the shape is chosen. Replace the
`expected: Record<string, string>` parameter threaded through
`substituteInArray`, `substituteAny` and `fillOne` with one context object,
so adding the alias table does not mean a second parameter at every level:

```ts
/** What fill-time validation needs, threaded as one value so the
 *  substitution walkers do not grow a parameter per lookup table. */
type FillTypes = {
  /** Hole name → the type its position supplies. An inline annotation on
   *  the hole itself wins over this; see `fillOne`. */
  expected: Record<string, VariableType>;
  /** The template's own type aliases, for resolving a named type. */
  aliases: Record<string, TypeAliasEntry>;
};
```

In `fillHoles`, replace the `expected` line (`fill.ts:90-92`):

```ts
  // Everything fill-time validation needs: the type each hole's position
  // supplies, and the template's own aliases to resolve names against.
  const types: FillTypes = {
    expected: positionInferredVariableTypes(renamedTemplate.nodes),
    aliases: aliasTableFrom(renamedTemplate.nodes),
  };
```

and pass `types` where `expected` was passed.

In `fillOne`, the expected type is now a `VariableType`:

```ts
  const expectedType = hole.typeAnnotation ?? types.expected[hole.name];
```

And `assertFillerType` becomes:

```ts
/**
 * Fill-time type VALIDATION — deliberately not a compile-time guarantee.
 *
 * Rejects only when both sides are certainly known: a plain value's type is
 * immediate (`synthesizeType`), and the hole's declared type resolves
 * against the template's own aliases. Anything the synthesizer cannot
 * describe — a real code fragment, a value holding one — passes here and is
 * judged when the completed program compiles.
 *
 * The comparison is the type checker's own `isAssignable`, never a local
 * reimplementation: a second comparer would disagree with the checker in
 * exactly the cases nobody writes a test for.
 */
function assertFillerType(
  hole: Hole,
  value: unknown,
  expectedType: VariableType,
  aliases: Record<string, TypeAliasEntry>,
): void {
  const actual = synthesizeType(value);
  if (actual === null) return;
  // A type we cannot fully resolve is as unknowable as a value we cannot
  // describe. Without this, a template that imports its types or declares
  // an alias inside a body has EVERY record fill rejected: an unknown
  // alias resolves to itself, and a synthesized record compared against it
  // is simply not assignable.
  if (hasUnresolvedName(expectedType, aliases)) return;
  if (isAssignable(actual, expectedType, aliases)) return;
  // Second chance before rejecting, on the failure path only. The fast
  // path above describes a string as `string`, but the checker infers a
  // string literal — so `const mode: "fast" | "slow" = #mode` filled with
  // "fast" compiles while the widened type does not fit. Re-describe
  // literal-accurately and re-check. This can only ever turn a rejection
  // into an acceptance (a literal type fits everywhere `string` does), so
  // it cannot introduce a false accept, and its cost lands only on fills
  // that were about to throw.
  const literalAccurate = synthesizeType(value, { stringsAsLiterals: true });
  if (literalAccurate !== null && isAssignable(literalAccurate, expectedType, aliases)) {
    return;
  }
  const printedExpected = variableTypeToString(expectedType, {}, true);
  const printedActual = variableTypeToString(actual, {}, true);
  throw new Error(
    `The hole \`#${hole.name}\` expects \`${printedExpected}\`, but the fill supplies \`${printedActual}\`${originSuffix(hole.loc)}.`,
  );
}
```

Delete `certainTypeOf` — `synthesizeType` has absorbed it. Leave the splice
path in `fillOne` exactly as it is: passing `expectedType` per element is
what makes a splice annotation describe one element, which Task 2's tests
now pin.

- [ ] **Step 5b: Add the unresolved-name guard**

Also in `fill.ts`, next to `assertFillerType`. Reuse the checker's walk —
`visitTypes` (`lib/typeChecker/typeWalker.ts:82`) descends through arrays,
unions, object properties, generic arguments and the rest, and
short-circuits when the callback returns true:

```ts
/**
 * True when any name in this type is one the alias table cannot resolve.
 *
 * The template carries its own aliases, so a type whose names all resolve
 * is fully known. A name that does not — because the template imports the
 * type, or declares it inside a body, or it is simply undeclared — makes
 * the whole expected type unknowable, and unknowable means skip.
 *
 * Deliberately fails toward skipping: if this ever over-reports, some
 * fills go unchecked, which is the same weaker-but-safe position the
 * feature started from. Under-reporting would reject correct programs.
 */
function hasUnresolvedName(
  type: VariableType,
  aliases: Record<string, TypeAliasEntry>,
): boolean {
  return visitTypes(type, (inner) => {
    // Alias names are user-controlled keys, so membership is Object.hasOwn.
    if (inner.type === "typeAliasVariable") {
      return !Object.hasOwn(aliases, inner.aliasName);
    }
    if (inner.type === "genericType") {
      return !isBuiltinGenericName(inner.name) && !Object.hasOwn(aliases, inner.name);
    }
    return false;
  });
}
```

`visitTypes` comes from `../../typeChecker/typeWalker.js` and
`isBuiltinGenericName` from `../../typeChecker/builtinGenerics.js`.

- [ ] **Step 6: Run the fill tests**

```bash
pnpm test:run lib/runtime/template/fill.test.ts
```

Expected: PASS, including every pre-existing test in the file. Two of those
are load-bearing here — "treats an interpolated string literal as
unknowable" and "validates against the FIRST position when a name appears
twice" both already exist and must stay green.

- [ ] **Step 7: Run the wider suites**

```bash
pnpm test:run lib/runtime/ lib/utils/ lib/stdlib/
```

Expected: PASS. `positionInferredTypes` feeds `holesOf`, whose output shape
is public, so a failure here most likely means the printed form changed.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must not be main
git add lib/runtime/template/aliasTable.ts lib/runtime/template/fill.ts lib/utils/holes.ts lib/runtime/template/fill.test.ts
git commit -F - <<'EOF'
fix: fill checks a plain value against the hole's real type

The expected type was flattened to a string before anything compared it,
so only the three primitive spellings were ever checked — a record type
or an alias fell straight through. Carry the VariableType instead, build
the template's own alias table from its AST, and compare with the type
checker's isAssignable.

A record missing a required property, or an alias for a primitive given
the wrong one, is now rejected at fill instead of at runCode.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Say what is actually wrong

`expects Person, but the fill supplies { name: string }` makes the reader
diff two types by eye. This task names the problem.

**Files:**
- Create: `lib/runtime/template/explainMismatch.ts`
- Modify: `lib/runtime/template/fill.ts` (use it in the error path only)
- Test: `lib/runtime/template/fill.test.ts`

**Interfaces:**
- Consumes: `resolveType` from `../../typeChecker/assignability.js`; `synthesizeType`.
- Produces: `explainMismatch(value, expected, aliases): string | null`.

**The containment rule, which is the whole design of this task:** the walk
may never change the accept/reject decision. `isAssignable` has already
decided to reject; this only annotates. When it cannot localize the problem
it returns null and the general two-types message is used. Structurally it
is never consulted about whether to throw.

- [ ] **Step 1: Write the failing tests**

```ts
describe("fill-time type checking: the error says what is wrong", () => {
  const personTemplate = [
    "type Person = {",
    "  name: string;",
    "  age: number",
    "}",
    "",
    "node main(): string {",
    "  const person: Person = #person",
    '  return "ok"',
    "}",
    "",
  ].join("\n");

  it("names the missing property", () => {
    expect(() => fillHoles(load(personTemplate), { person: { name: "Alice" } })).toThrow(
      /missing the required property `age`/,
    );
  });

  it("names the property whose type is wrong, and both types", () => {
    expect(() =>
      fillHoles(load(personTemplate), { person: { name: "Alice", age: "thirty" } }),
    ).toThrow(/age/);
  });

  it("names a missing property nested one level down, with its path", () => {
    const nested = [
      "type Address = {",
      "  city: string",
      "}",
      "type Person = {",
      "  name: string;",
      "  address: Address",
      "}",
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(nested), { person: { name: "A", address: {} } }),
    ).toThrow(/address\.city/);
  });

  it("blames the right property when another one is aliased", () => {
    // The walk reaches `name` first. Comparing printed types would see
    // `string` against `Name`, differ, and blame a property that is fine —
    // while the real problem, the missing `age`, goes unnamed.
    const aliasedProperty = [
      "type Name = string",
      "type Person = {",
      "  name: Name;",
      "  age: number",
      "}",
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    const run = () => fillHoles(load(aliasedProperty), { person: { name: "Alice" } });
    expect(run).toThrow(/age/);
    expect(run).not.toThrow(/name/);
  });

  it("falls back to the general message when it cannot localize", () => {
    // A union mismatch has no single property to blame. Assert the general
    // message's own tail — `/expects/` alone would also match a
    // confidently wrong specific message, which is the failure this test
    // exists to catch.
    const union = [
      "node main(): string {",
      "  const v: string | number = #v",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(() => fillHoles(load(union), { v: true })).toThrow(/supplies `boolean`/);
  });

  it("keeps the graft origin on a hole that arrived through a fill", () => {
    // The origin suffix only appears for a hole that ARRIVED in grafted
    // code, so this needs two fills: graft a fragment carrying #person,
    // then fill #person badly.
    // A primitive type on purpose: a named type would not resolve in the
    // outer template's alias table, and an unresolvable type is skipped,
    // so nothing would be thrown to carry an origin suffix.
    const outer = `node main(): string {\n  #body\n}\n`;
    const inner = _parseStatements(`const p: string = #person\n`);
    const grafted = fillHoles(load(outer), { body: inner });
    expect(() => fillHoles(grafted, { person: 42 })).toThrow(
      /in code grafted by the fill for `#body`/,
    );
  });

  it("explains the array-annotated splice instead of just rejecting it", () => {
    const arrayAnnotated = [
      "type Person = {",
      "  name: string;",
      "  age: number",
      "}",
      "",
      "node main() {",
      "  f(#...people: Person[])",
      "}",
      "",
    ].join("\n");
    // `#...people` describes ONE element, so an array annotation rejects
    // every element. Say so, rather than leaving the author to work out
    // why correct data was refused.
    expect(() =>
      fillHoles(load(arrayAnnotated), { people: [{ name: "A", age: 1 }] }),
    ).toThrow(/one element|describes one/);
  });

  it("does not give that hint when the array annotation is correct", () => {
    // `#...rows: number[]` splicing rows of numbers is a legitimate
    // array-typed splice. A bad element must get the ordinary message, not
    // advice to change an annotation that is right.
    const rows = `node main() {\n  f(#...rows: number[])\n}\n`;
    const run = () => fillHoles(load(rows), { rows: [[1, 2], "x"] });
    expect(run).toThrow(/expects/);
    expect(run).not.toThrow(/describes one element/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm test:run lib/runtime/template/fill.test.ts -t "says what is wrong"
```

Expected: the specific-message tests FAIL against the general message from
Task 2. The fallback test and the hole-name test should already PASS.

- [ ] **Step 3: Write the explainer**

Create `lib/runtime/template/explainMismatch.ts`:

```ts
import { resolveType } from "../../typeChecker/assignability.js";
import { variableTypeToString } from "../../backends/typescriptGenerator/typeToString.js";
import { synthesizeType } from "./synthesizeType.js";
import type { ObjectType, TypeAliasEntry, VariableType } from "../../types.js";

/**
 * A sentence naming what is wrong with a rejected value, or null.
 *
 * CONTAINMENT RULE, and the reason this file is safe to exist: this walk
 * NEVER decides whether to reject. `isAssignable` has already decided.
 * This only annotates that decision, and returning null means "I cannot
 * localize it — use the general message". It is deliberately partial: it
 * handles the common record cases and declines everything else, rather
 * than growing into a second comparer that can disagree with the checker.
 */
export function explainMismatch(
  value: unknown,
  expected: VariableType,
  aliases: Record<string, TypeAliasEntry>,
  path: string = "",
): string | null {
  const target = resolveType(expected, aliases);
  if (target.type !== "objectType") return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  for (const property of (target as ObjectType).properties) {
    const label = path === "" ? property.key : `${path}.${property.key}`;
    // Property names come from a type declaration, but the record's keys
    // come from user data, so membership goes through Object.hasOwn.
    if (!Object.hasOwn(record, property.key)) {
      if (isOptionalType(property.value, aliases)) continue;
      return `is missing the required property \`${label}\``;
    }
    const propertyValue = record[property.key];
    // Literal-accurate, matching the second pass in `assertFillerType`.
    // With the widened description this would blame a property holding
    // "fast" against a `"fast" | "slow"` field — a property the final
    // decision considers fine.
    const actual = synthesizeType(propertyValue, { stringsAsLiterals: true });
    if (actual === null) continue;
    // The SAME comparer as the accept/reject decision. Comparing printed
    // strings instead would mis-blame every aliased property: `name: Name`
    // given "Alice" prints as `string` vs `Name` and reads as an error,
    // when the real problem is a different property entirely.
    if (isAssignable(actual, property.value, aliases)) continue;
    // One level down before blaming this property: a nested record with a
    // missing field is far more useful reported as `address.city` than as
    // "address is wrong".
    const deeper = explainMismatch(propertyValue, property.value, aliases, label);
    if (deeper !== null) return deeper;
    const printedActual = variableTypeToString(actual, {}, true);
    const printedExpected = variableTypeToString(property.value, {}, true);
    return `has \`${label}\` as \`${printedActual}\` where \`${printedExpected}\` is expected`;
  }
  return null;
}
```

Import `isOptionalType` from `../../typeChecker/assignability.js` rather
than writing a null-union check here: it takes the alias table and resolves
before answering, which a local version would not, and duplicating an
existing helper with a worse one is the catalog's first anti-pattern.

- [ ] **Step 4: Use it in the error path only**

In `assertFillerType`, between the `isAssignable` decision and the throw:

```ts
  if (isAssignable(actual, expectedType, aliases)) return;
  // Only after isAssignable has decided to reject. The explainer never
  // participates in that decision — see explainMismatch's contract.
  const detail = explainMismatch(value, expectedType, aliases);
  const printedExpected = variableTypeToString(expectedType, {}, true);
  if (detail !== null) {
    throw new Error(
      `The hole \`#${hole.name}\` expects \`${printedExpected}\`, but the fill ${detail}${originSuffix(hole.loc)}.`,
    );
  }
  const printedActual = variableTypeToString(actual, {}, true);
  throw new Error(
    `The hole \`#${hole.name}\` expects \`${printedExpected}\`, but the fill supplies \`${printedActual}\`${originSuffix(hole.loc)}.`,
  );
```

- [ ] **Step 5: Add the splice hint**

Still in `assertFillerType`, before the general throw. A splice hole whose
expected type is an array is the reachable mistake from the background
section:

```ts
  // `#...items: Person[]` reads naturally and is wrong: each element is
  // checked against the annotation, so an array type rejects every
  // element. Point at the fix rather than leaving the author to deduce it.
  const resolvedExpected = resolveType(expectedType, aliases);
  if (
    hole.splice &&
    resolvedExpected.type === "arrayType" &&
    // Only claim this when the evidence supports it: the element FITS one
    // level down, so the annotation is one level up. An array-typed splice
    // is sometimes correct (`#...rows: number[]` splicing rows of
    // numbers), and a genuinely bad element there must get the ordinary
    // message, not advice to change a correct annotation.
    isAssignable(actual, (resolvedExpected as ArrayType).elementType, aliases)
  ) {
    const element = variableTypeToString(
      (resolvedExpected as ArrayType).elementType,
      {},
      true,
    );
    throw new Error(
      `The splice \`#...${hole.name}\` describes one element, not the array — its type should be \`${element}\`, not \`${printedExpected}\`${originSuffix(hole.loc)}.`,
    );
  }
```

Place this before the `explainMismatch` call: it is a more specific
diagnosis of the same rejection. `ArrayType` needs adding to `fill.ts`'s
type imports.

- [ ] **Step 6: Run the tests**

```bash
pnpm test:run lib/runtime/template/fill.test.ts
```

Expected: PASS, all of them.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must not be main
git add lib/runtime/template/explainMismatch.ts lib/runtime/template/fill.ts lib/runtime/template/fill.test.ts
git commit -F - <<'EOF'
feat: fill errors name the property that is wrong

"expects Person, but supplies { name: string }" makes the reader diff two
types by eye. Name the missing or mismatched property instead, falling
back to the general message when the problem cannot be localized.

The explainer never decides whether to reject — isAssignable has already
decided; this only annotates. Also catches the array-annotated splice,
where each element is checked against the annotation so `Person[]`
rejects a correct list of people.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: End to end, and the docs

**Files:**
- Create: `tests/agency/templates/fillTypeMismatch.agency` + `.test.json`
- Modify: `docs/site/guide/template-agency.md`

- [ ] **Step 1: Write the execution fixture**

Create `tests/agency/templates/fillTypeMismatch.agency`:

```ts
import { fill } from "std::agency"

// The guide's own Person example. A record missing a required property
// used to fill happily and fail later, inside generated source the caller
// never wrote. It is rejected at the fill now, naming the property.
static const template = [|
  type Person = {
    name: string;
    age: number
  }

  node main(): string {
    const person: Person = #person
    return "hello ${person.name}"
  }
|]

node main(): string {
  const filled = fill(template, { person: { name: "Alice" } })
  match(filled) {
    success(_) => return "filled, which is wrong"
    failure(e) => {
      if (e.includes("age")) {
        return "ok"
      }
      return "rejected without naming age: ${e}"
    }
  }
}
```

Create `tests/agency/templates/fillTypeMismatch.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"ok\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "A record missing a required property is rejected at fill, naming the property"
    }
  ]
}
```

- [ ] **Step 2: Build and run it**

```bash
make
pnpm run a test tests/agency/templates/fillTypeMismatch.agency 2>&1 | tee /tmp/fill-fixture.log
```

Expected: PASS. If the `match` / `failure` shape does not compile, copy the
result-handling shape from a neighbouring fixture rather than inventing one
— several in that directory already branch on a `Result`.

- [ ] **Step 3: Update the guide**

`docs/site/guide/template-agency.md` has a "Hole types" section that shows a
primitive mismatch and says "This is a runtime failure". Add the content
below after it. **Take the content, not the fencing** — the block below nests
code fences inside a markdown fence, so copying it literally will end the
outer block early. Write real fences in the guide.

```markdown
Records are checked the same way. If the hole wants a `Person` and the object
you supply is missing a required property, the fill fails and tells you which
one:

```
The hole `#person` expects `Person`, but the fill is missing the required
property `age`.
```

Type aliases are resolved, so `type Name = string` behaves exactly like
`string`.

What is checked is the *shape* of the value. Validators attached with
`@validate(...)` do not run at fill time — a value can pass the fill and still
fail its validator when the completed program runs.

Fill checks types the template declares itself. A type the template
**imports** cannot be resolved while the template is only a value, so a hole
using an imported type is not checked at fill — the mistake is caught when
the completed program compiles, as it was before. This matters as soon as
you keep shared types in their own file, so it is worth knowing which of
your templates are actually covered.

### Splice holes describe one element

A splice hole fills several items at once, and its type describes **one of
them**, not the list:

```ts
[| f(#...people: Person) |]
```

Each element of the array you supply is checked against `Person`. Writing
`#...people: Person[]` is the natural mistake and rejects everything, because
no single person is a list of people.
```

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # must not be main
git add tests/agency/templates/fillTypeMismatch.agency tests/agency/templates/fillTypeMismatch.test.json docs/site/guide/template-agency.md
git commit -F - <<'EOF'
test: end-to-end fixture and guide text for record checking at fill

Runs the guide's own Person example and asserts the fill is rejected
naming the missing property. Documents record checking, alias
resolution, that @validate does not run at fill, and that a splice
annotation describes one element.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: File the follow-up

The unresolved-name skip is correct policy, but it makes the feature quietly
inert for any template that imports its types — and importing types becomes
the normal shape as template libraries grow. The guide sentence in Task 4
tells users. This issue tracks closing the gap.

- [ ] **Step 1: File it**

Write the body to a file and pass `--body-file` (apostrophes on the command
line fail in this repo). Content:

- **Title:** Fill-time type checking skips holes whose type is imported
- A hole typed with an imported type is not checked at fill, because the
  alias table is built only from the template's own `typeAlias` nodes. The
  skip is deliberate — an unresolved name compares as "does not match", so
  checking anyway would reject every correct fill — but the effect is that
  the feature is silently inert for a growing share of templates.
- Closing it needs module resolution at fill time: given the template's
  imports, load and resolve the types it names. That is the same
  module-resolution capability the deferred `Code`-fragment checking needs
  (the seam marked in `fill.ts`), so the two belong together.
- Note the guide states the boundary today, so this is a capability gap, not
  a correctness bug.

- [ ] **Step 2: Reference it from the code**

Add the issue number to the comment on `hasUnresolvedName` in `fill.ts`, so
the next reader finds the plan rather than re-deriving why the skip exists.

---

# Before opening the PR

- [ ] **Audit the diff** against `docs/dev/anti-patterns.md` and
  `docs/dev/coding-standards.md`. Standing requirement in this repo.

- [ ] **Run the structural linter.**

```bash
pnpm run lint:structure
```

- [ ] **Run the full unit suite once, saving output.**

```bash
pnpm test:run 2>&1 | tee /tmp/full-test-run.log
```

Read the log rather than re-running to find what failed.

- [ ] **Run the template fixtures.**

```bash
pnpm run a test tests/agency/templates 2>&1 | tee /tmp/templates.log
```

- [ ] **PR description in a file**, passed with `--body-file`. Apostrophes on
  the command line fail in this repo.

- [ ] **State the behavior change plainly in the PR.** `fill` now rejects
  inputs it previously accepted. A template and filler that work today
  because the missing field is never read will start failing. That is the
  intended trade, and it should be read rather than discovered.

- [ ] **Remove the worktree** once merged:
  `git worktree remove worktree-fill-types`.

---

# Self-review notes

**Spec coverage.** Synthesizer including the literal-fragment row, the
plain-object restriction and array dedupe: Task 1. The spec's
"unresolvable alias is unknowable" rule: Task 2 Step 5b, with three
acceptance tests. Carrying `VariableType`, the alias table, and `isAssignable`:
Task 2. Splice semantics and its trap: Task 2 (behavior, pinned) and Task 3
(message). Error message quality with the containment rule: Task 3. `@validate`
not running at fill, and the splice rule: Task 4's guide text. First
occurrence winning already has a test in `fill.test.ts` ("validates against
the FIRST position when a name appears twice") — Task 2 Step 6 calls it out as
one that must stay green rather than adding a duplicate.

**Placeholders.** None. Every code step carries the code; every run step
carries the command and the expected result.

**Type consistency.** `synthesizeType(value): VariableType | null` is defined
in Task 1 and called with that signature in Tasks 2 and 3.
`aliasTableFrom(nodes)` and `positionInferredVariableTypes(nodes)` are defined
in Task 2 and used in Task 3. `FillTypes` is introduced once and threaded.

**Known soft spots**, in the order I would worry about them:

1. **Extra properties.** Whether `{ name, age, nickname }` satisfies
   `{ name, age }` is `isAssignable`'s decision and I have not verified which
   way it goes. No test asserts it in this plan on purpose — add one during
   implementation recording whatever it does, so the behavior is pinned
   rather than accidental.
2. **How far `hasUnresolvedName` reaches.** It walks the expected type with
   the checker's own `visitTypes`, so it sees array elements, union members,
   object properties and generic arguments. If some type form carries a name
   the walker does not descend into, that name goes unnoticed and the fill is
   checked against a type that cannot fully resolve — which rejects. The
   three acceptance tests cover the shapes I know about; a rejection of an
   ordinary template during implementation is the signal that the walk missed
   a case.
3. **`typeKey(member, {})` in Task 1** passes an empty alias table. Safe
   because synthesized types never contain a named alias reference, but if
   the synthesizer ever learns to produce one, that call needs the real
   table.

**Corrected after the architecture review (round 4).** One design flaw: the
synthesizer widened strings while the checker infers string-literal types, so
`const mode: "fast" | "slow" = #mode` filled with `"fast"` would have been
rejected by fill and accepted by the compile — a false rejection, which the
newly-stated design invariant forbids. Fixed with a literal-accurate second
pass on the failure path only, which keeps the dedupe cost bound and can only
turn a rejection into an acceptance. Verified in both directions: the compile
accepts `"fast"` against the union and rejects `1` against `1 | 2`, so numbers
and booleans must stay widened in both modes. Also added: the three-way
agreement invariant in the doc comments, the guide sentence about imported
types, and Task 5's follow-up issue.

**Corrected after plan review.** Four things in the first draft were wrong.
Task 2's tests asserted message content that only exists after Task 3, and
one nested case asserted content the explainer's own scope could never
produce — all content assertions now live in Task 3, and the explainer
recurses with a path so `address.city` is a message it can actually make. The
explainer compared property types by printed string, which is a second
comparer and mis-blames any aliased property; it now uses `isAssignable` for
the sub-question too. The splice hint fired on legitimate array-typed
splices; it now requires evidence that the element fits one level down. And
the plan had no code for the spec's "unresolvable type is unknowable" rule —
verified that without it, a template importing its types rejects every record
fill.
