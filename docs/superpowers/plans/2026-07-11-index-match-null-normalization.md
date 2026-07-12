# Index/Match `undefined`→`null` Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make missing object-key lookups (`obj[key]`), out-of-bounds array indexing (`arr[i]`), and unmatched `match` expressions yield `null` instead of `undefined`, completing the value-side of Agency's "one nothing-value" invariant.

**Architecture:** Add a tiny `__nn(x) => x ?? null` runtime helper, wired exactly like the existing `__eq` helper. Emit `__nn(...)` around two codegen sites in `typescriptBuilder.ts`: the **terminal** index read of an access chain (wrapped once, after the chain is built — NOT per index element), and the `__matchval_<id>` read that consumes a match result. No type-checker changes — this is a runtime-value fix only.

**Why terminal-only for index reads:** Wrapping each `case "index"` element individually inserts `__nn` *between* an optional index and any following access, which captures JS optional-chain short-circuit and turns it into a thrown `TypeError`. Concretely, `a?.[b].c` with a null `a` currently yields `undefined` (whole-chain short-circuit); `__nn(a?.[b]).c` would evaluate `null.c` and throw. Wrapping only the completed chain when its last element is an index avoids this, still normalizes the terminal missing-key / out-of-bounds read to `null`, and emits one `__nn(...)` per read instead of nested `__nn(__nn(...))`.

**Coercion caveat (intended):** `null` and `undefined` coerce differently in arithmetic (`undefined + 1` is `NaN`; `null + 1` is `1`) and string contexts (`` `${undefined}` `` is `"undefined"`; `` `${null}` `` is `"null"`). The string-context change is the fix the issue wants. The arithmetic change is a deliberate side effect of collapsing to one nothing-value; it is consistent with Agency's model (do not do math on a missing key) and introduces no new nullish value that was not already there.

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

### Task 2: Coerce the terminal index read to `null`

Wrap the completed access chain in `__nn(...)` when its last element is an index, so both `obj[key]` (missing key) and `arr[i]` (out of bounds) yield `null` as a consumed value.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1154` (the `return result;` tail of `processValueAccess`)
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
    negativeIndex: arr[-1],
    inBounds: arr[0],
    falsyZero: zero["z"]
  }
}

// Regression guard for the terminal-only wrap decision (Step 3). `a` is null, so
// `a?.["x"]` short-circuits and `["y"]` is never evaluated: with terminal-only
// wrapping the whole chain is `__nn(a?.["x"]["y"])` → null (NO throw). If the fix
// ever regresses to per-element wrapping it becomes `__nn(__nn(a?.["x"])["y"])` →
// `null["y"]` → THROWS, and this node crashes the test.
node optChainNoThrow() {
  const a: Record<string, Record<string, number>> | null = null
  return { deep: a?.["x"]["y"] }
}
```

Create `tests/agency-js/index-missing-key-null/test.js`:

```js
import { lookups, optChainNoThrow } from "./agent.js";
import { writeFileSync } from "fs";

const r = (await lookups()).data;

// Must not throw. With per-element wrapping this call crashes (null["y"]);
// with terminal-only wrapping `deep` is null and this resolves cleanly.
const opt = (await optChainNoThrow()).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      missingKeyIsNull: r.missingKey === null,
      outOfBoundsIsNull: r.outOfBounds === null,
      negativeIndexIsNull: r.negativeIndex === null,
      presentKeyValue: r.presentKey,
      inBoundsValue: r.inBounds,
      falsyZeroPreserved: r.falsyZero === 0,
      optChainDeepIsNull: opt.deep === null,
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
  "negativeIndexIsNull": true,
  "presentKeyValue": 42,
  "inBoundsValue": 1,
  "falsyZeroPreserved": true,
  "optChainDeepIsNull": true
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/index-missing-key-null 2>&1 | tee /tmp/index-test.log`
Expected: FAIL — `missingKeyIsNull`, `outOfBoundsIsNull`, and `negativeIndexIsNull` come back `false` (the raw value is `undefined`, and `undefined === null` is `false`), so `__result.json` differs from `fixture.json`.

- [ ] **Step 3: Normalize the terminal index read to `null`**

Do NOT wrap inside `case "index":`. Wrapping each index element inserts `__nn` *between* an optional index and any following access, which captures JS optional-chain short-circuit and converts it to a thrown `TypeError` (e.g. `a?.[b].c` with a null `a` goes from `undefined` to `null.c` → throw). Instead, leave `case "index":` exactly as-is and normalize once, after the chain is built, when the chain's last element is an index (a value read).

In `lib/backends/typescriptBuilder.ts`, `processValueAccess`, the chain loop currently ends (line ~1153-1154):

```ts
      }
    }
    return result;
  }
```

Change the tail so a terminal index read is wrapped in `__nn`:

```ts
      }
    }
    const lastElement = node.chain[node.chain.length - 1];
    if (lastElement?.kind === "index") {
      return ts.call(ts.id("__nn"), [result]);
    }
    return result;
  }
```

This normalizes the observable value of a terminal `obj[key]` / `arr[i]` read (missing key, out of bounds, negative) to `null`, while:
- preserving JS short-circuit *within* the chain (no mid-chain `__nn`), so `a?.[b].c` is unchanged and does not throw;
- leaving intermediate missing reads to throw exactly as today (`obj[a][b]` where `obj[a]` is missing throws before the terminal `__nn` runs);
- emitting a single `__nn(...)` per read instead of nested `__nn(__nn(...))`.

**Explicitly untouched (intentionally left raw):**
- Property-terminal chains (`obj.foo`) are out of scope — the guard fires only when the last element is an `index`.
- The assignment-LHS index emitter (`lib/backends/typescriptBuilder/assignmentEmitter.ts:105`) is a write target, not a value read.
- The two compiler-internal `ts.index` sites — `stackBranches[branchKey]` (`typescriptBuilder.ts:398`) and the for-in `keys[i]` iterator (`typescriptBuilder.ts:3672`) — index known-present keys and never surface an observable `undefined`.

- [ ] **Step 4: Rebuild the compiler**

Run: `make 2>&1 | tail -20 | tee /tmp/build.log`
Expected: build succeeds.

- [ ] **Step 5: Run the execution test to verify it passes**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/index-missing-key-null 2>&1 | tee /tmp/index-test.log`
Expected: PASS — `__result.json` matches `fixture.json` (all booleans `true`, values `42`/`1`).

- [ ] **Step 6: Regenerate integration fixtures and review the diff**

Run: `make fixtures 2>&1 | tail -20`
Run: `git status --short tests/typescriptGenerator/ && git diff tests/typescriptGenerator/ | head -80`
Expected: `.mjs` fixtures that end a value read on an index now show that read wrapped as `__nn(...)`, exactly once per terminal read (no nested `__nn(__nn(...))`). Two guards to confirm in the diff:
- No `__nn` appears *between* an optional index and a following access (grep the diff for `__nn(` immediately followed by `)?.` or `).` on a chain — there should be none). This is the regression the terminal-only wrap exists to avoid.
- Property-terminal chains (`obj.foo`), assignment LHS (`arr[i] = ...`), and for-in `keys[i]` iterators are unchanged.

Confirm no other unrelated churn.

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

The design relies on the fact (confirmed in `lib/typeChecker/matchExhaustiveness.ts:181`, `missingCases` returns `[]` when `!caseSet.closed`) that a `match` over an **open** type like `string` is never required to be exhaustive, so this compiles cleanly at the default `matchExhaustiveness: "error"` — no config override needed. At runtime the unmatched scrutinee falls through and (pre-fix) yields `undefined`.

Note: this **supersedes** the spec (case 4), which suggested setting `matchExhaustiveness: "warn"`. That override is unnecessary for an open scrutinee type — do not add it, and do not "fix" this test by adding one.

Create `tests/agency-js/match-no-arm-null/agent.agency`:

```
node classify(s: string) {
  const result = match (s) {
    "a" => "got-a"
    "b" => "got-b"
  }
  return result
}

// Guards spec case 5: an arm that genuinely yields `null` must stay `null` (no
// double-coercion surprise), and a real-valued arm passes through `__nn`
// unchanged. `classifyNullable("z")` also exercises the no-arm path alongside an
// explicit null arm so the two null sources are not conflated.
node classifyNullable(s: string) {
  const result = match (s) {
    "a" => "got-a"
    "n" => null
  }
  return result
}
```

Create `tests/agency-js/match-no-arm-null/test.js`:

```js
import { classify, classifyNullable } from "./agent.js";
import { writeFileSync } from "fs";

const matched = (await classify("a")).data;
const unmatched = (await classify("z")).data;

const realArm = (await classifyNullable("a")).data;
const nullArm = (await classifyNullable("n")).data;
const noArm = (await classifyNullable("z")).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      matchedValue: matched,
      unmatchedIsNull: unmatched === null,
      realArmValue: realArm,
      nullArmIsNull: nullArm === null,
      noArmIsNull: noArm === null,
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
  "unmatchedIsNull": true,
  "realArmValue": "got-a",
  "nullArmIsNull": true,
  "noArmIsNull": true
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/match-no-arm-null 2>&1 | tee /tmp/match-test.log`
Expected: FAIL — the two no-arm paths, `unmatchedIsNull` and `noArmIsNull`, come back `false` (their match result is `undefined`). Note `nullArmIsNull` and `realArmValue` already pass pre-fix (an explicit `null` arm is already `null`, and a real arm is unchanged) — they are passthrough guards proving the fix does not disturb matched values, not failing cases.

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
- Fix 1, index reads (issue #1 object missing key + #2 array OOB + negative, shared terminal site) → Task 2. ✅
- Fix 2, match no-arm (all three paths via the read chokepoint) + valueless-yield source → Task 3. ✅
- Non-goal: no type-checker change → no task touches `lib/typeChecker/`. ✅
- Non-goal: match-comparison `===` unchanged → not touched. ✅
- Testing: falsy-passthrough guard (`0`/`""`/`false`/`NaN`) in Task 1 unit test + `falsyZero`/`presentKey` in Task 2; `=== null` JS observation (not `==`, which `__eq` blinds) in Tasks 2-3; matched-arm-still-returns-value in Task 3. ✅
- Regression guard for the terminal-only decision: `optChainNoThrow` (`a?.["x"]["y"]` with null `a`) in Task 2 — CI-fails (throws) if the fix regresses to per-element wrapping. Emitted shape verified as a single chain `a?.["x"]["y"]` against a fresh build. ✅
- Spec case 5 (arm genuinely yields `null`; real arm unchanged; no double-coercion) → `classifyNullable` in Task 3. ✅
- Known coverage limits (accepted): the plain-mode / handler-body match read path funnels through the same `isMatchValName` chokepoint (verified — `processMatchExpressionPlain` writes `__matchval_<id>` that "the consumer reads"), so it is covered by the fix but exercised only indirectly. The valueless-`yield` source change (Task 3 Step 4) is masked by the read-site wrap and cannot be isolated by a runtime test; it is defense-in-depth, not independently asserted. ✅
- Docs + fixture rebuild note → Task 4 + `make fixtures` steps in Tasks 2-3. ✅

**Altitude / regression review:**
- Index normalization is emitted once, at the **terminal** index read (chain tail), not per index element. This preserves JS optional-chain short-circuit inside a chain (`a?.[b].c` does not throw) and avoids nested `__nn(__nn(...))`. The "how" (nullish-normalize) stays encapsulated in the single `__nn` helper; the codegen only declares *where* to normalize. ✅
- All four `ts.index(` emit sites accounted for: terminal user read (wrapped), assignment LHS + `stackBranches[branchKey]` + for-in `keys[i]` (intentionally raw, named in Task 2 Step 3). ✅
- Coercion-profile change (`null` vs `undefined` in arithmetic/string) is a deliberate, documented consequence — Architecture "Coercion caveat". ✅
- Divergence from spec case 4 (`matchExhaustiveness: "warn"`) is intentional and flagged in Task 3 Step 1. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full content. ✅

**Type consistency:** `__nn<T>(x: T): T | null` defined in Task 1; emitted identically as `ts.call(ts.id("__nn"), [expr])` in Tasks 2-3. Test helper accessor `.data` matches the `categorize` agency-js precedent. ✅
