# Retire the `"any"` string sentinel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `VariableType | "any"` string sentinel from `lib/typeChecker/`. Represent "unknown type" only as the object `ANY_T`. No behavior change.

**Architecture:** The change is contained to `lib/typeChecker/`. It runs in four moves: widen `isAnyType` to accept both forms, route every literal comparison through it, then retire the string producer-by-producer under a strict invariant, then delete the dead machinery. The compiler drives the retirement: once a producer's signature narrows to `VariableType`, any leftover `=== "any"` becomes a TS2367 compile error.

**Tech Stack:** TypeScript (ESM, `@/` path aliases via tsc-alias), vitest.

## Global Constraints

- **Work only in `lib/typeChecker/`.** The sentinel never escapes this directory. Do not touch backends or other consumers.
- **Behavior-preserving.** Every existing test passes, with one deliberate exception: `flow.test.ts`'s nine `.toBe("any")` assertions migrate to `isAnyType(...)` checks (Task 3). If any other test flips, STOP — it means the string and object were not treated identically somewhere, which is a real asymmetry to investigate.
- **The core invariant.** Change a function's returns and narrow its signature **in the same commit**. Never change `return "any"` to `return ANY_T` while the signature is still `VariableType | "any"` — that opens a silent-break window the compiler cannot see.
- `ANY_T` is `{ type: "primitiveType", value: "any" }`, exported from `lib/typeChecker/primitives.js`. `isAnyType` is exported from `lib/typeChecker/utils.js`.
- Never use dynamic imports. Use `type` not `interface`.
- **Save test output to a file** (`| tee /tmp/<name>.log`) so failures do not require a rerun — the suite is slow.
- We are on branch `worktree-retire-any-sentinel`. Never commit to `main`. Re-check `git branch --show-current` before every commit.
- Do NOT run the full agency test suite. Only `lib/typeChecker/` unit tests are needed here.

## Verification commands (used throughout)

- Typecheck: `pnpm exec tsc --noEmit 2>&1 | tail -20`
- Unit + fixture suite: `pnpm exec vitest run lib/typeChecker/ 2>&1 | tee /tmp/tc.log | tail -25`

Run both from `/Users/adityabhargava/agency-lang/.claude/worktrees/retire-any-sentinel/packages/agency-lang`.

---

### Task 1: Widen `isAnyType`; collapse the four paired sites (Move 1)

**Files:**
- Modify: `lib/typeChecker/utils.ts:48`
- Modify: `lib/typeChecker/matchExprTypes.ts:78,149`, `lib/typeChecker/scopes.ts:425,428`

**Interfaces:**
- Produces: `isAnyType(t: VariableType | "any"): boolean` (parameter widened; return unchanged)

- [ ] **Step 1: Widen the `isAnyType` parameter**

In `lib/typeChecker/utils.ts`, change:

```ts
export function isAnyType(t: VariableType): boolean {
  return t.type === "primitiveType" && t.value === "any";
}
```

to:

```ts
// Accepts the string sentinel too, only during the #472 migration. Once every
// signature is narrowed to VariableType, the `| "any"` is removed again.
export function isAnyType(t: VariableType | "any"): boolean {
  return t === "any" || (t.type === "primitiveType" && t.value === "any");
}
```

- [ ] **Step 2: Collapse the four paired comparison sites**

At `matchExprTypes.ts:78` and `:149`, both read:

```ts
const isAny = (t: VariableType | "any") => t === "any" || isAnyType(t);
```

Since `isAnyType` now handles both, replace each with a direct call at the use sites, or simplify the local to `const isAny = isAnyType;`. Prefer deleting the local and calling `isAnyType` directly.

At `scopes.ts:425` and `:428`, replace `iterableType === "any" || isAnyType(iterableType)` with `isAnyType(iterableType)`.

- [ ] **Step 3: Verify green**

Run both verification commands. Expected: tsc clean, full `lib/typeChecker/` suite passes. Save to `/tmp/t1.log`.

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/utils.ts lib/typeChecker/matchExprTypes.ts lib/typeChecker/scopes.ts
git commit -F /tmp/commit1.txt
```
`/tmp/commit1.txt`:
```
Widen isAnyType to accept both any representations (#472)

Transitional: isAnyType now accepts the "any" string sentinel as well as
ANY_T, so comparison sites can route through one helper. Collapse the four
paired `=== "any" || isAnyType(t)` sites.
```

---

### Task 2: Route every comparison through `isAnyType` (Move 2)

This is the bulk of the change, and it is behavior-preserving. No producer changes here. After it, no code reads the `"any"` literal by hand, which closes the silent-break window for Task 3.

**Files:** every non-test file under `lib/typeChecker/` that compares against `"any"`. Find them:

```bash
grep -rn '=== "any"\|!== "any"' lib/typeChecker/ | grep -v '\.test\.'
```

Expected: 65 sites (56 `===`, 9 `!==`).

**Interfaces:** none changed. Pure internal rewrite.

- [ ] **Step 1: Rewrite each comparison**

Apply this transformation at every site the grep lists:

- `X === "any"` → `isAnyType(X)`
- `X !== "any"` → `!isAnyType(X)`

Where `X` is a compound expression, keep it parenthesized as needed: `foo.bar !== "any"` → `!isAnyType(foo.bar)`.

Add `import { isAnyType } from "./utils.js";` to any file that now calls it and did not import it. (`inference.ts` has its own local `isAnyType` — leave that for Task 5; do not add a second import there yet.)

Two sites need a note, not different handling:

- `assignability.ts:438`: `if (source === "any" || target === "any") return true;` → `if (isAnyType(source) || isAnyType(target)) return true;`. Leave the second, object-form check at `:487-488` alone for now; Task 4 collapses the pair.
- `widenType` (`assignability.ts:342`): `if (vt === "any") return "any";` → `if (isAnyType(vt)) return "any";`. The `return "any"` is a producer and stays until Task 5.

Do NOT touch `return "any"` statements or `.value === "any"` object-form checks in this task. Only the two comparison operators above.

- [ ] **Step 2: Confirm no bare comparisons remain**

```bash
grep -rn '=== "any"\|!== "any"' lib/typeChecker/ | grep -v '\.test\.'
```
Expected: empty.

- [ ] **Step 3: Verify green**

Run both verification commands → `/tmp/t2.log`. tsc clean; full suite passes unchanged (behavior-preserving). If a test fails here, a comparison was rewritten incorrectly — fix before committing.

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/
git commit -F /tmp/commit2.txt
```
`/tmp/commit2.txt`:
```
Route every "any" comparison through isAnyType (#472)

Behavior-preserving sweep of all 65 literal comparisons (=== / !== "any")
onto isAnyType. No producer changes yet. Removes every by-hand string check,
so the upcoming producer narrowing has nothing left to silently break.
```

---

### Task 3: Narrow the spine (Move 3, part 1)

`synthType`, `ScopeType`, and `inferredReturnTypes` are interlinked: narrowing one forces the others plus their consumers. This is one large atomic commit. It also handles the `synthesizer.ts` `| null` signal sites and the `flow.test.ts` assertion migration.

**Files:**
- Modify: `lib/typeChecker/synthesizer.ts` (`synthType:252`, `resolveResultFieldType:75`, the `:199` signal site, 27 `return "any"` → `return ANY_T`)
- Modify: `lib/typeChecker/scope.ts:3` (`ScopeType`), `lib/typeChecker/flow.ts` (`uniteTypes:154`, `typeAt:188`)
- Modify: `lib/typeChecker/types.ts:99` (`inferredReturnTypes`)
- Modify: `lib/typeChecker/flow.test.ts` (9 assertions)
- Plus whatever the compiler flags in consumers of the above.

**Interfaces:**
- Produces: `synthType(...): VariableType` (was `| "any"`); `ScopeType = VariableType` (alias kept for now, collapsed in Task 5); `typeAt(...): VariableType`; `inferredReturnTypes: Record<string, VariableType>`

- [ ] **Step 1: Flip producers to `ANY_T` and narrow signatures together**

In `synthesizer.ts`, change all 27 `return "any"` to `return ANY_T` (already imported). Narrow `synthType`'s return type from `VariableType | "any"` to `VariableType`. Do the same for `inferredReturnTypes` in `types.ts` and for `uniteTypes`/`typeAt` in `flow.ts`. Change `ScopeType` (`scope.ts:3`) from `VariableType | "any"` to `VariableType` (keep the alias name; Task 5 removes it).

- [ ] **Step 2: Handle the two `| null` signal sites**

`resolveResultFieldType` (`synthesizer.ts:75`) and the `:199` site return `VariableType | "any" | null`, where `"any"` is a signal ("caller returns any") and `null` means "no resolution." Narrow the return to `VariableType | null`. Replace `return "any"` with `return ANY_T`. Then read each caller: where it did `if (x === "any") return "any"`, it now receives `ANY_T` (a real type) and should set/return it as the type; where it checked `null`, that branch is unchanged. Confirm the control flow matches the original for both the any-case and the null-case.

- [ ] **Step 3: Migrate the nine `flow.test.ts` assertions**

`uniteTypes` and `typeAt` now return `ANY_T`, so `expect(...).toBe("any")` fails. Change each of the nine sites (`flow.test.ts:41,106,149,303,309,400,519,529,568`) from:

```ts
expect(typeAt(ref("y"), start, env(scope))).toBe("any");
```
to:
```ts
expect(isAnyType(typeAt(ref("y"), start, env(scope)))).toBe(true);
```
Import `isAnyType` from `./utils.js` in the test file. This is an assertion update, not a behavior change.

- [ ] **Step 4: Follow the compiler outward**

Narrowing the spine turns leftover mismatches into compile errors. Run `pnpm exec tsc --noEmit 2>&1 | tail -40` and fix each error. Most will be consumers that still typed a result as `VariableType | "any"` — narrow those too. Repeat until tsc is clean. This is the compiler enumerating the fallout; do not hunt by hand.

- [ ] **Step 5: Verify green**

Both verification commands → `/tmp/t3.log`. tsc clean; suite passes (with the migrated `flow.test.ts` assertions).

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker/
git commit -F /tmp/commit3.txt
```
`/tmp/commit3.txt`:
```
Narrow the any-sentinel spine to VariableType (#472)

synthType, ScopeType, inferredReturnTypes, uniteTypes, typeAt now return/store
VariableType and produce ANY_T. Handle the resolveResultFieldType | null signal
sites. Migrate flow.test.ts assertions from `.toBe("any")` to isAnyType checks.
```

---

### Task 4: Narrow the remaining producers to green (Move 3, part 2)

Continue the narrow-and-fix pass until no `VariableType | "any"` signature remains. Each file or producer-cluster that compiles cleanly on its own may be its own commit; keep the invariant (returns + signature together).

**Files (as the compiler surfaces them):** `checker.ts` (with its `| undefined` signal sites at `:50,:74,:979`), `scopes.ts`, `resolveCall.ts`, `builtins.ts`, `inference.ts`, `matchExprTypes.ts`, `typeCases.ts`, `interruptAnalysis.ts`, `functionTypeRaises.ts` (`| null | undefined` sites at `:38,:131`), `functionValueEffects.ts`, `effectSets.ts`, `effectPayloadCheck.ts`, `matchExhaustiveness.ts`, `narrowing.ts`, `flowBuilder.ts`, `index.ts`.

- [ ] **Step 1: Find remaining sentinel signatures**

```bash
grep -rn '| "any"' lib/typeChecker/ | grep -v '\.test\.'
```

Work through the list. For each producer: change its `return "any"` (if any) to `return ANY_T`, narrow the signature, and fix the compiler's fallout.

- [ ] **Step 2: Handle the `| undefined` and `| null | undefined` signal sites**

`checker.ts:50,:74,:979` (`VariableType | "any" | undefined`) and `functionTypeRaises.ts:38,:131` (`VariableType | "any" | null | undefined`): keep `null`/`undefined` with their meanings; fold only the `"any"` disjunct into `VariableType` as `ANY_T`, verifying each caller treated the any-case like any other unknown-type result.

- [ ] **Step 3: Collapse the back-to-back assignability check**

In `assignability.ts`, once `isAssignable`'s `source`/`target` are `VariableType`, the string-form check (now `isAnyType(source) || isAnyType(target)`) and the object-form check at `:487-488` (`resolvedSource.value === "any" || ...`) are redundant. Keep one. Delete the other and its apologetic comment (symptom #3 in the spec).

- [ ] **Step 4: Confirm no sentinel signatures remain**

```bash
grep -rn '| "any"' lib/typeChecker/ | grep -v '\.test\.'
```
Expected: empty.

- [ ] **Step 5: Verify green**

Both commands → `/tmp/t4.log`. tsc clean; suite passes.

- [ ] **Step 6: Commit** (or several commits across this task)

```bash
git add lib/typeChecker/
git commit -F /tmp/commit4.txt
```
`/tmp/commit4.txt`:
```
Narrow remaining any-sentinel producers to VariableType (#472)

All producer signatures now return VariableType. Fold the | undefined and
| null | undefined signal sites. Collapse the back-to-back any check in
isAssignable into one.
```

---

### Task 5: Delete the dead machinery (Move 4)

Nothing produces the string now, so the transitional scaffolding comes out.

**Files:** `synthesizer.ts` (`maybeAny:236`, `:600` caller), `inference.ts:126,129`, `utils.ts:48`, `assignability.ts` (`widenType`), `scope.ts:3`

- [ ] **Step 1: Delete `maybeAny`**

Remove `maybeAny` (`synthesizer.ts:236`). At its one caller (`:600`), `maybeAny(synthType(inner, scope, ctx))` becomes `synthType(inner, scope, ctx)` — `synthType` now returns `VariableType` directly.

- [ ] **Step 2: Fold the `inference.ts` duplicates**

Delete the local `const ANY_T` (`inference.ts:126`) and the local `isAnyType` (`:129`). Add `import { ANY_T } from "./primitives.js";` and `import { isAnyType } from "./utils.js";` (merge into existing import lines if present).

- [ ] **Step 3: Narrow `isAnyType` back to `VariableType`**

In `utils.ts`, restore the parameter and drop the transitional branch:

```ts
export function isAnyType(t: VariableType): boolean {
  return t.type === "primitiveType" && t.value === "any";
}
```

- [ ] **Step 4: De-cast `widenType` and collapse `ScopeType`**

In `assignability.ts`, narrow `widenType` to `widenType(vt: VariableType): VariableType`, delete the `if (vt === "any") return "any";` line, and remove every `as VariableType` cast in its body (they are now unnecessary). In `scope.ts`, replace `type ScopeType = VariableType | "any"` usage: either set `type ScopeType = VariableType` or replace `ScopeType` with `VariableType` throughout and delete the alias. Prefer deleting the alias.

- [ ] **Step 5: Verify green**

Both commands → `/tmp/t5.log`. tsc clean; suite passes.

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker/
git commit -F /tmp/commit5.txt
```
`/tmp/commit5.txt`:
```
Delete the any-sentinel scaffolding (#472)

Remove maybeAny, the inference.ts local ANY_T + isAnyType duplicates,
widenType's | "any" branch and casts, and the ScopeType alias. Narrow
isAnyType back to VariableType. The string sentinel is now unrepresentable.
```

---

### Task 6: Regression guard test

A cheap test that fails if the sentinel creeps back. The type system already blocks producing it; this documents the intent and catches a stray reintroduction in review.

**Files:**
- Create: `lib/typeChecker/anySentinelRetired.test.ts`

- [ ] **Step 1: Write the guard test**

```ts
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(dir, f));
}

describe("the 'any' string sentinel stays retired (#472)", () => {
  it("no file declares a `VariableType | \"any\"` signature", () => {
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, "utf8");
      expect(src.includes('| "any"'), path.basename(file)).toBe(false);
    }
  });

  it("no file returns the bare `\"any\"` string", () => {
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, "utf8");
      expect(/return\s+"any"/.test(src), path.basename(file)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run lib/typeChecker/anySentinelRetired.test.ts 2>&1 | tee /tmp/t6.log | tail -10`
Expected: PASS (both assertions green, proving the retirement is complete).

- [ ] **Step 3: Sanity-check the guard bites**

Temporarily add `return "any"` to any source file, rerun the test, confirm it FAILS, then revert. (Do not commit the temporary edit.)

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/anySentinelRetired.test.ts
git commit -F /tmp/commit6.txt
```
`/tmp/commit6.txt`:
```
Guard against reintroducing the "any" sentinel (#472)

Scans lib/typeChecker source for `| "any"` signatures and bare `return "any"`.
Backstops the type-level guarantee against a stray reintroduction.
```

---

## Self-Review

**Spec coverage:**
- Core invariant (returns + narrow together) → Global Constraints + Task 3/4 method. ✓
- Move 1 (widen isAnyType, 4 paired sites) → Task 1. ✓
- Move 2 (route 65 comparisons) → Task 2. ✓
- Move 3 (spine + remaining producers, signal sites) → Tasks 3, 4. ✓
- Move 4 (delete maybeAny, inference dups, isAnyType narrow-back, widenType casts, ScopeType) → Task 5. ✓
- Control-signal sites (`| null` synth, `| undefined` checker, `| null | undefined` functionTypeRaises) → Task 3 Step 2, Task 4 Step 2. ✓
- flow.test.ts nine-assertion migration → Task 3 Step 3. ✓
- Behavior-preservation gate + stop-on-flip → Global Constraints, per-task verify. ✓
- Regression guard → Task 6. ✓
- Symptom #3 (assignability dedup) → Task 4 Step 3. ✓

**Placeholder scan:** none. The compiler-discovered edits in Tasks 3-4 are method-plus-grep, not placeholders — the exact set is defined by tsc output, which is the point of a compiler-guided refactor.

**Type consistency:** `isAnyType` widens in Task 1, narrows back in Task 5. `synthType`/`ScopeType`/`typeAt`/`inferredReturnTypes` narrow to `VariableType` in Task 3. `ANY_T` from `primitives.js`, `isAnyType` from `utils.js` throughout.
