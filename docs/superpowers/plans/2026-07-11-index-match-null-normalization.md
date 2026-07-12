# Index/Match `undefined`→`null` Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make missing object-key lookups (`obj[key]`), out-of-bounds array indexing (`arr[i]`), and unmatched `match` expressions yield `null` instead of `undefined`, completing the value-side of Agency's "one nothing-value" invariant.

**Architecture:** Add a tiny `__nn(x) => x ?? null` runtime helper, wired exactly like the existing `__eq` helper. Emit `__nn(...)` around two codegen sites in `typescriptBuilder.ts`: the index access chain element, and the `__matchval_<id>` read that consumes a match result. No type-checker changes — this is a runtime-value fix only.

**Tech Stack:** TypeScript (compiler + runtime), typestache templates (`pnpm run templates`), vitest (unit + integration tests), Agency execution tests under `tests/agency-js/`.

**Spec:** `docs/superpowers/specs/2026-07-11-index-match-null-normalization-design.md`
**Issue:** https://github.com/egonSchiele/agency-lang/issues/409

## Global Constraints

- All paths below are relative to `packages/agency-lang/` unless absolute.
- **Never edit generated `.ts` templates.** `lib/templates/.../imports.ts` is auto-generated from `imports.mustache`; edit the `.mustache` and run `pnpm run templates`.
- **Rebuild with `make`, not `pnpm run build`** before running Agency/agency-js tests (`pnpm run build` does not copy everything into `dist`).
- **No dynamic imports. Use `type` not `interface`. Use arrays not sets, objects not maps.**
- **Agency syntax:** `def foo(x: T): R { ... }`, `node main() { ... }`, `if (cond) { ... }`, declare with `let`/`const`. Verify snippets against `docs/site/guide/basic-syntax.md`.
- **Do not run the full agency test suite locally** (slow/expensive). Run only the specific new agency-js tests named in this plan, and save output to a file.
- Work happens on branch `undefined-to-null-indexing` (already created). Do not commit to `main`.

---

### Task 1: `__nn` runtime helper + wiring

Add the nullish-normalize helper and make it importable in generated code. Self-contained and unit-testable before any codegen touches it.

**Files:**
- Create: `lib/runtime/nn.ts`
- Create: `lib/runtime/nn.test.ts`
- Modify: `lib/runtime/index.ts:151` (add export beside `__eq`)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache:25` (add `__nn` to the import list)

**Interfaces:**
- Produces: `export function __nn<T>(x: T): T | null` — returns `null` for `null`/`undefined`, `x` unchanged otherwise. Later tasks emit it as `ts.call(ts.id("__nn"), [expr])`.

- [ ] **Step 1: Write the failing unit test**

Create `lib/runtime/nn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { __nn } from "./nn.js";

describe("__nn", () => {
  it("collapses undefined and null to null", () => {
    expect(__nn(undefined)).toBe(null);
    expect(__nn(null)).toBe(null);
  });

  it("passes non-nullish values through unchanged, including falsy ones", () => {
    expect(__nn(0)).toBe(0);
    expect(__nn("")).toBe("");
    expect(__nn(false)).toBe(false);
    expect(__nn(5)).toBe(5);
    expect(__nn("a")).toBe("a");
    expect(Number.isNaN(__nn(NaN))).toBe(true);
  });

  it("returns the same object reference for objects", () => {
    const obj = { x: 1 };
    expect(__nn(obj)).toBe(obj);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/runtime/nn.test.ts 2>&1 | tee /tmp/nn-test.log`
Expected: FAIL — cannot resolve `./nn.js` (module does not exist yet).

- [ ] **Step 3: Create the helper**

Create `lib/runtime/nn.ts`:

```ts
/**
 * Nullish-normalize: collapse `undefined` into Agency's single nothing-value,
 * `null`. Wraps the value sites where the JS runtime produces `undefined`
 * (missing object key, out-of-bounds index, unmatched `match`) so the
 * "only null exists" invariant holds at the value level, not just at `__eq`.
 *
 * `x ?? null` returns `null` for `null`/`undefined` and `x` unchanged for every
 * other value (including `0`, `""`, `false`, `NaN`). The operand is evaluated
 * exactly once, so wrapping a side-effecting expression is safe.
 *
 * See docs/dev/null-and-undefined.md.
 */
export function __nn<T>(x: T): T | null {
  return x ?? null;
}
```

- [ ] **Step 4: Export it from the runtime barrel**

In `lib/runtime/index.ts`, directly below the existing `export { __eq } from "./eq.js";` (line 151), add:

```ts
export { __nn } from "./nn.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/runtime/nn.test.ts 2>&1 | tee /tmp/nn-test.log`
Expected: PASS (3 tests).

- [ ] **Step 6: Add `__nn` to the generated-code import list**

In `lib/templates/backends/typescriptGenerator/imports.mustache`, line 25 currently reads:

```
  success, failure, isSuccess, isFailure, stampFailureBoundary, markDestructiveWork, __pipeBind, __tryCall, __catchResult, __eq,
```

Change the trailing `__eq,` to `__eq, __nn,`:

```
  success, failure, isSuccess, isFailure, stampFailureBoundary, markDestructiveWork, __pipeBind, __tryCall, __catchResult, __eq, __nn,
```

- [ ] **Step 7: Regenerate the template and rebuild**

Run: `pnpm run templates && make 2>&1 | tail -20 | tee /tmp/build.log`
Then verify `__nn` landed in the generated import list:
Run: `grep -n "__nn" lib/templates/backends/typescriptGenerator/imports.ts`
Expected: one match, showing `__nn` in the destructured import from `agency-lang/runtime`.

- [ ] **Step 8: Commit**

```bash
git add lib/runtime/nn.ts lib/runtime/nn.test.ts lib/runtime/index.ts \
  lib/templates/backends/typescriptGenerator/imports.mustache \
  lib/templates/backends/typescriptGenerator/imports.ts
git commit -m "Add __nn nullish-normalize runtime helper (#409)"
```

---

### Task 2: Coerce index reads to `null`

Wrap the index access-chain codegen in `__nn(...)` so both `obj[key]` (missing key) and `arr[i]` (out of bounds) yield `null`.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1107` (the `case "index":` in `processValueAccess`)
- Create: `tests/agency-js/index-missing-key-null/agent.agency`
- Create: `tests/agency-js/index-missing-key-null/test.js`
- Create: `tests/agency-js/index-missing-key-null/fixture.json`

**Interfaces:**
- Consumes: `__nn` from Task 1, emitted as `ts.call(ts.id("__nn"), [ ... ])`.

- [ ] **Step 1: Write the failing execution test**

Create `tests/agency-js/index-missing-key-null/agent.agency`:

```
node lookups() {
  const obj: Record<string, number> = { present: 42 }
  const arr = [1, 2, 3]
  const zero: Record<string, number> = { z: 0 }
  return {
    missingKey: obj["absent"],
    presentKey: obj["present"],
    outOfBounds: arr[10],
    inBounds: arr[0],
    falsyZero: zero["z"]
  }
}
```

Create `tests/agency-js/index-missing-key-null/test.js`:

```js
import { lookups } from "./agent.js";
import { writeFileSync } from "fs";

const r = (await lookups()).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      missingKeyIsNull: r.missingKey === null,
      outOfBoundsIsNull: r.outOfBounds === null,
      presentKeyValue: r.presentKey,
      inBoundsValue: r.inBounds,
      falsyZeroPreserved: r.falsyZero === 0,
    },
    null,
    2,
  ),
);
```

Create `tests/agency-js/index-missing-key-null/fixture.json`:

```json
{
  "missingKeyIsNull": true,
  "outOfBoundsIsNull": true,
  "presentKeyValue": 42,
  "inBoundsValue": 1,
  "falsyZeroPreserved": true
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/index-missing-key-null 2>&1 | tee /tmp/index-test.log`
Expected: FAIL — `missingKeyIsNull` and `outOfBoundsIsNull` come back `false` (the raw value is `undefined`, and `undefined === null` is `false`), so `__result.json` differs from `fixture.json`.

- [ ] **Step 3: Wrap the index codegen in `__nn`**

In `lib/backends/typescriptBuilder.ts`, `processValueAccess`, the `case "index":` (line ~1107) currently reads:

```ts
        case "index":
          result = ts.index(result, this.processNode(element.index), {
            optional: element.optional,
          });
          break;
```

Change it to wrap the built index node in `__nn`:

```ts
        case "index":
          result = ts.call(ts.id("__nn"), [
            ts.index(result, this.processNode(element.index), {
              optional: element.optional,
            }),
          ]);
          break;
```

Leave the assignment-LHS index emitter (`lib/backends/typescriptBuilder/assignmentEmitter.ts:104`) untouched — it is a write target, not a value read.

- [ ] **Step 4: Rebuild the compiler**

Run: `make 2>&1 | tail -20 | tee /tmp/build.log`
Expected: build succeeds.

- [ ] **Step 5: Run the execution test to verify it passes**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/index-missing-key-null 2>&1 | tee /tmp/index-test.log`
Expected: PASS — `__result.json` matches `fixture.json` (all booleans `true`, values `42`/`1`).

- [ ] **Step 6: Regenerate integration fixtures and review the diff**

Run: `make fixtures 2>&1 | tail -20`
Run: `git status --short tests/typescriptGenerator/ && git diff tests/typescriptGenerator/ | head -80`
Expected: `.mjs` fixtures that use indexing now show index expressions wrapped as `__nn(...)`. Confirm the ONLY change is added `__nn(...)` wrappers around index/subscript expressions — no unrelated churn.

- [ ] **Step 7: Run the codegen integration tests**

Run: `pnpm exec vitest run lib/backends/typescriptGenerator.integration.test.ts lib/backends/typescriptBuilder.integration.test.ts 2>&1 | tee /tmp/integration.log`
Expected: PASS (fixtures now match the new codegen).

- [ ] **Step 8: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/agency-js/index-missing-key-null tests/typescriptGenerator
git commit -m "Coerce index reads to null via __nn (#409)"
```

---

### Task 3: Coerce `match` results to `null`

Coerce the single `__matchval_<id>` read chokepoint so every unmatched-`match` path yields `null`, and make a valueless `yield` emit `null` at the source.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1024` (the `isMatchValName` read branch)
- Modify: `lib/backends/typescriptBuilder.ts:1520` (valueless-`yield` fallback)
- Create: `tests/agency-js/match-no-arm-null/agent.agency`
- Create: `tests/agency-js/match-no-arm-null/test.js`
- Create: `tests/agency-js/match-no-arm-null/fixture.json`

**Interfaces:**
- Consumes: `__nn` from Task 1.

- [ ] **Step 1: Write the failing execution test**

The design relies on the fact (confirmed in `lib/typeChecker/matchExhaustiveness.ts`, `missingCases`) that a `match` over an **open** type like `string` is never required to be exhaustive, so this compiles cleanly at the default `matchExhaustiveness: "error"` — no config override needed. At runtime the unmatched scrutinee falls through and (pre-fix) yields `undefined`.

Create `tests/agency-js/match-no-arm-null/agent.agency`:

```
node classify(s: string) {
  const result = match (s) {
    "a" => "got-a"
    "b" => "got-b"
  }
  return result
}
```

Create `tests/agency-js/match-no-arm-null/test.js`:

```js
import { classify } from "./agent.js";
import { writeFileSync } from "fs";

const matched = (await classify("a")).data;
const unmatched = (await classify("z")).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      matchedValue: matched,
      unmatchedIsNull: unmatched === null,
    },
    null,
    2,
  ),
);
```

Create `tests/agency-js/match-no-arm-null/fixture.json`:

```json
{
  "matchedValue": "got-a",
  "unmatchedIsNull": true
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/match-no-arm-null 2>&1 | tee /tmp/match-test.log`
Expected: FAIL — `unmatchedIsNull` comes back `false` (the match result is `undefined`).

- [ ] **Step 3: Coerce the match-result read**

In `lib/backends/typescriptBuilder.ts`, the `isMatchValName` branch (line ~1024) currently reads:

```ts
          if (!isBuiltinVar && !isLoopVar && isMatchValName(literal.value)) {
            return ts.scopedVar(literal.value, "local", this.moduleId);
          }
```

Wrap the resolved read in `__nn`:

```ts
          if (!isBuiltinVar && !isLoopVar && isMatchValName(literal.value)) {
            return ts.call(ts.id("__nn"), [
              ts.scopedVar(literal.value, "local", this.moduleId),
            ]);
          }
```

- [ ] **Step 4: Make a valueless `yield` emit `null` at the source**

In `lib/backends/typescriptBuilder.ts`, `processMatchYield` (line ~1520) currently reads:

```ts
    const value = node.value
      ? this.processNode(node.value)
      : ts.id("undefined");
```

Change the fallback from `undefined` to `null`:

```ts
    const value = node.value
      ? this.processNode(node.value)
      : ts.id("null");
```

- [ ] **Step 5: Rebuild the compiler**

Run: `make 2>&1 | tail -20 | tee /tmp/build.log`
Expected: build succeeds.

- [ ] **Step 6: Run the execution test to verify it passes**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/match-no-arm-null 2>&1 | tee /tmp/match-test.log`
Expected: PASS — `matchedValue` is `"got-a"`, `unmatchedIsNull` is `true`.

- [ ] **Step 7: Regenerate integration fixtures and review the diff**

Run: `make fixtures 2>&1 | tail -20`
Run: `git diff tests/typescriptGenerator/ | head -80`
Expected: `.mjs` fixtures that read a match-expression result (e.g. `matchExpression.mjs`, `matchBlock.mjs`) now show the `__matchval_<id>` read wrapped as `__nn(...)`, and any valueless-yield fallback now emits `null`. Confirm no unrelated churn.

- [ ] **Step 8: Run the codegen integration tests**

Run: `pnpm exec vitest run lib/backends/typescriptGenerator.integration.test.ts lib/backends/typescriptBuilder.integration.test.ts 2>&1 | tee /tmp/integration.log`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/agency-js/match-no-arm-null tests/typescriptGenerator
git commit -m "Coerce match results to null via __nn (#409)"
```

---

### Task 4: Update documentation

Record that index and match value sites are now normalized, so the "known and unfixed" leak list in the design doc no longer misstates the behavior.

**Files:**
- Modify: `docs/dev/null-and-undefined.md`

- [ ] **Step 1: Update the leak-list note**

In `docs/dev/null-and-undefined.md`, in the section "The key fact that constrains the design" (the bulleted list around lines 108-113 that begins "a missing object key reads as `undefined`"), add a sentence after the list noting that Agency now normalizes these two sites at the value level:

```markdown
As of the index/match normalization work (issue #409), the two most common of
these — a missing object key / out-of-bounds index (`obj[key]`, `arr[i]`) and an
unmatched `match` expression — are wrapped in the `__nn` runtime helper
(`x ?? null`), so they yield `null` rather than `undefined` as an observable
value. The remaining leak sites (optional chaining, destructuring a missing
field, falling off a function without `return`, and TypeScript interop) are not
yet normalized and are tracked as follow-ups.
```

- [ ] **Step 2: Note the value-side completion in the equality section**

In the same doc, in the "Relationship to null safety" section, verify the text does not claim `undefined` is fully absorbed everywhere; if it overstates, adjust to reference `__nn` covering index/match value sites in addition to `__eq` covering comparisons. (If the existing wording is already accurate, leave it — no edit required.)

- [ ] **Step 3: Commit**

```bash
git add docs/dev/null-and-undefined.md
git commit -m "Document index/match null normalization (#409)"
```

---

## Self-Review

**Spec coverage:**
- `__nn` helper + wiring → Task 1. ✅
- Fix 1, index reads (issue #1 object missing key + #2 array OOB, shared site) → Task 2. ✅
- Fix 2, match no-arm (all three paths via the read chokepoint) + valueless-yield source → Task 3. ✅
- Non-goal: no type-checker change → no task touches `lib/typeChecker/`. ✅
- Non-goal: match-comparison `===` unchanged → not touched. ✅
- Testing: falsy-passthrough guard (`0`/`""`/`false`/`NaN`) in Task 1 unit test + `falsyZero`/`presentKey` in Task 2; `=== null` JS observation (not `==`, which `__eq` blinds) in Tasks 2-3; matched-arm-still-returns-value in Task 3. ✅
- Docs + fixture rebuild note → Task 4 + `make fixtures` steps in Tasks 2-3. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full content. ✅

**Type consistency:** `__nn<T>(x: T): T | null` defined in Task 1; emitted identically as `ts.call(ts.id("__nn"), [expr])` in Tasks 2-3. Test helper accessor `.data` matches the `categorize` agency-js precedent. ✅
