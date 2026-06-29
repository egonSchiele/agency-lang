# Nullish Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agency have one nothing-value (`null`) by flipping optionality's type representation from `T | undefined` to `T | null`, absorbing runtime `undefined` into `null` via an `__eq` equality helper, and fixing `schema(T).parse({})` to coalesce missing optional keys to `null`.

**Architecture:** Three coordinated changes. (1) The parser stops producing the `undefined` primitive — `key?: T` desugars to `T | null` and the `undefined` type keyword normalizes to `null` at parse time. (2) Codegen lowers `==`/`!=` to a runtime `__eq(a, b)` helper that treats `null`/`undefined` as one value, so runtime `undefined` from JS interop is caught by `null` checks. (3) The validation/parse Zod mapper makes nullable object keys optional-with-default-null. Strict null checking and null narrowing are explicitly deferred to Project 2.

**Tech Stack:** TypeScript, tarsec parser combinators (`lib/parsers/`), the TsNode IR + builders (`lib/ir/`), Zod codegen (`lib/backends/typescriptGenerator/`), typestache templates (`lib/templates/`), vitest, the Agency execution-test runner.

**Reference docs:**
- Spec: [`docs/superpowers/specs/2026-06-28-nullish-unification-design.md`](../specs/2026-06-28-nullish-unification-design.md)
- Rationale: [`docs/dev/null-and-undefined.md`](../../dev/null-and-undefined.md)

## Global Constraints

- NEVER use dynamic imports.
- Use objects instead of maps; arrays instead of sets; `type` instead of `interface`.
- NEVER force-push or amend commits.
- Only modify `.mustache` template files, never the generated `.ts` — after editing a `.mustache`, run `pnpm run templates` to regenerate.
- Run `make` to build before running Agency execution tests or regenerating fixtures (the CLI runs from `dist/`).
- Agency execution tests run with `pnpm run a test <file>` (NOT `pnpm test:run`). TypeScript/vitest unit tests run with `pnpm test:run <file>`.
- End every commit message with this line (write the message to a file and pass it with `git commit -F`, because apostrophes on the command line break):
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Do not run the full Agency test suite locally (slow/expensive); run only the specific tests named in each task.

## Scope note (deferred — do NOT implement here)

Per the spec's Non-goals: no strict null checking, no null narrowing, no equality-operand type-checking, no `null`-literal-synthesizes-to-`null` change, no `delete`, no `Maybe` type. These belong to Project 2.

---

### Task 1: `__eq` runtime equality helper

**Files:**
- Create: `lib/runtime/eq.ts`
- Modify: `lib/runtime/index.ts` (add export)
- Test: `lib/runtime/eq.test.ts`

**Interfaces:**
- Produces: `export function __eq(a: unknown, b: unknown): boolean` — `true` when both operands are nullish (`null`/`undefined`) or strictly equal; otherwise behaves exactly like `===`.

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/eq.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { __eq } from "./eq.js";

describe("__eq", () => {
  it("treats null and undefined as equal", () => {
    expect(__eq(null, undefined)).toBe(true);
    expect(__eq(undefined, null)).toBe(true);
    expect(__eq(null, null)).toBe(true);
    expect(__eq(undefined, undefined)).toBe(true);
  });

  it("keeps non-nullish values distinct from nullish", () => {
    expect(__eq(0, null)).toBe(false);
    expect(__eq(0, undefined)).toBe(false);
    expect(__eq("", null)).toBe(false);
    expect(__eq(false, null)).toBe(false);
    expect(__eq(5, null)).toBe(false);
  });

  it("matches === for non-nullish values", () => {
    expect(__eq(5, 5)).toBe(true);
    expect(__eq("a", "a")).toBe(true);
    expect(__eq(5, 6)).toBe(false);
    expect(__eq("a", "b")).toBe(false);
    const obj = { x: 1 };
    expect(__eq(obj, obj)).toBe(true);
    expect(__eq({ x: 1 }, { x: 1 })).toBe(false); // reference equality
    expect(__eq(NaN, NaN)).toBe(false); // same as ===
  });

  it("is symmetric for any value against null vs undefined", () => {
    for (const x of [0, "", false, 5, "a", null, undefined, NaN]) {
      expect(__eq(x, null)).toBe(__eq(x, undefined));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/eq.test.ts`
Expected: FAIL — cannot resolve `./eq.js` / `__eq` is not defined.

- [ ] **Step 3: Write minimal implementation**

Create `lib/runtime/eq.ts`:

```ts
/**
 * Equality with unified nullish semantics. `null` and `undefined` are one
 * nothing-value in Agency, so `==`/`!=` lower to this helper instead of
 * strict `===`/`!==`. For two non-nullish values it is identical to `===`;
 * the only difference is that `null` and `undefined` compare equal.
 *
 * `a == null` (loose) is true for exactly `null` and `undefined` (never `0`,
 * `""`, `false`, `NaN`), so `(a == null && b == null)` means "both nullish."
 *
 * See docs/dev/null-and-undefined.md.
 */
export function __eq(a: unknown, b: unknown): boolean {
  return a === b || (a == null && b == null);
}
```

- [ ] **Step 4: Add the runtime export**

In `lib/runtime/index.ts`, add this line near the other helper exports (e.g. after the `export { Schema, __validateType } from "./schema.js";` line):

```ts
export { __eq } from "./eq.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/eq.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/eq.ts lib/runtime/eq.test.ts lib/runtime/index.ts
git commit -F /tmp/commit-eq.txt
```

(Write the message to `/tmp/commit-eq.txt` first, ending with the Co-Authored-By line from Global Constraints.)

---

### Task 2: Lower `==`/`!=` to `__eq` in codegen

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1064-1072` (the equality branch of binop codegen)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache:26-27` (add `__eq` to the runtime import list)
- Regenerate: `lib/templates/backends/typescriptGenerator/imports.ts` (via `pnpm run templates` — do not edit by hand)
- Test: `tests/agency/nullish-eq.agency` + `tests/agency/nullish-eq.test.json`

**Interfaces:**
- Consumes: `__eq` from Task 1 (runtime export) and `ts.call`/`ts.id`/`ts.not` from `lib/ir/builders.ts` (`call(callee, args)`, `id(name)`, `not(condition)`).
- Produces: generated code where Agency `a == b` and `a === b` both emit `__eq(a, b)`, and `a != b` and `a !== b` both emit `!__eq(a, b)`. There is no strict-equality escape hatch (`===`/`!==` are stylistic aliases that compile identically to `==`/`!=`).

- [ ] **Step 1: Write the failing test**

Create `tests/agency/nullish-eq.agency` (an optional key is `null` when absent at runtime; `== null` must catch it, and `==` between a present-null and an absent-key value must be true):

```
node main() {
  let obj: { a?: string } = {}
  let absent = obj.a
  if (absent == null) {
    // `===` must also catch the (runtime-undefined) absent key — no strict
    // escape hatch; both operators unify null and undefined.
    if (absent === null) {
      return "absent is null"
    }
  }
  return "wrong"
}
```

Create `tests/agency/nullish-eq.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"absent is null\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Build and run the test to verify it fails**

Run: `make && pnpm run a test tests/agency/nullish-eq.agency`
Expected: FAIL — today `obj.a` (a missing key) is `undefined` at runtime and `absent == null` compiles to `absent === null`, which is `false`, so the node returns `"wrong"`.

- [ ] **Step 3: Implement the codegen change**

In `lib/backends/typescriptBuilder.ts`, replace the equality branch (currently):

```ts
    const leftNode = this.processNode(node.left);
    const rightNode = this.processNode(node.right);
    // Agency uses strict equality/inequality: == → ===, != → !==
    const emitOp = node.operator === "==" ? "===" :
      node.operator === "!=" ? "!==" : node.operator;
    return ts.binOp(leftNode, emitOp, rightNode, {
      parenLeft: this.needsParensLeft(node.left, node.operator),
      parenRight: this.needsParensRight(node.right, node.operator),
    });
```

with:

```ts
    const leftNode = this.processNode(node.left);
    const rightNode = this.processNode(node.right);
    // All equality operators use unified nullish equality via the `__eq`
    // runtime helper (null and undefined compare equal). There is no strict
    // escape hatch: `===`/`!==` are stylistic aliases that compile identically
    // to `==`/`!=`. See docs/dev/null-and-undefined.md.
    if (
      node.operator === "==" ||
      node.operator === "===" ||
      node.operator === "!=" ||
      node.operator === "!=="
    ) {
      const eq = ts.call(ts.id("__eq"), [leftNode, rightNode]);
      const negated = node.operator === "!=" || node.operator === "!==";
      return negated ? ts.not(eq) : eq;
    }
    return ts.binOp(leftNode, node.operator, rightNode, {
      parenLeft: this.needsParensLeft(node.left, node.operator),
      parenRight: this.needsParensRight(node.right, node.operator),
    });
```

- [ ] **Step 4: Add `__eq` to the generated import list**

In `lib/templates/backends/typescriptGenerator/imports.mustache`, find the line:

```
  Schema, __validateType, __validateChain, __validateChainRecursive,
```

and add `__eq` to the imported names, e.g. change the nearby line:

```
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult,
```

to:

```
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult, __eq,
```

Then regenerate the template output:

Run: `pnpm run templates`
Verify `__eq` now appears in `lib/templates/backends/typescriptGenerator/imports.ts`.

- [ ] **Step 5: Rebuild, regenerate fixtures, run the test**

Run: `make && make fixtures && pnpm run a test tests/agency/nullish-eq.agency`
Expected: PASS — `obj.a` is `undefined`, `__eq(undefined, null)` is `true`.

- [ ] **Step 6: Verify the codegen fixture suite still matches**

Run: `pnpm test:run lib/backends/typescriptBuilder.integration.test.ts`
Expected: PASS (fixtures were regenerated in Step 5 to use `__eq` and the new import).

- [ ] **Step 7: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/templates/backends/typescriptGenerator/imports.mustache lib/templates/backends/typescriptGenerator/imports.ts tests/agency/nullish-eq.agency tests/agency/nullish-eq.test.json tests/typescriptGenerator
git commit -F /tmp/commit-eq-codegen.txt
```

---

### Task 3: Flip `key?: T` desugaring to `T | null`

**Files:**
- Modify: `lib/parsers/parsers.ts:1049-1076` (`objectPropertyParser`, the optional-key branches)
- Test: `lib/parsers/typeHints.test.ts` (add cases to the `objectPropertyParser` describe block, ~line 916)

**Interfaces:**
- Produces: parsing `key?: T` yields `ObjectProperty { key, value: { type: "unionType", types: [T, { type: "primitiveType", value: "null" }] } }`.

- [ ] **Step 1: Write the failing test**

In `lib/parsers/typeHints.test.ts`, inside the `objectPropertyParser` `testCases` array, add these two cases:

```ts
    {
      input: "foo?: string",
      expected: {
        success: true,
        result: {
          key: "foo",
          value: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "null" },
            ],
          },
        },
      },
    },
    {
      input: "bar?: string | number",
      expected: {
        success: true,
        result: {
          key: "bar",
          value: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "number" },
              { type: "primitiveType", value: "null" },
            ],
          },
        },
      },
    },
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/parsers/typeHints.test.ts`
Expected: FAIL — the parser currently appends `{ value: "undefined" }`, not `"null"`.

- [ ] **Step 3: Implement the parser change**

In `lib/parsers/parsers.ts`, in `objectPropertyParser`, change both `undefined` literals to `null`. The union-append branch:

```ts
    if (value.type === "unionType") {
      // If it's already a union, just add null to the list of types
      return success(
        {
          key,
          value: {
            type: "unionType",
            types: [
              ...value.types,
              { type: "primitiveType", value: "null" },
            ],
          },
        },
        result.rest,
      );
    }
```

and the non-union branch:

```ts
    // If it's not a union, create a new union with the original type and null
    return success(
      {
        key,
        value: {
          type: "unionType",
          types: [value, { type: "primitiveType", value: "null" }],
        },
      },
      result.rest,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/parsers/typeHints.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/typeHints.test.ts
git commit -F /tmp/commit-optional-key.txt
```

---

### Task 4: Normalize the `undefined` type keyword to `null` at parse time

**Files:**
- Modify: `lib/parsers/parsers.ts:853-874` (`primitiveTypeParser`)
- Test: `lib/parsers/typeHints.test.ts` (add a case to the `primitiveTypeParser` tests)

**Interfaces:**
- Produces: parsing the type keyword `undefined` yields `{ type: "primitiveType", value: "null" }`. All other primitive keywords are unchanged. The *value* `undefined` is still not parseable (no value-level parser is added).

- [ ] **Step 1: Write the failing test**

In `lib/parsers/typeHints.test.ts`, find the `primitiveTypeParser` describe block and add this test (match the file's existing assertion style; if the block uses a `testCases` array, add an entry, otherwise add an `it`):

```ts
  it("normalizes the `undefined` type keyword to null", () => {
    const result = primitiveTypeParser("undefined");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "primitiveType",
        value: "null",
      });
    }
  });

  it("still parses the `null` type keyword as null", () => {
    const result = primitiveTypeParser("null");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "primitiveType",
        value: "null",
      });
    }
  });
```

Ensure `primitiveTypeParser` is imported at the top of the test file (it is exported from `lib/parsers/parsers.ts`); add it to the existing import from `./parsers.js` if missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/parsers/typeHints.test.ts`
Expected: FAIL — `undefined` currently parses to `{ value: "undefined" }`.

- [ ] **Step 3: Implement the parser change**

In `lib/parsers/parsers.ts`, wrap `primitiveTypeParser` in a `map` that rewrites `undefined` → `null` (the value `undefined` keyword stays in the `or(...)` so it is still *accepted*, just normalized). `map` is already imported (line 30):

```ts
export const primitiveTypeParser: Parser<PrimitiveType> = memo(
  "primitiveTypeParser",
  map(
    seqC(
      set("type", "primitiveType"),
      capture(
        or(
          str("number"),
          str("string"),
          str("boolean"),
          str("undefined"),
          str("void"),
          str("null"),
          str("any"),
          str("unknown"),
          str("object"),
          str("function"),
          str("regex"),
        ),
        "value",
      ),
    ),
    (r: PrimitiveType) => (r.value === "undefined" ? { ...r, value: "null" } : r),
  ),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/parsers/typeHints.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/typeHints.test.ts
git commit -F /tmp/commit-undef-keyword.txt
```

---

### Task 5: Repoint type-checker `UNDEFINED_T` / `"undefined"` sites to `null`

**Files:**
- Modify: `lib/typeChecker/primitives.ts:8` (add `NULL_T`, remove `UNDEFINED_T`)
- Modify: `lib/typeChecker/synthesizer.ts:26,866` (import + `elementOrUndef` return)
- Modify: `lib/typeChecker/builtins.ts:8,17` (the `optional` helper)
- Modify: `lib/typeChecker/primitiveMembers.ts:113,154,160` (built-in member return unions)
- Modify: `lib/typeChecker/assignability.ts:403` (`isOptionalType`)
- Test: `lib/typeChecker/assignability.test.ts` (or create `lib/typeChecker/nullish.test.ts`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const NULL_T: VariableType = { type: "primitiveType", value: "null" }`. `isOptionalType` returns `true` for a `null` member. Built-in members that returned `T | undefined` now return `T | null`. `UNDEFINED_T` no longer exists.

- [ ] **Step 1: Write the failing test**

Create `lib/typeChecker/nullish.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAssignable } from "./assignability.js";
import { NULL_T } from "./primitives.js";

describe("nullish unification in the type checker", () => {
  const STRING_T = { type: "primitiveType", value: "string" } as const;

  it("NULL_T is the null primitive", () => {
    expect(NULL_T).toEqual({ type: "primitiveType", value: "null" });
  });

  it("null is assignable to string | null", () => {
    const target = { type: "unionType", types: [STRING_T, NULL_T] } as const;
    expect(isAssignable(NULL_T, target, {})).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/typeChecker/nullish.test.ts`
Expected: FAIL — `NULL_T` is not exported from `./primitives.js`.

- [ ] **Step 3: Add `NULL_T` and remove `UNDEFINED_T`**

In `lib/typeChecker/primitives.ts`, replace:

```ts
export const UNDEFINED_T: VariableType = { type: "primitiveType", value: "undefined" };
```

with:

```ts
export const NULL_T: VariableType = { type: "primitiveType", value: "null" };
```

- [ ] **Step 4: Repoint `synthesizer.ts`**

In `lib/typeChecker/synthesizer.ts:26`, change the import `import { UNDEFINED_T, VOID_T } from "./primitives.js";` to `import { NULL_T, VOID_T } from "./primitives.js";`. At line 866, change:

```ts
  if (cbKind === "elementOrUndef") {
    return { type: "unionType", types: [elementT, NULL_T] };
  }
```

(Leave the `isNullishPrimitive` helper at line ~313-316 untouched — it already accepts both `"null"` and `"undefined"` and serves as a defensive backstop.)

- [ ] **Step 5: Repoint `builtins.ts`**

In `lib/typeChecker/builtins.ts`, change the import alias `UNDEFINED_T as undef` to `NULL_T as nullT`, and update the `optional` helper:

```ts
const optional = (t: VariableType): VariableType => ({
  type: "unionType",
  types: [t, nullT],
});
```

(Update any other use of `undef` in this file to `nullT`.)

- [ ] **Step 6: Repoint `primitiveMembers.ts`**

In `lib/typeChecker/primitiveMembers.ts`, at lines 113, 154, and 160, change each `{ type: "primitiveType", value: "undefined" }` to `{ type: "primitiveType", value: "null" }`.

- [ ] **Step 7: Repoint `isOptionalType`**

In `lib/typeChecker/assignability.ts:403`, change:

```ts
    return resolved.value === "null" || resolved.value === "any";
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm test:run lib/typeChecker/nullish.test.ts lib/typeChecker/assignability.test.ts`
Expected: PASS. If `assignability.test.ts` has cases asserting `undefined`-based optionality, update them to `null`.

- [ ] **Step 9: Typecheck the package to catch stragglers**

Run: `pnpm test:run` is too broad; instead build to surface any remaining `UNDEFINED_T` references:
Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "UNDEFINED_T\|undef" || echo "no stragglers"`
Expected: `no stragglers`. Fix any remaining references (repoint to `NULL_T`).

- [ ] **Step 10: Commit**

```bash
git add lib/typeChecker/primitives.ts lib/typeChecker/synthesizer.ts lib/typeChecker/builtins.ts lib/typeChecker/primitiveMembers.ts lib/typeChecker/assignability.ts lib/typeChecker/nullish.test.ts lib/typeChecker/assignability.test.ts
git commit -F /tmp/commit-repoint.txt
```

---

### Task 6: Type optional parameters as `T | null`

**Files:**
- Modify: `lib/parsers/parsers.ts:4136-4174` (`functionParameterParser`, the optional handling)
- Modify: `lib/backends/typescriptBuilder.ts:1525-1534` (`paramSchemaContribution`, avoid a redundant `.nullable()`)
- Test: `lib/parsers/function.test.ts` (parser) and `lib/backends/toolSchemaContribution.test.ts` (schema)

**Interfaces:**
- Consumes: the optional-parameter desugaring already injects `defaultValue = { type: "null" }` for `x?: T` with no explicit default.
- Produces: an optional parameter `x?: T` has `typeHint` widened to `{ type: "unionType", types: [T, { type:"primitiveType", value:"null" }] }`. Its tool schema is `z.union([<T>, z.null()])` (no double `.nullable()`).

- [ ] **Step 1: Write the failing test**

In `lib/parsers/function.test.ts`, add a test asserting an optional typed parameter widens its `typeHint` (match the file's existing parse-assertion helper; this shows the shape to assert):

```ts
it("widens an optional parameter's type hint to T | null", () => {
  const result = functionParameterParser("x?: number");
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.result.typeHint).toEqualWithoutLoc({
      type: "unionType",
      types: [
        { type: "primitiveType", value: "number" },
        { type: "primitiveType", value: "null" },
      ],
    });
    // default value still injected so the runtime resolves an omitted arg to null
    expect(result.result.defaultValue).toEqualWithoutLoc({ type: "null" });
  }
});
```

Ensure `functionParameterParser` is imported from `./parsers.js` in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/parsers/function.test.ts`
Expected: FAIL — `typeHint` is currently the bare `number`, not a union with `null`.

- [ ] **Step 3: Implement the parser change**

In `lib/parsers/parsers.ts`, in the `functionParameterParser` `map` callback (the `(result: any) => { ... }` at ~line 4165), replace the body so that an optional parameter both injects the null default *and* widens the type hint:

```ts
    (result: any) => {
      const { __optional, validated: _validated, ...rest } = result;
      if (__optional) {
        if (!rest.defaultValue) {
          rest.defaultValue = { type: "null" };
        }
        if (rest.typeHint) {
          const nullT = { type: "primitiveType", value: "null" };
          rest.typeHint =
            rest.typeHint.type === "unionType"
              ? { type: "unionType", types: [...rest.typeHint.types, nullT] }
              : { type: "unionType", types: [rest.typeHint, nullT] };
        }
      }
      if (_validated) rest.validated = true;
      return rest as FunctionParameter;
    },
```

- [ ] **Step 4: Avoid a redundant `.nullable()` in the tool schema**

In `lib/backends/typescriptBuilder.ts`, in `paramSchemaContribution`, replace the scalar tail (currently):

```ts
    let zod = this.zodSchemaFor(typeHint);
    if (param.defaultValue) {
      const defaultStr = expressionToString(param.defaultValue);
      zod += `.nullable().describe(${JSON.stringify("Default: " + defaultStr)})`;
    }
    return { kind: "scalar", zod };
```

with:

```ts
    let zod = this.zodSchemaFor(typeHint);
    if (param.defaultValue) {
      const defaultStr = expressionToString(param.defaultValue);
      // A widened optional param (`x?: T` → `T | null`) is already nullable;
      // only add `.nullable()` for params whose type is not already nullable
      // (e.g. an explicit default `x: T = 5`), so the LLM may omit them.
      const alreadyNullable =
        typeHint.type === "unionType" &&
        typeHint.types.some(
          (t) => t.type === "primitiveType" && t.value === "null",
        );
      if (!alreadyNullable) zod += ".nullable()";
      zod += `.describe(${JSON.stringify("Default: " + defaultStr)})`;
    }
    return { kind: "scalar", zod };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run lib/parsers/function.test.ts lib/backends/toolSchemaContribution.test.ts`
Expected: PASS. If `toolSchemaContribution.test.ts` asserts the old `z.X().nullable()` shape for an optional param, update it to the new `z.union([z.X(), z.null()])` shape.

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/function.test.ts lib/backends/typescriptBuilder.ts lib/backends/toolSchemaContribution.test.ts
git commit -F /tmp/commit-optional-param.txt
```

---

### Task 7: Formatter emits `key?:` for `T | null` properties

**Files:**
- Modify: `lib/backends/agencyGenerator.ts:625-645` (`stringifyProp`)
- Test: `lib/backends/agencyGenerator.test.ts`

**Interfaces:**
- Produces: the Agency formatter renders an object property whose type is `T | null` back as `key?: T` (round-trip), instead of `key: T | null`.

- [ ] **Step 1: Write the failing test**

In `lib/backends/agencyGenerator.test.ts`, add a round-trip test (match the file's existing format/parse helpers; conceptually):

```ts
it("round-trips an optional key as key?: T", () => {
  const src = "type Foo = { foo?: string }";
  const formatted = formatAgency(src); // use the file's existing format helper
  expect(formatted).toContain("foo?: string");
  expect(formatted).not.toContain("foo: string | null");
});
```

If the test file has no `formatAgency` helper, follow the existing pattern in that file for parsing then running `AgencyGenerator` and asserting on the output string.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/backends/agencyGenerator.test.ts`
Expected: FAIL — `stringifyProp` currently detects a `undefined` member for the `?:` shorthand, so a `T | null` property is printed as `foo: string | null`.

- [ ] **Step 3: Implement the formatter change**

In `lib/backends/agencyGenerator.ts`, in `stringifyProp`, change the detection (and the filter) from `"undefined"` to `"null"`:

```ts
  private stringifyProp(prop: ObjectProperty): string {
    const isUnionWithNull =
      prop.value.type === "unionType" &&
      prop.value.types.some(
        (t) => t.type === "primitiveType" && t.value === "null",
      );

    if (isUnionWithNull) {
      const nonNullTypes = (prop.value as any).types.filter(
        (t: VariableType) =>
          !(t.type === "primitiveType" && t.value === "null"),
      );
      const unionWithoutNull: VariableType =
        nonNullTypes.length === 1
          ? nonNullTypes[0]
          : { type: "unionType", types: nonNullTypes };
```

(Continue using `unionWithoutNull` wherever the old code used `unionWithoutUndefined` further down in the method — rename the remaining references in this method consistently.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/backends/agencyGenerator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts
git commit -F /tmp/commit-formatter.txt
```

---

### Task 8: `schema(T).parse(...)` coalesces missing optional keys to `null`

**Files:**
- Modify: `lib/backends/typescriptGenerator/typeToZodSchema.ts` (`mapTypeToSchema` / `mapTypeToSchemaInner` / the two public mappers — thread an optional-key mode)
- Test: `tests/agency/validation/optionalKeyCoalesce.agency` + `.test.json`, plus nested/already-nullable variants

**Interfaces:**
- Consumes: optional object keys are now `T | null` unions (Task 3).
- Produces: `mapTypeToValidationSchema` emits, for an object property whose type includes a `null` member, a Zod schema that accepts a *missing* key and coalesces it to `null` (`<schema>.optional().default(null)`). `mapTypeToZodSchema` (the LLM path) is unchanged — keys stay required + nullable.

- [ ] **Step 1: Write the failing test**

Create `tests/agency/validation/optionalKeyCoalesce.agency`:

```
node main() {
  const s = schema({ foo?: string })
  const r = s.parse({})
  if (isSuccess(r)) {
    if (r.value.foo == null) {
      return "coalesced to null"
    }
    return "present but not null"
  }
  return "parse failed"
}
```

Create `tests/agency/validation/optionalKeyCoalesce.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"coalesced to null\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "schema({foo?: string}).parse({}) yields { foo: null }"
    }
  ]
}
```

- [ ] **Step 2: Build and run the test to verify it fails**

Run: `make && pnpm run a test tests/agency/validation/optionalKeyCoalesce.agency`
Expected: FAIL — today the optional key compiles to `z.union([z.string(), z.null()])` with the key required, so `parse({})` returns a `failure` (missing key) and the node returns `"parse failed"`.

- [ ] **Step 3: Thread an optional-key mode through the schema mapper**

In `lib/backends/typescriptGenerator/typeToZodSchema.ts`, add a mode parameter that distinguishes the LLM mapper from the validation mapper, and apply the coalescing only in validation mode.

Add a type alias near the top of the file:

```ts
type OptionalKeyMode = "required-nullable" | "optional-coalesce";
```

Thread `optionalKeyMode` through `mapTypeToSchema`, `mapTypeToSchemaInner`, and `recurse`/`mapTypeToSchemaInner` recursive calls (default it to `"required-nullable"` so existing internal calls are unaffected). In the `objectType` branch, after computing `inner2` and `appendMeta(...)` for each property, wrap nullable properties when in coalesce mode. Replace the property `.map(...)` body's final assembly:

```ts
        const propSchema = appendMeta(inner2, mergedTags);
        const isNullableProp =
          prop.value.type === "unionType" &&
          prop.value.types.some(
            (t) => t.type === "primitiveType" && t.value === "null",
          );
        const finalProp =
          optionalKeyMode === "optional-coalesce" && isNullableProp
            ? `${propSchema}.optional().default(null)`
            : propSchema;
        const str = `"${prop.key.replace(/"/g, '\\"')}": ${finalProp}`;
        return str;
```

Update the two public mappers to pass the mode:

```ts
export function mapTypeToZodSchema(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  typeAliasesFull?: Record<string, TypeAliasEntry>,
): string {
  return mapTypeToSchema(
    variableType,
    typeAliases,
    (vt, ta) => mapTypeToZodSchema((vt as any).successType, ta, typeAliasesFull),
    typeAliasesFull,
    "required-nullable",
  );
}

export function mapTypeToValidationSchema(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  typeAliasesFull?: Record<string, TypeAliasEntry>,
): string {
  return mapTypeToSchema(
    variableType,
    typeAliases,
    (vt, ta) => {
      const successSchema = mapTypeToValidationSchema(
        (vt as any).successType,
        ta,
        typeAliasesFull,
      );
      return `z.union([z.object({ __type: z.literal("resultType"), success: z.literal(true), value: ${successSchema} }), z.object({ __type: z.literal("resultType"), success: z.literal(false), error: z.any() })])`;
    },
    typeAliasesFull,
    "optional-coalesce",
  );
}
```

Update `mapTypeToSchema` and `mapTypeToSchemaInner` signatures to accept and forward `optionalKeyMode: OptionalKeyMode` (thread it into every recursive `mapTypeToSchemaInner` / `recurse` call inside the function so nested objects coalesce too).

- [ ] **Step 4: Rebuild and run the test to verify it passes**

Run: `make && pnpm run a test tests/agency/validation/optionalKeyCoalesce.agency`
Expected: PASS.

- [ ] **Step 5: Add nested and already-nullable variants**

Create `tests/agency/validation/optionalKeyNested.agency`:

```
node main() {
  const s = schema({ a?: { b?: string } })
  const r = s.parse({})
  if (isSuccess(r)) {
    if (r.value.a == null) {
      return "outer coalesced"
    }
    return "outer present"
  }
  return "parse failed"
}
```

Create `tests/agency/validation/optionalKeyNested.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"outer coalesced\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "missing outer optional object coalesces to null (no recursion into b)"
    }
  ]
}
```

Run: `pnpm run a test tests/agency/validation/optionalKeyNested.agency`
Expected: PASS.

- [ ] **Step 6: Confirm the LLM mapper path is unchanged**

Run: `pnpm test:run lib/backends/toolSchemaContribution.test.ts`
Expected: PASS — LLM tool schemas still emit required + nullable keys (no `.optional().default(null)`).

- [ ] **Step 7: Commit**

```bash
git add lib/backends/typescriptGenerator/typeToZodSchema.ts tests/agency/validation/optionalKeyCoalesce.agency tests/agency/validation/optionalKeyCoalesce.test.json tests/agency/validation/optionalKeyNested.agency tests/agency/validation/optionalKeyNested.test.json
git commit -F /tmp/commit-schema-coalesce.txt
```

---

### Task 9: Final sweep — fixtures, fixture-source repoint, spec retarget, targeted suites

**Files:**
- Regenerate: `tests/typescriptGenerator/**` (via `make fixtures`)
- Modify: any `.agency`/`.test.ts` fixtures or tests asserting `| undefined` types (repoint to `| null`)
- Modify: `null-truthiness-narrowing-spec.md` at the repo root (retarget note)

**Interfaces:** none (cleanup + verification).

- [ ] **Step 1: Rebuild and regenerate all fixtures**

Run: `make && make fixtures`
Expected: completes; `git status` shows regenerated fixtures under `tests/typescriptGenerator/`.

- [ ] **Step 2: Find lingering `| undefined` type references in tests/fixtures**

Run: `grep -rn "value: \"undefined\"\|| undefined\|: undefined\b" tests/ lib/ --include="*.ts" --include="*.agency" | grep -v "typeof.*undefined\|!== undefined\|=== undefined\|== \"undefined\"\|!= undefined" | grep -vi "errors.ts\|asyncContext.ts"`
Expected: review each hit. Repoint *type-level* `undefined` (optionality) to `null`; leave *runtime* `undefined` JS-guard checks (`typeof x !== "undefined"`, `x === undefined` in TS source) alone.

- [ ] **Step 3: Retarget the null-truthiness narrowing spec note**

In `null-truthiness-narrowing-spec.md` (repo root), update the "Summary" and "Background" so optionality is described as `T | null` (not `T | undefined`) and `isOptionalType`/the member-filter key on the `null` primitive. Add a one-line note: "Representation flipped to `null` by the nullish-unification project (`packages/agency-lang/docs/superpowers/specs/2026-06-28-nullish-unification-design.md`)."

- [ ] **Step 4: Run the affected unit suites**

Run: `pnpm test:run lib/parsers/typeHints.test.ts lib/parsers/function.test.ts lib/typeChecker/nullish.test.ts lib/typeChecker/assignability.test.ts lib/backends/agencyGenerator.test.ts lib/backends/toolSchemaContribution.test.ts lib/backends/typescriptBuilder.integration.test.ts lib/runtime/eq.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run the affected Agency execution tests**

Run: `pnpm run a test tests/agency/nullish-eq.agency && pnpm run a test tests/agency/validation/optionalKeyCoalesce.agency && pnpm run a test tests/agency/validation/optionalKeyNested.agency && pnpm run a test tests/agency/validation/schemaBuiltin.agency`
Expected: all PASS (the last confirms the existing schema path still works).

- [ ] **Step 6: Commit**

```bash
git add tests/typescriptGenerator ../../null-truthiness-narrowing-spec.md tests lib
git commit -F /tmp/commit-final-sweep.txt
```

(Adjust the `git add` for the spec to its actual repo-root relative path from the package dir; verify with `git status` before committing.)

---

## Self-Review

**Spec coverage:**
- §1 representation flip → Tasks 3 (key?:), 4 (undefined keyword), 5 (UNDEFINED_T/isOptionalType), 6 (optional params). ✓
- §2 `__eq` → Tasks 1 (helper) + 2 (codegen + import wiring). ✓
- §3 schema parse coalescing → Task 8 (with nested + LLM-unchanged checks). ✓
- §4 TS interop → covered transitively: user-written `undefined` type annotations normalize via Task 4 (the parser is the single ingestion point for type keywords); runtime interop `undefined` is caught by `__eq` (Task 2). No separate `.d.ts` import path exists in the codebase, so no additional task is needed. ✓
- §5 migration/fixture sweep + spec retarget → Task 9. ✓
- §6 flow-checker coordination → no code in P1; the narrowing-recognizer-unaffected and `null`-literal-stays-`any` points are honored by *not* changing `analyzeCondition` or the `null` literal synth (kept in Non-goals). ✓
- Testing section (basic/nested/already-nullable parse, `__eq` truth table, optional param → null, `??`) → Tasks 1, 6, 8. Note: the "already-nullable optional key" and `??` cases are covered by the `__eq`/coalesce logic; an explicit `??` test is optional and omitted to avoid redundancy with the existing `synthNullishCoalesce` behavior (unchanged by this project).

**Placeholder scan:** No TBD/TODO; every code step shows real code; every command shows expected output. ✓

**Type consistency:** `__eq(a: unknown, b: unknown): boolean` used identically in Tasks 1–2. `NULL_T` defined in Task 5, consumed in Task 5 tests. `OptionalKeyMode` defined and threaded in Task 8. Optional-key union shape `{ type:"unionType", types:[T, {primitiveType,"null"}] }` consistent across Tasks 3, 6, 7, 8. ✓

**One judgment call surfaced for the user:** Task 6 (optional-parameter type widening) is the fiddliest piece — it changes optional-param tool-schema output and may require updating `toolSchemaContribution.test.ts` assertions. It is included to honor spec §1, but could be deferred to Project 2 (the param *value* is already `null`; only the static type precision is at stake). Flag for the user if they prefer a smaller first PR.
