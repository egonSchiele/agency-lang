# Handler Payload Typing (H3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Type an inline handler's param `e` so that `e.data` (the interrupt payload) is type-safe **per effect** — e.g. after `if (e.effect == "mymod::deposit")`, `e.data.amount` is known to be a `number`, and passing `e.data` to a function expecting the wrong shape is a type error.

**Architecture:** Type `e` as a **discriminated union** of per-effect members: one member `{ effect: "<kind>", data: <declared payload>, message: any, origin: any }` per raisable effect kind. Payload narrowing then falls out **for free** from the existing discriminated-union narrowing (D1) and member-path narrowing (M2): `if (e.effect == "...")` narrows `e` to the matching member, which carries the concrete `data` type. Exhaustiveness (B1 on `e.effect`, B2 on `e`) keeps working on the same union.

**The load-bearing design decision** (see "Core Design Decision"): unlike H1 — which retyped `e` *after* `checkScopes`, feeding only `checkMatchExhaustiveness` — payload safety requires `e` to carry its refined type **during** `checkScopes`, because `e.data` *usage* sites (`takesNum(e.data)`, `e.data.amount`) are checked there. That forces a **pipeline reorder**: interrupt analysis + the effect→payload registry + the handler-param refinement must run **before** `buildFlowGraphs`/`checkScopes`. Task 1 is a throwaway spike proving this works and measuring the blast radius before we invest in the clean implementation.

**Tech Stack:** TypeScript, vitest, the Agency type checker (`lib/typeChecker/`). No new dependencies.

## Revisions from review

This plan incorporates [the review](2026-07-01-handler-payload-typing-h3-review.md). Resolved before writing code (findings recorded inline in the relevant tasks):

- **Nested-`handle` guard preserved.** `bodyHasNestedHandle` lives in `refineInlineHandlerParams`'s *eligibility* loop; Task 3 rewrites only `handlerParamType` and does **not** touch that loop, so the guard survives. Task 3 states this explicitly and Task 5 adds a nested-handle test. (`docs/site/guide/handlers.md` documents the nested-handle → untyped behavior.)
- **Match arm grammar verified.** The discriminated-object-union arm is `{ effect: "kind" } => …` (per `docs/site/guide/pattern-matching.md:212` and `handlers.md`), **not** `is <effect>`. The Task-3 shape test uses the verified form — no hedge.
- **`analyzeInterruptsFromScopes` purity confirmed.** Its three `ctx.errors.push` neighbors (`interruptAnalysis.ts:373/418/538`) belong to the *consumer* functions `checkUnhandledInterruptWarnings` (@356), `checkHandlerBodyInterrupts` (@398), `checkCallbackBodyInterrupts` (@514) — all of which stay in place. `analyzeInterruptsFromScopes` (@70–236) pushes nothing. The reorder does not move any error-emission point.
- **Scratch paths are portable** (`/tmp/h3-*.txt`).
- Added tests: nested handle, empty-payload vs no/dropped declaration, guarded-else union, function-ref handler untouched, B2 `match (e)` exhaustiveness, recursive raise. The flat-scope limitation test asserts a **measured** outcome, not "whatever happens."

## Global Constraints

- **Handlers are safety infrastructure.** This is a **type-only** change. It must NEVER touch handler registration (`pushHandler`), execution, checkpoints, or state restoration. The only runtime-adjacent mutation permitted is `info.scope.declare(name, type)` (re-declaring a param's *type* in the checker's scope), exactly as H1 already does.
- **No dynamic imports.** Static `import` only.
- **Use objects, not maps; arrays, not sets; `type`, not `interface`.** (The existing `nameCount` `Map` in `handlerParamTyping.ts` predates the rule and is out of scope; do not add new `Map`/`Set`.)
- **Never commit/push unless the user asks.** Implement directly — no subagents. Commit messages / PR bodies go in a **file** (apostrophes break inline `-m`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Do not run the agency execution suite locally.** Run typeChecker unit tests + targeted vitest files only. CI runs the full suite on the PR.
- Build stdlib with `make` if any `.agency` stdlib file changes (none expected).

---

## Core Design Decision — why a pipeline reorder

### What H1 does today (and why it is not enough for H3)

`refineInlineHandlerParams` (`handlerParamTyping.ts`) runs at pipeline step **6d-bis**, *after* `checkScopes` (step 4). It re-declares `e` as `{ effect: <literal union>, message: any, data: any, origin: any }`. Because it runs *after* field-access checking, the refined type only reaches `checkMatchExhaustiveness` (6e). H1's own docstring records this:

> although this is a closed `objectType`, it does NOT make `e.<field>` a "does not exist" error — field-access checking runs in `checkScopes`, BEFORE this pass re-types the param.

For **exhaustiveness** that is fine (`checkMatchExhaustiveness` re-synthesizes the scrutinee). For **payload safety** it is fatal: `takesNum(e.data)` / `e.data.amount` are checked *during* `checkScopes`, when `e` is still `any`. A late retype cannot rescue a usage site that already type-checked as `any`.

**Therefore `e` must carry its discriminated-union type before `checkScopes` runs.**

### The reorder (contained, not "move everything")

`refineInlineHandlerParams` needs exactly two inputs, **neither depending on `checkScopes`**:

1. `interruptEffectsByFunction` — from `analyzeInterruptsFromScopes(scopes, ctx)`. This pass (`interruptAnalysis.ts:70–236`) reads function-ref arg types via `synthType(...)` against `ctx.functionDefs` (populated by `inferReturnTypes`, step 2) and **pushes no diagnostics** (verified: the three `ctx.errors.push` in the file are all in the consumer functions @356/@398/@514, which stay put). Moving it earlier is side-effect-free.
2. The effect→payload registry — `buildEffectRegistry(ctx)` (`effectPayloadCheck.ts`), reading `ctx.symbolTable.allEffectDeclarations()`. Independent of `checkScopes`.

So the reorder moves **only these** ahead of `buildFlowGraphs`/`checkScopes`:

```
2.  inferReturnTypes
3.  buildScopes
3a. analyzeInterruptsFromScopes         ← MOVED UP (pure; returns data, no diagnostics)
3b. registry = buildEffectRegistry(ctx) ← NEW: build ONCE here
3c. refineInlineHandlerParams(..., registry)  ← MOVED UP (now payload-typed)
4.  buildFlowGraphs      (now sees the refined `e` — no memo-reset hack needed)
5.  checkScopes          (now `e.data` is typed → payload narrowing fires at usage)
6.  buildInterruptCallGraph, checkUnhandled…, checkCallback…, checkHandler…, checkRaises…  (UNCHANGED positions; consume the value from 3a)
6d. checkEffectPayloads(scopes, ctx, registry)  ← receives the prebuilt registry (no rebuild → no double conflict-report)
6e. checkMatchExhaustiveness  (UNCHANGED)
```

The consumers of `analyzeInterruptsFromScopes` just read a value computed a few steps earlier. `buildInterruptCallGraph` stays put (`refineInlineHandlerParams` uses `interruptEffectsByFunction`, not the call graph).

### The blast radius — closed-object strictness

With `e` typed as `{effect, data, message, origin}` **during** `checkScopes`, member access on an **unknown** field (`e.foo`) now errors, and `e.data.x` where `data` is a union-of-payloads may error **without** a preceding `if (e.effect == "...")` narrow. This is the interrupt runtime object's true shape (`interrupts.ts` — exactly those four fields), so the strictness is arguably *correct*, but it is a **behavior change**. **Task 1 (spike) measures it before we commit.** Large/unfixable radius → STOP and report.

### Rejected alternative

*Keep `e: any` and special-case only `e.data` narrowing in member-access checking.* Rejected: bespoke per-effect code that does not compose with `match`/D1/M2 and would need its own narrowing + exhaustiveness machinery. The reorder reuses all of it.

---

## File Structure

- `lib/typeChecker/handlerParamTyping.ts` (modify) — `handlerParamType` gains a `registry` arg + builds a discriminated union; `refineInlineHandlerParams` gains a `registry` param and drops the memo-reset (Task 4). **Eligibility loop — including `bodyHasNestedHandle` — is untouched.**
- `lib/typeChecker/effectPayloadCheck.ts` (modify) — export `buildRegistry` as `buildEffectRegistry`; `checkEffectPayloads` accepts an optional prebuilt registry.
- `lib/typeChecker/index.ts` (modify) — the reorder.
- `lib/typeChecker/handlerParamTyping.test.ts` (modify) — payload-shape + payload-narrowing + edge-case tests.
- `lib/typeChecker/effectPayloadCheck.test.ts` (modify) — conflict reported exactly once with a shared registry.
- Docs: `docs/site/guide/handlers.md` (the "per-effect payload typing on `e.data` is a later addition" note becomes "shipped"); `handler-narrowing-spec.md` status line.

---

### Task 1: Spike — prove payload narrowing fires and measure the blast radius (THROWAWAY)

**This task's code is exploratory and discarded/redone cleanly in Tasks 2–4.** Deliverable: a GO/NO-GO decision + a breakage count. Do it on a scratch commit you `git reset` afterward.

**Files:**
- Modify (temporarily): `index.ts`, `handlerParamTyping.ts`, `effectPayloadCheck.ts`
- Scratch test: `lib/typeChecker/__h3_spike.test.ts` (delete at end of task)

**Interfaces:**
- Consumes: `analyzeInterruptsFromScopes(scopes, ctx): Record<string, InterruptEffect[]>`, `buildRegistry(ctx): Record<string, ObjectType>` (currently un-exported), `refineInlineHandlerParams(scopes, interruptEffectsByFunction, ctx)`.
- Produces: a decision (nothing durable).

- [ ] **Step 1: Write the spike e2e test**

Create `lib/typeChecker/__h3_spike.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

function allErrors(source: string): TypeCheckError[] {
  const file = path.join(os.tmpdir(), `tc-h3spike-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`);
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, source);
    return typeCheck(parseResult.result, {}, info).errors;
  } finally {
    unlinkSync(file);
  }
}

describe("H3 spike", () => {
  it("flags a payload-shape mismatch after narrowing", () => {
    const errs = allErrors(`
effect spike::deposit { amount: number }
def takesString(s: string): string { return s }
def risky() { raise spike::deposit("d", { amount: 1 }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "spike::deposit") {
      takesString(e.data.amount)
    }
  }
}`);
    expect(errs.some((x) => x.severity === "error")).toBe(true);
  });

  it("accepts a correctly-typed payload use after narrowing", () => {
    const errs = allErrors(`
effect spike::deposit { amount: number }
def takesNum(n: number): number { return n }
def risky() { raise spike::deposit("d", { amount: 1 }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "spike::deposit") {
      takesNum(e.data.amount)
    }
  }
}`);
    expect(errs.filter((x) => x.severity === "error")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm it FAILS on today's pipeline**

Run: `pnpm exec vitest run lib/typeChecker/__h3_spike.test.ts 2>&1 | tee /tmp/h3-spike-before.txt`
Expected: "flags a payload-shape mismatch" FAILS (today `e.data` is `any`).

- [ ] **Step 3: Apply the minimal spike wiring**

In `handlerParamTyping.ts`, temporarily rewrite `handlerParamType` to a discriminated union taking a registry, and drop the memo reset:

```ts
import type { ObjectType } from "../types/typeHints.js";

function handlerParamType(kinds: string[], registry: Record<string, ObjectType>): VariableType {
  const member = (kind: string): VariableType => ({
    type: "objectType",
    properties: [
      { key: "effect", value: stringLiteral(kind) },
      { key: "data", value: registry[kind] ?? ANY_T },
      { key: "message", value: ANY_T },
      { key: "origin", value: ANY_T },
    ],
  });
  return kinds.length === 1 ? member(kinds[0]) : { type: "unionType", types: kinds.map(member) };
}
```

Thread `registry` into `refineInlineHandlerParams(scopes, interruptEffectsByFunction, ctx, registry)`; pass to `handlerParamType(kinds, registry)`; delete the trailing `if (changed && ctx.flowEnv) …` memo-reset block. **Do not touch the eligibility loop** (the `bodyHasNestedHandle` / name-collision / annotation filters stay).

In `effectPayloadCheck.ts`, add `export` to `buildRegistry`.

In `index.ts`, reorder (spike-quality is fine):
```ts
const scopes = buildScopes(ctx);
const interruptEffectsByFunction = analyzeInterruptsFromScopes(scopes, ctx);
const registry = buildRegistry(ctx);
refineInlineHandlerParams(scopes, interruptEffectsByFunction, ctx, registry);
buildFlowGraphs(scopes, ctx);
checkScopes(scopes, ctx);
// Leave the interrupt-check consumers + buildInterruptCallGraph where they are,
// still reading interruptEffectsByFunction. For the spike, keep the existing
// checkEffectPayloads(scopes, ctx) call — a double registry is acceptable noise
// for a throwaway; you only care whether narrowing fires.
```

- [ ] **Step 4: Run to confirm it now PASSES**

Run: `pnpm exec vitest run lib/typeChecker/__h3_spike.test.ts 2>&1 | tee /tmp/h3-spike-after.txt`
Expected: BOTH tests PASS. If the mismatch test still does not error, payload narrowing is NOT firing — STOP, probe `synthType` on `e.data` after the narrow, report to the user. Do not proceed.

- [ ] **Step 5: Measure blast radius — full typeChecker unit suite**

Run: `pnpm exec vitest run lib/typeChecker 2>&1 | tee /tmp/h3-spike-unit.txt`
Record newly-failing tests, each classified (a) legitimately asserting the old `any` behavior, or (b) a genuine regression (a handler accessing a real field now errors). Ignore double conflict-reports from `checkEffectPayloads` (the un-deduped spike registry — expected).

- [ ] **Step 6: Measure blast radius — stdlib + fixtures**

Run: `pnpm exec vitest run lib 2>&1 | tee /tmp/h3-spike-lib.txt`
Record the count of newly-failing tests stemming from handler-param field access on unknown fields, or `e.data.x` without a narrow.

- [ ] **Step 7: GO / NO-GO + clean up**

Write the verdict to `/tmp/h3-spike-verdict.md`: did narrowing fire (Step 4)? blast radius N, classified (a legit-flip vs b regression)? recommendation GO / NO-GO. Then discard:
```bash
git checkout -- lib/typeChecker/index.ts lib/typeChecker/handlerParamTyping.ts lib/typeChecker/effectPayloadCheck.ts
rm lib/typeChecker/__h3_spike.test.ts
```

- [ ] **Step 8: Gate**

GO → Task 2. NO-GO / needs a product call → STOP and present `/tmp/h3-spike-verdict.md` to the user. (No commit — throwaway.)

---

### Task 2: Share one effect→payload registry (no double conflict-reporting)

**Files:**
- Modify: `lib/typeChecker/effectPayloadCheck.ts`
- Test: `lib/typeChecker/effectPayloadCheck.test.ts`

**Interfaces:**
- Produces: `export function buildEffectRegistry(ctx: TypeCheckerContext): Record<string, ObjectType>` — the renamed, exported builder (reports conflicts/duplicates as a side effect, drops conflicting effects).
- Produces: `checkEffectPayloads(scopes: ScopeInfo[], ctx: TypeCheckerContext, registry?: Record<string, ObjectType>): void` — uses the passed registry when provided, else builds its own (back-compat).

- [ ] **Step 1: Write the failing test — conflicts reported exactly once**

`effectPayloadCheck.test.ts` already imports `typecheckSource` from `./testUtils.js`. Add:

```ts
it("reports a payload conflict exactly once (shared-registry guard)", () => {
  const errs = typecheckSource(`
effect dup::e { a: number }
effect dup::e { a: string }
node main() { }`).filter((x) => /Conflicting payload types for effect 'dup::e'/.test(x.message));
  expect(errs.length).toBe(1);
});
```

- [ ] **Step 2: Run — baseline PASS**

Run: `pnpm exec vitest run lib/typeChecker/effectPayloadCheck.test.ts 2>&1 | tee /tmp/h3-t2-before.txt`
Expected: PASS (today: one `checkEffectPayloads` call → one registry → one conflict). This is a **regression guard** for Task 4, where a shared registry must not become a rebuilt-twice registry.

- [ ] **Step 3: Rename + export the builder, add the optional param**

In `effectPayloadCheck.ts`:
- Rename `function buildRegistry` → `export function buildEffectRegistry` (update the internal call site).
- Change `checkEffectPayloads` to accept `registry?: Record<string, ObjectType>` and use `const reg = registry ?? buildEffectRegistry(ctx);` (rename the local from `registry` to `reg` to avoid shadowing):

```ts
export function checkEffectPayloads(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
  registry?: Record<string, ObjectType>,
): void {
  const reg = registry ?? buildEffectRegistry(ctx);
  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    ctx.withScope(info.scopeKey, () => {
      for (const { node } of walkNodes(info.body)) {
        if (node.type !== "interruptStatement") continue;
        const payloadType = reg[node.effect];
        if (!payloadType) continue;
        checkRaiseSite(node, payloadType, info, ctx);
      }
    });
  }
}
```

- [ ] **Step 4: Run the effectPayloadCheck tests**

Run: `pnpm exec vitest run lib/typeChecker/effectPayloadCheck.test.ts 2>&1 | tee /tmp/h3-t2-after.txt`
Expected: PASS (including the new once-only conflict test).

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/effectPayloadCheck.ts lib/typeChecker/effectPayloadCheck.test.ts
git commit -F /tmp/h3-t2-msg.txt
```
`/tmp/h3-t2-msg.txt`:
```
refactor(typechecker): export shared effect→payload registry

Rename buildRegistry → buildEffectRegistry (exported) and let
checkEffectPayloads accept a prebuilt registry, so a single registry can be
shared across passes without double-reporting conflicts. Pure refactor;
behavior unchanged (guarded by a once-only conflict test).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 3: Discriminated-union `handlerParamType`

**Files:**
- Modify: `lib/typeChecker/handlerParamTyping.ts`
- Test: `lib/typeChecker/handlerParamTyping.test.ts`

**Interfaces:**
- Consumes: `buildEffectRegistry` (Task 2), `ObjectType` (`../types/typeHints.js`), `ANY_T` (`./primitives.js`).
- Produces: `handlerParamType(kinds: string[], registry: Record<string, ObjectType>): VariableType` — a single `objectType` member when `kinds.length === 1`, else a `unionType` of one member per kind. Member: `{ effect: <string literal>, data: registry[kind] ?? any, message: any, origin: any }`.
- Produces: `refineInlineHandlerParams(scopes, interruptEffectsByFunction, ctx, registry)` — the H1 pass, 4-arg positional, passing `registry` through. **Eligibility loop unchanged** (the `bodyHasNestedHandle`, explicit-annotation, and name-collision guards all remain — they gate WHICH params get retyped, orthogonal to WHAT type they get).

Note: this task changes the type-builder + threads the registry but does **not** reorder the pipeline. Between Task 3 and Task 4, `refineInlineHandlerParams` still runs at 6d-bis (after `checkScopes`), so the new `data` typing reaches only `checkMatchExhaustiveness` — payload *usage* narrowing does not fire until Task 4. Keep the memo-reset for now (Task 4 removes it).

- [ ] **Step 1: Write the failing test — the union drives B2 exhaustiveness on `match (e)`**

The discriminated-object-union arm syntax is `{ effect: "kind" } => …` (verified: `docs/site/guide/pattern-matching.md:212`, `handlers.md:304`). This asserts the retyped param is a real discriminated union (multiple members, `effect` discriminant), which the H1 flat shape (`data: any`) does not change but the discriminant detection (B2 `findDiscriminant` on `effect`) must accept. Add to `handlerParamTyping.test.ts`:

```ts
it("types e as a discriminated union so match(e) checks B2 exhaustiveness", () => {
  const warnings = warningsFrom(`
effect payl::a { x: number }
effect payl::b { y: string }
def risky() { raise payl::a("a", { x: 1 })\n raise payl::b("b", { y: "s" }) }
node main() {
  handle { risky() } with (e) {
    match (e) {
      { effect: "payl::a" } => 1
    }
  }
}`);
  // match(e) over the 2-member discriminated union is non-exhaustive: missing payl::b.
  expect(warnings.some((w) => /not exhaustive/i.test(w.message) && /payl::b/.test(w.message))).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm exec vitest run lib/typeChecker/handlerParamTyping.test.ts 2>&1 | tee /tmp/h3-t3-before.txt`
Expected: the new test FAILS (today `handlerParamType` returns a single flat object, so `match (e)` sees no per-member discriminant to enumerate).

- [ ] **Step 3: Rewrite `handlerParamType` to build the discriminated union**

In `handlerParamTyping.ts`, add the import and rewrite:

```ts
import type { ObjectType } from "../types/typeHints.js";

/**
 * The type of an inline handler param whose body raises `kinds`, as a
 * DISCRIMINATED UNION: one member per effect kind,
 *   { effect: "<kind>", data: <declared payload | any>, message: any, origin: any },
 * matching the runtime interrupt object (interrupts.ts). The `effect` literal is
 * the discriminant, so `if (e.effect == "<kind>")` / `match (e)` narrows `e` to a
 * single member whose `data` carries that effect's declared payload — H3 payload
 * safety falls out of discriminated-union narrowing (D1) + member-path narrowing
 * (M2). A single kind is a single member (no union wrapper). An effect with no
 * registry entry (undeclared or dropped as conflicting) gets `data: any`.
 */
function handlerParamType(kinds: string[], registry: Record<string, ObjectType>): VariableType {
  const member = (kind: string): VariableType => ({
    type: "objectType",
    properties: [
      { key: "effect", value: stringLiteral(kind) },
      { key: "data", value: registry[kind] ?? ANY_T },
      { key: "message", value: ANY_T },
      { key: "origin", value: ANY_T },
    ],
  });
  return kinds.length === 1 ? member(kinds[0]) : { type: "unionType", types: kinds.map(member) };
}
```

Update `refineInlineHandlerParams`'s signature to accept `registry: Record<string, ObjectType>` as the 4th positional param; change the declare call to `info.scope.declare(h.name, handlerParamType(kinds, registry));`. **Leave the eligibility loop and the memo-reset block untouched.**

- [ ] **Step 4: Update the H1 call site in `index.ts` so the project compiles**

`refineInlineHandlerParams` now needs a registry. **Temporary bridge** (Task 4 replaces this): build it inline at the existing 6d-bis call:
```ts
refineInlineHandlerParams(scopes, interruptEffectsByFunction, ctx, buildEffectRegistry(ctx));
```
Add `buildEffectRegistry` to the `./effectPayloadCheck.js` import. This rebuilds the registry a second time and would double-report conflicts, so **Tasks 3 and 4 land in one PR — do not ship between them.**

- [ ] **Step 5: Run handler-param + exhaustiveness tests**

Run: `pnpm exec vitest run lib/typeChecker/handlerParamTyping.test.ts lib/typeChecker/matchExhaustiveness.test.ts 2>&1 | tee /tmp/h3-t3-after.txt`
Expected: the new B2 test PASSES; all existing H1 `match (e.effect)` tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker/handlerParamTyping.ts lib/typeChecker/handlerParamTyping.test.ts lib/typeChecker/index.ts
git commit -F /tmp/h3-t3-msg.txt
```
`/tmp/h3-t3-msg.txt`:
```
feat(typechecker): type handler param as a per-effect discriminated union

handlerParamType now returns a discriminated union — one member per raisable
effect kind carrying that effect's declared payload as `data` (discriminant =
the `effect` string literal) — instead of a single flat object with `data: any`.
Exhaustiveness (B1 on e.effect, B2 on e) still works; payload narrowing is wired
in the following commit (pipeline reorder). Eligibility (nested-handle,
annotation, name-collision guards) is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 4: The pipeline reorder — payload narrowing at usage sites

**Files:**
- Modify: `lib/typeChecker/index.ts`
- Modify: `lib/typeChecker/handlerParamTyping.ts` (remove the memo reset)
- Test: `lib/typeChecker/handlerParamTyping.test.ts` (payload-narrowing e2e)

**Interfaces:**
- Consumes: `analyzeInterruptsFromScopes`, `buildEffectRegistry`, `refineInlineHandlerParams(…, registry)`, `checkEffectPayloads(…, registry)`.
- Produces: a pipeline where `e` is a payload-typed discriminated union during `checkScopes`.

- [ ] **Step 1: Write the failing payload-narrowing e2e tests**

Add to `handlerParamTyping.test.ts` (durable versions of the spike):

```ts
describe("handler param payload typing (H3)", () => {
  it("errors on a payload-shape mismatch after narrowing on e.effect", () => {
    const errs = errorsFrom(`
effect h3::deposit { amount: number }
def takesString(s: string): string { return s }
def risky() { raise h3::deposit("d", { amount: 1 }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3::deposit") { takesString(e.data.amount) }
  }
}`);
    expect(errs.some((x) => x.severity === "error")).toBe(true);
  });

  it("accepts a correctly-typed payload use after narrowing", () => {
    const errs = errorsFrom(`
effect h3::deposit { amount: number }
def takesNum(n: number): number { return n }
def risky() { raise h3::deposit("d", { amount: 1 }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3::deposit") { takesNum(e.data.amount) }
  }
}`);
    expect(errs.filter((x) => x.severity === "error")).toEqual([]);
  });

  it("still refines e.effect for exhaustiveness (H1 regression)", () => {
    const warnings = warningsFrom(`
effect h3::a { }
effect h3::b { }
def risky() { raise h3::a("a", {})\n raise h3::b("b", {}) }
node main() {
  handle { risky() } with (e) {
    match (e.effect) { "h3::a" => 1 }
  }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message) && /h3::b/.test(w.message))).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect the two payload tests to FAIL (retype still after checkScopes)**

Run: `pnpm exec vitest run lib/typeChecker/handlerParamTyping.test.ts 2>&1 | tee /tmp/h3-t4-before.txt`
Expected: "errors on a payload-shape mismatch" FAILS (`e.data` still `any` at usage).

- [ ] **Step 3: Apply the reorder in `index.ts`**

Replace the steps 3b–4 region; move `analyzeInterruptsFromScopes`, a single `buildEffectRegistry`, and `refineInlineHandlerParams` before `buildFlowGraphs`; delete the 6d-bis call and Task-3's temporary inline registry; pass the shared `registry` into `checkEffectPayloads`:

```ts
    // 3. Build scopes (collects variable types and checks assignments)
    const scopes = buildScopes(ctx);

    // 3a. Analyze interrupts (pure — returns transitive effect sets, pushes no
    // diagnostics; the ctx.errors sites in interruptAnalysis.ts belong to the
    // consumer passes below). Moved ahead of flow/checkScopes so the handler-param
    // refinement can run before field-access checking.
    const interruptEffectsByFunction = analyzeInterruptsFromScopes(scopes, ctx);

    // 3b. Build the ambient effect→payload registry ONCE and share it with both
    // the handler-param refinement (below) and checkEffectPayloads (6d). Building
    // it once avoids double-reporting payload conflicts.
    const effectRegistry = buildEffectRegistry(ctx);

    // 3c. H3: re-type each eligible inline handler param `e` as a per-effect
    // discriminated union carrying that effect's declared payload as `data`.
    // MUST run before checkScopes so `e.data` usage sites narrow correctly.
    refineInlineHandlerParams(scopes, interruptEffectsByFunction, ctx, effectRegistry);

    // 3d. Build the flow graph AFTER the param retype, so its typeAt oracle is
    // seeded with the refined `e` (no stale-memo reset needed).
    buildFlowGraphs(scopes, ctx);

    // 4. Check function calls, return types, and expressions. `e.data` is now
    // payload-typed → narrowing on `e.effect` makes `e.data` concrete here.
    checkScopes(scopes, ctx);

    // 5a. Build the per-function interrupt call graph (structural info for
    // `agency interrupts`). Independent of the retype above.
    const interruptCallGraph = buildInterruptCallGraph(scopes, ctx);

    // 6. Unhandled-interrupt warnings (consume the transitive results from 3a).
    checkUnhandledInterruptWarnings(scopes, interruptEffectsByFunction, ctx);

    // 6a. Reject `interrupt` inside any callback body.
    checkCallbackBodyInterrupts(scopes, interruptEffectsByFunction, ctx);

    // 6b. Reject handlers whose body may itself raise an interrupt.
    checkHandlerBodyInterrupts(scopes, interruptEffectsByFunction, ctx);

    // 6c. Verify declared `raises` clauses.
    checkRaisesDeclarations(interruptEffectsByFunction, ctx);

    // 6d. Check interrupt payloads against `effect` declarations (shared registry).
    checkEffectPayloads(scopes, ctx, effectRegistry);

    // 6e. Match exhaustiveness over closed value types.
    checkMatchExhaustiveness(scopes, ctx);
```

Preserve whatever the current code does with `interruptCallGraph` (e.g. a `void interruptCallGraph;` or a later consumer) — do not introduce an unused-var lint error.

- [ ] **Step 4: Remove the now-unnecessary memo reset in `handlerParamTyping.ts`**

The flow graph is now built *after* the retype, so no stale `typeAt` memo exists. Delete the trailing block:
```ts
  // DELETE — flow graph is built after this pass now:
  // if (changed && ctx.flowEnv) ctx.flowEnv.memo = new WeakMap();
```
Drop the now-unused `changed` accumulator if nothing else reads it. Update the pass docstring: it now runs **before** `checkScopes`, so re-typing `e` to a closed object DOES make `e.<unknown-field>` a "does not exist" error during `checkScopes` (the opposite of H1's old note) — intended (the interrupt object has exactly `{effect, message, data, origin}`).

- [ ] **Step 5: Run H3 tests + the full interrupt/exhaustiveness regression set**

Run: `pnpm exec vitest run lib/typeChecker/handlerParamTyping.test.ts lib/typeChecker/matchExhaustiveness.test.ts lib/typeChecker/interruptWarnings.test.ts lib/typeChecker/handlerBodyInterrupts.test.ts lib/typeChecker/callbackBodyInterrupts.test.ts lib/typeChecker/effectPayloadCheck.test.ts lib/typeChecker/interruptAnalysis.test.ts lib/typeChecker/interruptCallGraph.test.ts 2>&1 | tee /tmp/h3-t4-after.txt`
Expected: all PASS. The interrupt-check suites confirm moving `analyzeInterruptsFromScopes` earlier changed no diagnostics (their inputs are unchanged). **If any interrupt-warning error-ORDER assertion regresses, that surfaces the Concern-4 registry-ordering risk — investigate before proceeding.**

- [ ] **Step 6: Run the full typeChecker unit suite**

Run: `pnpm exec vitest run lib/typeChecker 2>&1 | tee /tmp/h3-t4-unit.txt`
Expected: PASS. Compare against `/tmp/h3-spike-unit.txt` — every newly-failing test must be an intentional `any`→typed flip (fixed in Task 5). A regression the spike did not predict → STOP and reassess.

- [ ] **Step 7: Commit**

```bash
git add lib/typeChecker/index.ts lib/typeChecker/handlerParamTyping.ts lib/typeChecker/handlerParamTyping.test.ts
git commit -F /tmp/h3-t4-msg.txt
```
`/tmp/h3-t4-msg.txt`:
```
feat(typechecker): payload-safe handler params via pipeline reorder (H3)

Move interrupt analysis + the effect→payload registry + the handler-param
refinement ahead of buildFlowGraphs/checkScopes, so an inline handler's `e`
carries its per-effect discriminated-union type DURING field-access checking.
`if (e.effect == "...")` now narrows `e.data` to that effect's declared payload,
making payload misuse a type error. The flow graph is built after the retype, so
the stale-memo reset is gone. Interrupt-check diagnostics are unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 5: Edge-case tests, blast-radius fixes, docs, and final gate

**Files:**
- Modify: whatever tests/fixtures the spike/Task-4 sweep flagged as legitimate `any`→typed flips.
- Test: `lib/typeChecker/handlerParamTyping.test.ts` (edge cases + idioms + limitation).
- Docs: `docs/site/guide/handlers.md`, `handler-narrowing-spec.md`.

**Interfaces:** none new.

- [ ] **Step 1: Fix the legitimate blast-radius test flips**

For each test in `/tmp/h3-t4-unit.txt` that asserted the OLD `e.data: any` / unknown-field-allowed behavior, update it to the payload-typed expectation (mirror H1's flipped "unknown field errors" precedent). Re-run each fixed file with `tee`. Do NOT weaken a test to hide a genuine regression — surface it.

- [ ] **Step 2: Edge-case + idiom tests**

Add to `handlerParamTyping.test.ts`:

```ts
describe("H3 edge cases", () => {
  // Member-path idiom: narrow per branch, read e.data inline. Sidesteps the
  // accepted same-name-binder flat-scope limitation.
  it("member-path narrowing gives each branch its own payload", () => {
    const errs = errorsFrom(`
effect h3i::a { n: number }
effect h3i::b { s: string }
def takesNum(n: number): number { return n }
def takesStr(s: string): string { return s }
def risky() { raise h3i::a("a", { n: 1 })\n raise h3i::b("b", { s: "x" }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3i::a") { takesNum(e.data.n) }
    if (e.effect == "h3i::b") { takesStr(e.data.s) }
  }
}`);
    expect(errs.filter((x) => x.severity === "error")).toEqual([]);
  });

  // Guarded else: after `if (e.effect == "a")`, the else branch must NOT keep
  // e.data as a's payload — reading a's field there must error (whether e
  // narrows to the remaining union or stays the full union, a's field is absent
  // from at least one member → error).
  it("does not leak the narrowed payload into the else branch", () => {
    const errs = errorsFrom(`
effect h3e::a { n: number }
effect h3e::b { s: string }
def takesNum(n: number): number { return n }
def risky() { raise h3e::a("a", { n: 1 })\n raise h3e::b("b", { s: "x" }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3e::a") { takesNum(e.data.n) } else { takesNum(e.data.n) }
  }
}`);
    expect(errs.some((x) => x.severity === "error")).toBe(true);
  });

  // Empty-payload effect: e.data is the empty object → accessing a field errors.
  it("errors accessing a field on an empty-payload effect's data", () => {
    const errs = errorsFrom(`
effect h3p::ping { }
def risky() { raise h3p::ping("p", {}) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3p::ping") { let x = e.data.nope }
  }
}`);
    expect(errs.some((x) => x.severity === "error")).toBe(true);
  });

  // Conflicting declarations → the effect is DROPPED from the registry → its
  // data falls back to `any` → field access is permitted (no derivative error).
  it("falls back to any for an effect dropped as conflicting", () => {
    const errs = errorsFrom(`
effect h3c::e { a: number }
effect h3c::e { a: string }
def risky() { raise h3c::e("c", { a: 1 }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3c::e") { let x = e.data.anything }
  }
}`);
    // Exactly the one conflict diagnostic; no "field does not exist" on e.data.
    expect(errs.some((x) => /does not exist/i.test(x.message))).toBe(false);
  });

  // Nested handle → outer param stays untyped (eligibility guard preserved), so
  // e.data field access is unconstrained (no payload error).
  it("leaves the outer param untyped when the body contains a nested handle", () => {
    const errs = errorsFrom(`
effect h3n::a { n: number }
effect h3n::b { s: string }
def risky() { raise h3n::a("a", { n: 1 }) }
def inner() { raise h3n::b("b", { s: "x" }) }
node main() {
  handle {
    risky()
    handle { inner() } with (f) { let y = f.data }
  } with (e) {
    let z = e.data.whatever
  }
}`);
    expect(errs.some((x) => /does not exist/i.test(x.message))).toBe(false);
  });

  // functionRef handler → not an inline param → never retyped by this pass.
  it("does not retype a functionRef handler's param", () => {
    const errs = errorsFrom(`
effect h3f::a { n: number }
def risky() { raise h3f::a("a", { n: 1 }) }
def onEffect(e: any): number { return 0 }
node main() {
  handle { risky() } with onEffect
}`);
    expect(errs.filter((x) => x.severity === "error")).toEqual([]);
  });

  // Recursive raise: the transitive raisable set still reaches the handler, so
  // e.data narrows to the payload.
  it("narrows payload for an effect raised transitively through recursion", () => {
    const errs = errorsFrom(`
effect h3r::a { n: number }
def recur(k: number) { if (k > 0) { recur(k - 1) } else { raise h3r::a("a", { n: 1 }) } }
def takesString(s: string): string { return s }
node main() {
  handle { recur(3) } with (e) {
    if (e.effect == "h3r::a") { takesString(e.data.n) }
  }
}`);
    // e.data.n is number, takesString wants string → error.
    expect(errs.some((x) => x.severity === "error")).toBe(true);
  });
});
```

If the `functionRef` handler arm syntax (`with onEffect`) differs from what parses, confirm with `pnpm run ast` on a scratch file and adjust the arm to the parsing form; the assertion (param untouched → no error) is what matters.

- [ ] **Step 3: The flat-scope limitation test — measured, not guessed**

First measure the current behavior with a scratch file, THEN assert it. Create `/tmp/h3-limitation-probe.agency`:
```agency
effect h3l::a { n: number }
effect h3l::b { s: string }
def risky() { raise h3l::a("a", { n: 1 })\n raise h3l::b("b", { s: "x" }) }
node main() {
  handle { risky() } with (e) {
    match (e) {
      { effect: "h3l::a" } => e.data.n
      { effect: "h3l::b" } => e.data.s
    }
  }
}
```
Run `pnpm run compile /tmp/h3-limitation-probe.agency` (or the test harness) and record whether `e.data.n` / `e.data.s` in the arms each narrow to their member (works), or collide (the accepted flat-scope limitation). Then add ONE test asserting that exact measured outcome, with a comment: `// Flat-scope limitation (PR3-accepted): same-name binders across arms share the function scope. Workaround: member-path idiom (see above).` If the measured outcome is "both narrow correctly," the limitation does not bite here and the comment says so. **Do not commit an assertion you have not run.**

- [ ] **Step 4: Run the handler-param file**

Run: `pnpm exec vitest run lib/typeChecker/handlerParamTyping.test.ts 2>&1 | tee /tmp/h3-t5-edge.txt`
Expected: PASS.

- [ ] **Step 5: Update docs**

- `docs/site/guide/handlers.md`: the paragraph ending "per-effect payload typing on `e.data` is a later addition" → describe the shipped behavior: `e` is a per-effect discriminated union; `e.data` is that effect's declared payload after narrowing on `e.effect` (via `if`/`match`); an undeclared/conflicting effect's `data` stays untyped; the conservative cases (annotated param, functionRef handler, nested handle) still opt out.
- `handler-narrowing-spec.md` (repo root): mark H3 implemented; note the reorder + closed-object strictness + the same-name-binder flat-scope limitation.

- [ ] **Step 6: Structural lint + full typeChecker suite (final gate)**

Run: `pnpm run lint:structure 2>&1 | tee /tmp/h3-t5-lint.txt`
Run: `pnpm exec vitest run lib/typeChecker 2>&1 | tee /tmp/h3-t5-unit.txt`
Expected: both clean/PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -F /tmp/h3-t5-msg.txt
```
`/tmp/h3-t5-msg.txt`:
```
test(typechecker): H3 edge cases + limitation; docs; blast-radius flips

Add member-path/guarded-else/empty-payload/conflicting-drop/nested-handle/
functionRef/recursive-raise tests, a measured flat-scope-limitation test,
update handlers.md + handler-narrowing-spec, and flip the tests that asserted
the pre-H3 `e.data: any` behavior.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Self-Review

**Spec coverage** (against `handler-narrowing-spec.md` H3 = "A-rich: discriminated-effect-union param typing, payload per arm"):
- Per-effect `data` payload typing → Task 3 (`handlerParamType` union) + Task 4 (reorder makes it reach usage). ✓
- "Folds into discriminated-union narrowing" → reuses D1/M2/B2, no bespoke code; proven by payload-narrowing e2e (Task 4) + member-path/guarded-else tests (Task 5). ✓
- Exhaustiveness preserved → B1 (`match (e.effect)`, Task 4 Step 1) + B2 (`match (e)`, Task 3 Step 1). ✓
- Payload conflicts reported once → Task 2; conflicting effect dropped → `data: any` test (Task 5). ✓
- Conservative opt-outs (annotation, functionRef, nested handle) preserved → eligibility loop untouched + nested-handle/functionRef tests (Task 5). ✓

**Review blockers:** (1) nested-handle guard — resolved (eligibility loop untouched + test). (2) match-arm syntax hedge — resolved (verified `{ effect: "..." }` form). (3) portable paths — done. Concerns 3/4/5/6/7/8 — addressed in Revisions + Tasks 4-5.

**Placeholder scan:** every code step shows real code; every run step has an exact command + expected result. Task 5 Step 3 deliberately measures-then-asserts (with an exact procedure) rather than hardcoding an unknown outcome — that is intentional, not a placeholder.

**Type consistency:** `buildEffectRegistry(ctx): Record<string, ObjectType>` (Task 2) consumed identically in Tasks 3–4. `handlerParamType(kinds: string[], registry: Record<string, ObjectType>): VariableType` (Task 3) used identically in Task 4. `refineInlineHandlerParams(scopes, interruptEffectsByFunction, ctx, registry)` — 4-arg positional — defined Task 3, called with `effectRegistry` in Task 4. `checkEffectPayloads(scopes, ctx, registry?)` (Task 2) called with the shared registry in Task 4. Consistent.

**Risk note:** feasibility rests on Task 1's spike. If narrowing does not fire, or the closed-object blast radius is large, the plan pauses at Task 1 Step 8 for a user decision — Tasks 2–5 assume GO.
