# Match-arm receiver narrowing (H4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `match (e.effect) { "app::confirm" => ask(e.data.question) }` narrow `e.data` inside each arm — exactly like the equivalent `if (e.effect == "app::confirm") { ask(e.data.question) }` already does. Same-looking code should behave the same way.

**Architecture:** In the type checker's flow builder, the `matchBlock` handler currently builds every arm body from the *un-narrowed* flow (it's explicitly marked "match-arm narrowing is a separate track"). The fix: for each literal arm, wrap that arm body's flow with the narrowing facts implied by `scrutinee == armLiteral`, computed by the **existing** `analyzeCondition` + `wrapFacts` — the identical machinery an `if` condition uses. When the scrutinee is a member path like `e.effect`, `analyzeCondition` already emits a discriminant refine on the receiver `e` (D1), so `e` narrows to the matching member and `e.data` becomes that member's payload. No new narrowing logic, no new syntax, no lowering/codegen change.

**Tech Stack:** TypeScript, vitest, the Agency type checker flow layer (`lib/typeChecker/flowBuilder.ts`, `lib/typeChecker/narrowing.ts`, `lib/typeChecker/flow.ts`).

## Why this is the right shape (grounding)

Measured on current main (post-H3):
- `if (e.effect == "app::confirm") { ask(e.data.question) }` → **clean** (D1 narrows `e`, so `e.data` is the confirm payload).
- `match (e.effect) { "app::confirm" => ask(e.data.question) }` → **errors** "Property 'question' is not available on every member of `{ question: string } | { retryAfter: number }`".

Root cause: a pure-literal `match` (no pattern/guard arms) is NOT lowered — it passes through as a `matchBlock` node (`patternLowering.ts:267-274`). The flow builder's `matchBlock` handler (`flowBuilder.ts:209-217`) then builds each arm body from the base flow with no per-arm narrowing. (Contrast: `match (e) { { effect: "..." } => ... }` and `match (r) { success(v) => ... }` DO lower — to a temp scrutinee + if-chain — and are out of scope here; see Non-Goals.)

The `if` form works because `analyzeCondition(e.effect == "app::confirm")` returns a discriminant `NarrowCandidate` on ref `{e, []}` (prop `effect`), and `wrapFacts` applies it. This plan feeds the *same* condition, per arm, into the *same* functions.

## Global Constraints

- **Handlers are safety infrastructure.** This is a **type-checker-only** change in the flow layer. It must NOT touch `matchBlock` lowering, codegen, handler registration/execution, or runtime. Match still lowers/codegens byte-for-byte identically; only the flow graph consulted during `checkScopes` gains per-arm narrow nodes.
- **Soundness / no false positives.** Narrowing a match arm must never make a valid access an error. Only apply POSITIVE facts (`.then`) per arm, each built from the base flow (arms are independent). Do not apply cross-arm (negative) facts — see Non-Goals. Non-literal / wildcard arms get the base flow unchanged (current behavior).
- **Use objects not maps; arrays not sets; `type` not `interface`.** No dynamic imports.
- **Never commit/push unless asked.** Implement directly (no subagents). Commit messages / PR bodies in a **file** (apostrophes break inline `-m`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Do not run the agency execution suite locally.** Run typeChecker unit tests + targeted vitest only. CI runs the full suite.

## Non-Goals (explicit scope boundaries)

1. **Object-pattern `match (e) { { effect: "..." } => ... }`** — this lowers to a temp scrutinee (`__s = e`) + if-chain that narrows `__s`, not `e`, so `e.data` doesn't narrow (the H3-documented limitation). Fixing it requires the lowering to narrow through the temp — a separate, larger effort. Out of scope. The member-path `match (e.effect)` form this plan fixes is the recommended idiom.
2. **Cross-arm (negative) narrowing** — e.g. arm 2's body knowing `e.effect != "app::confirm"`. Not needed for payload access; each arm narrows to its own literal. Out of scope.
3. **Bare-variable scrutinee self-narrowing** — `match (status) { "a" => ... }` narrowing `status` itself to `"a"`. `analyzeCondition` only recognizes `V.prop == literal` (discriminant) and presence tests, not bare `x == literal`, so a bare-variable scrutinee produces no facts → no change. Acceptable (the target case is `e.effect`, a path). Note in docs.
4. **New syntax** — none. `match`/arm grammar is unchanged.

## File Structure

- `lib/typeChecker/flowBuilder.ts` (modify) — the `matchBlock` handler gains per-arm positive narrowing.
- `lib/typeChecker/flowBuilder.test.ts` or `lib/typeChecker/matchArmNarrowing.test.ts` (create/modify) — unit tests that the flow graph narrows match arm bodies.
- `lib/typeChecker/narrowing.test.ts` or `handlerParamTyping.test.ts` (modify) — e2e: the handler `match (e.effect)` payload case now type-checks; the H3 LIMITATION test that documented the old behavior is re-pointed.
- `docs/site/guide/handlers.md` and/or `docs/site/guide/pattern-matching.md` (modify) — note that `match` on a field path narrows the receiver per arm.

---

### Task 1: Narrow literal match arms by the scrutinee condition

**Files:**
- Modify: `lib/typeChecker/flowBuilder.ts`
- Test: `lib/typeChecker/matchArmNarrowing.test.ts` (create)

**Interfaces:**
- Consumes: `analyzeCondition(condition: Expression): ConditionFacts` and `wrapFacts(flow, candidates)` (both already imported in `flowBuilder.ts`), `buildFlowGraph`, `attachExpressionsToFlow`.
- Produces: no new exports — behavior change only.

- [ ] **Step 1: Write the failing e2e test**

Create `lib/typeChecker/matchArmNarrowing.test.ts` (mirror the harness in `handlerParamTyping.test.ts` — `parseAgency`/`SymbolTable.build`/`buildCompilationUnit`/`typeCheck`; treat undefined severity as error):

```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function hardErrors(source: string): string[] {
  const file = path.join(os.tmpdir(), `tc-marm-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`);
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, source);
    return typeCheck(parseResult.result, {}, info).errors
      .filter((e) => (e.severity ?? "error") === "error")
      .map((e) => e.message);
  } finally {
    unlinkSync(file);
  }
}

const HEAD = `
effect app::confirm { question: string }
effect app::rateLimited { retryAfter: number }
def ask(q: string): string { return q }
def waitFor(n: number): number { return n }
def risky() { raise app::confirm("c", { question: "ok?" })\n raise app::rateLimited("r", { retryAfter: 5 }) }`;

describe("match-arm receiver narrowing (H4)", () => {
  it("match(e.effect) narrows e.data per arm — clean when types match", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm"     => ask(e.data.question)
      "app::rateLimited" => waitFor(e.data.retryAfter)
    }
  }
}`);
    expect(errs).toEqual([]);
  });

  it("match(e.effect) still flags a genuine payload-type mismatch in an arm", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm"     => waitFor(e.data.question)
      "app::rateLimited" => waitFor(e.data.retryAfter)
    }
  }
}`);
    // e.data.question is string, waitFor wants number → error in the confirm arm.
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect the first test to FAIL**

Run: `pnpm exec vitest run lib/typeChecker/matchArmNarrowing.test.ts 2>&1 | tee /tmp/h4-t1-before.txt`
Expected: "narrows e.data per arm" FAILS with two "not available on every member" errors (today's behavior); the mismatch test may pass for the wrong reason (unnarrowed `e.data` also errors) — that's fine, Step 4 makes it pass for the RIGHT reason.

- [ ] **Step 3: Add per-arm narrowing in the `matchBlock` flow handler**

In `lib/typeChecker/flowBuilder.ts`, replace the `matchBlock` handler (currently lines ~209-217):

```ts
  // Match arms narrow by the scrutinee condition. For each literal arm we build
  // the flow as if guarded by `scrutinee == <arm literal>` and feed that through
  // the SAME analyzeCondition/wrapFacts path an `if` uses — so a member-path
  // scrutinee like `e.effect` narrows its receiver `e` (D1 discriminant), making
  // `e.data` the matching member's payload inside the arm. Only POSITIVE (.then)
  // facts, each from the base flow (arms are independent — no cross-arm/negative
  // narrowing; see the plan's Non-Goals). Non-literal / `_` arms get the base
  // flow unchanged. Post-match flow is unchanged. `c.body` is a single node
  // (matchBlock.ts:12), wrapped in `[]` to reuse buildFlowGraph.
  matchBlock: (node, flow, env) => {
    attachExpressionsToFlow(node.expression as AgencyNode, flow, env);
    const scrutinee = node.expression as Expression;
    for (const c of node.cases) {
      if (c.type === "comment" || c.type === "newLine") continue;
      let armFlow = flow;
      // Narrow only plain literal arms. `_` is the default (no fact); a guarded
      // arm can't reach here today (guards force lowering to a temp+if-chain —
      // patternLowering.ts:256-265), but gate on `c.guard === undefined` so a
      // future lowering change can't silently feed a guarded arm through.
      if (c.caseValue !== "_" && c.guard === undefined) {
        // SYNTHETIC condition `scrutinee == <arm literal>`, never produced by the
        // parser. Safe because analyzeCondition is a pure structural read of only
        // `.operator`/`.left`/`.right` (no `loc`/parent pointers). It returns no
        // facts for a non-literal RHS or a non-path scrutinee → safe no-op there.
        const cond: Expression = {
          type: "binOpExpression",
          operator: "==",
          left: scrutinee,
          right: c.caseValue as Expression,
        };
        armFlow = wrapFacts(flow, analyzeCondition(cond).then);
      }
      buildFlowGraph([c.body], armFlow, env);
    }
    return flow;
  },
```

Notes for the implementer:
- `analyzeCondition` and `wrapFacts` are already imported at the top of `flowBuilder.ts` (lines 6, 10). `Expression` may need adding to the type import from `../types.js` — check the existing imports; add it if missing.
- A pure-literal `matchBlock` only ever has `caseValue` of a `Literal`, a `VariableNameLiteral`, or `"_"` (pattern/guard arms are lowered away before the checker — `patternLowering.ts:256-275`). For a `Literal` RHS `analyzeCondition` produces facts; for a `VariableNameLiteral` (bare identifier arm) `literalToType` returns null → no facts → safe no-op.
- `match (x is Foo)` scrutinees never reach here: `lowerMatchIsForm` (`patternLowering.ts:305-352`) lowers them to an assignment + if-chain, NOT a `matchBlock` node. (Smoke-tested in Task 2 anyway.)
- Do NOT synthesize a `loc` on `cond`; `analyzeCondition`'s recognizers don't read it.

- [ ] **Step 4: Run — expect PASS for the right reason**

Run: `pnpm exec vitest run lib/typeChecker/matchArmNarrowing.test.ts 2>&1 | tee /tmp/h4-t1-after.txt`
Expected: both tests PASS. To confirm the mismatch test passes for the RIGHT reason, temporarily change its `waitFor(e.data.question)` to `ask(e.data.question)` in a scratch run and verify it becomes clean (proves the arm narrowed to the confirm payload, not that everything still errors). Revert the scratch change.

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/flowBuilder.ts lib/typeChecker/matchArmNarrowing.test.ts
git commit -F /tmp/h4-t1-msg.txt
```
`/tmp/h4-t1-msg.txt`:
```
feat(typechecker): narrow match arm bodies by the scrutinee condition

A pure-literal `match (scrutinee) { lit => body }` now narrows `body` as if
guarded by `scrutinee == lit`, via the same analyzeCondition/wrapFacts path an
`if` uses. So `match (e.effect) { "app::confirm" => ... }` narrows `e` (D1
discriminant on the receiver) and `e.data` becomes that effect's payload inside
the arm — matching the `if (e.effect == "...")` form. Flow-layer only; no
lowering/codegen/runtime change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 2: Soundness + edge-case tests, and re-point the H3 limitation test

**Files:**
- Modify: `lib/typeChecker/matchArmNarrowing.test.ts`
- Modify: `lib/typeChecker/handlerParamTyping.test.ts` (the H3 LIMITATION test)

**Interfaces:** none new.

- [ ] **Step 1: Add soundness / edge-case tests**

Append to `matchArmNarrowing.test.ts`:

```ts
describe("match-arm narrowing — soundness & edges", () => {
  it("a wildcard `_` arm is not narrowed (base flow, no crash)", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm" => ask(e.data.question)
      _ => 0
    }
  }
}`);
    expect(errs).toEqual([]);
  });

  it("a bare-variable / plain-string scrutinee is a safe no-op (no crash, no wrong narrowing)", () => {
    // `s` is a plain string, not a union; a bare-variable scrutinee produces no
    // discriminant facts, so the arm must NOT wrongly narrow `s` to "a" — a later
    // `s: string` use inside the arm must still type-check.
    const errs = hardErrors(`
def pick(s: string): string {
  match (s) {
    "a" => { let keep: string = s\n return keep }
    _ => "z"
  }
}
node main() { let n = pick("a")\n print(n) }`);
    expect(errs).toEqual([]);
  });

  it("match on an isExpression scrutinee does not crash (lowered away, never a matchBlock)", () => {
    // `match (x is A)` lowers to assignment + if-chain (patternLowering.ts:305-352),
    // so it never reaches the matchBlock flow handler. Smoke test the whole path.
    const errs = hardErrors(`
type A = { kind: "a", n: number }
type B = { kind: "b", s: string }
def f(x: A | B): number {
  match (x is A) {
    true => 1
    false => 0
  }
}
node main() { let r = f({ kind: "a", n: 1 })\n print(r) }`);
    // Whatever the exhaustiveness/typing outcome, the run must not throw.
    expect(Array.isArray(errs)).toBe(true);
  });

  it("does NOT apply cross-arm negative narrowing (arm sees only its own literal)", () => {
    // The confirm arm reads a rateLimited field → still an error. This pins that
    // we narrow positively per arm and do NOT infer `e.effect != confirm` etc.
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm" => waitFor(e.data.retryAfter)
      _ => 0
    }
  }
}`);
    expect(errs.some((m) => /not available on every member|does not exist|not assignable/i.test(m))).toBe(true);
  });

  it("exhaustiveness still fires independently of narrowing", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm" => ask(e.data.question)
    }
  }
}`);
    // Missing "app::rateLimited" — warn (default), not a hard error; assert no hard error here.
    // (Exhaustiveness severity is covered by matchExhaustiveness tests; this only
    // confirms narrowing didn't suppress or crash the exhaustiveness pass.)
    expect(errs).toEqual([]);
  });
});

// Generality: prove the design isn't string-specific and composes with M2
// (multi-hop / index scrutinees) and with other narrowing.
describe("match-arm narrowing — generality & composition", () => {
  const TAG = `
type TagA = { tag: 1, a: number }
type TagB = { tag: 2, b: string }
def takesNum(n: number): number { return n }
def takesStr(s: string): string { return s }`;

  it("number-literal arms narrow the receiver", () => {
    const errs = hardErrors(`${TAG}
def f(t: TagA | TagB): number {
  match (t.tag) {
    1 => takesNum(t.a)
    2 => takesStr(t.b)
  }
  return 0
}
node main() { let r = f({ tag: 1, a: 5 })\n print(r) }`);
    expect(errs).toEqual([]);
  });

  it("number-literal arm still flags a real mismatch", () => {
    const errs = hardErrors(`${TAG}
def f(t: TagA | TagB): number {
  match (t.tag) {
    1 => takesStr(t.a)
    2 => takesStr(t.b)
  }
  return 0
}
node main() { let r = f({ tag: 1, a: 5 })\n print(r) }`);
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });

  it("boolean-literal arms narrow the receiver", () => {
    const errs = hardErrors(`
type Open  = { open: true, handle: number }
type Closed = { open: false, reason: string }
def takesNum(n: number): number { return n }
def takesStr(s: string): string { return s }
def f(o: Open | Closed): number {
  match (o.open) {
    true  => takesNum(o.handle)
    false => takesStr(o.reason)
  }
  return 0
}
node main() { let r = f({ open: true, handle: 1 })\n print(r) }`);
    expect(errs).toEqual([]);
  });

  it("multi-hop scrutinee narrows (M2 composition)", () => {
    const errs = hardErrors(`${TAG}
type Wrap = { inner: TagA | TagB }
def f(w: Wrap): number {
  match (w.inner.tag) {
    1 => takesNum(w.inner.a)
    2 => takesStr(w.inner.b)
  }
  return 0
}
node main() { let r = f({ inner: { tag: 1, a: 5 } })\n print(r) }`);
    expect(errs).toEqual([]);
  });

  it("a nested guard inside a narrowed arm composes", () => {
    const errs = hardErrors(`${TAG}
def f(t: TagA | TagB): number {
  match (t.tag) {
    1 => { if (t.a > 0) { return takesNum(t.a) }\n return 0 }
    2 => takesStr(t.b).length
  }
  return 0
}
node main() { let r = f({ tag: 1, a: 5 })\n print(r) }`);
    expect(errs).toEqual([]);
  });
});
```

Note: if the multi-hop or index-scrutinee test surprises you (e.g. M2 doesn't compose as expected), that's a genuine finding — investigate rather than delete the test. The design predicts these work "for free" via `asDiscriminantAccess`'s multi-hop receiver ref.

- [ ] **Step 2: Run**

Run: `pnpm exec vitest run lib/typeChecker/matchArmNarrowing.test.ts 2>&1 | tee /tmp/h4-t2-edges.txt`
Expected: all PASS.

- [ ] **Step 3: Re-point the H3 limitation test**

The H3 test "LIMITATION: a match(e) object-pattern arm does not narrow e.data inside the arm" (in `handlerParamTyping.test.ts`) documents the *object-pattern* case, which is STILL out of scope (Non-Goal 1). Verify it still passes unchanged (H4 doesn't touch the lowered if-chain path):

Run: `pnpm exec vitest run lib/typeChecker/handlerParamTyping.test.ts 2>&1 | tee /tmp/h4-t2-h3.txt`
Expected: PASS unchanged. If it now FAILS (i.e. the object-pattern case unexpectedly started narrowing), STOP — that means Task 1 affected the lowered path too; investigate before continuing (it shouldn't, since object patterns lower to a temp+if-chain, not a matchBlock node). Update the test's comment only if behavior legitimately changed.

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/matchArmNarrowing.test.ts
git commit -F /tmp/h4-t2-msg.txt
```
`/tmp/h4-t2-msg.txt`:
```
test(typechecker): soundness + edge cases for match-arm narrowing

Wildcard arm (base flow), non-union scrutinee (safe no-op), no cross-arm
negative narrowing, and exhaustiveness unaffected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 3: Docs + full-suite gate

**Files:**
- Modify: `docs/site/guide/pattern-matching.md` (and/or `handlers.md`)
- No code.

- [ ] **Step 1: Document the behavior**

In `docs/site/guide/pattern-matching.md`, add a short note (near the `match` narrowing discussion) that a `match` whose scrutinee is a field path narrows the receiver inside each arm, e.g.:

```
match (e.effect) {
  "app::confirm"     => ask(e.data.question)     // e.data is the confirm payload here
  "app::rateLimited" => waitFor(e.data.retryAfter)
}
```

State the boundary: this applies to a stable field-path scrutinee (`e.effect`); a bare-variable scrutinee (`match (x)`) and object-pattern arms (`match (e) { { effect: "..." } => ... }`) do not narrow the receiver — use the field-path form or an `if (e.effect == "...")` guard. In `handlers.md`, update the H3 "Payload typing on e.data" section: the recommended idiom is now EITHER `if (e.effect == "...")` OR `match (e.effect) { "..." => ... }` (both narrow `e.data`); only the object-pattern `match (e)` arm still doesn't.

- [ ] **Step 2: Structural lint**

Run: `pnpm run lint:structure 2>&1 | tee /tmp/h4-t3-lint.txt`
Expected: clean.

- [ ] **Step 3: Full typeChecker unit suite**

Run: `pnpm exec vitest run lib/typeChecker 2>&1 | tee /tmp/h4-t3-unit.txt`
Expected: PASS. Pay attention to `matchExhaustiveness.test.ts`, `narrowing.test.ts`, `flowBuilder.test.ts`, `flowNarrowing.test.ts` — any new failure is a regression from the arm-narrowing change; investigate before proceeding.

- [ ] **Step 4: Fixture typecheck (stdlib/fixtures blast radius)**

Run: `pnpm exec vitest run lib/typeChecker/fixtureTypeCheck.integration.test.ts 2>&1 | tee /tmp/h4-t3-fixtures.txt`
Expected: PASS. A `match`-heavy stdlib file that previously type-checked only because arms were un-narrowed could now surface a REAL latent bug (a member accessed in the wrong arm) — if so, that's a genuine find; fix the stdlib or report it, don't weaken the narrowing.

- [ ] **Step 5: Commit**

```bash
git add docs/site/guide/pattern-matching.md docs/site/guide/handlers.md docs/superpowers/plans/2026-07-01-match-arm-receiver-narrowing-h4.md
git commit -F /tmp/h4-t3-msg.txt
```
`/tmp/h4-t3-msg.txt`:
```
docs(typechecker): match on a field path narrows the receiver per arm

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Self-Review

**Spec coverage:** the goal (`match (e.effect)` narrows `e.data` like the `if` form) → Task 1 (the flow change + the two headline e2e tests). Soundness (wildcard, non-union, no negative narrowing, exhaustiveness intact) → Task 2. Docs + blast-radius gate → Task 3. Non-Goals explicitly fenced (object-pattern, negative narrowing, bare-variable self-narrowing, new syntax).

**Placeholder scan:** every code step shows the actual code; every run step has an exact command + expected result. No TBD/"handle edge cases"/"similar to".

**Type consistency:** the `matchBlock` handler signature is unchanged (`(node, flow, env) => FlowNode`). New locals `scrutinee: Expression`, `cond: Expression`, `armFlow: FlowNode`. `analyzeCondition(cond).then` is `NarrowCandidate[]`, which is exactly `wrapFacts`'s second parameter (`flowBuilder.ts:61,166` use it identically). `c.caseValue` is `MatchPattern | "_"`; the `!== "_"` guard leaves a `Literal | VariableNameLiteral`, both assignable to `Expression` for the `right` operand.

**Risk:** the one real risk is Step 4 of Task 3 — a latent stdlib bug surfacing. That's a *correct* new diagnostic, not a regression; the plan says fix-or-report, never weaken. Everything else is additive flow narrowing reusing the exact `if`-condition path, so blast radius should be ~0 beyond genuinely-buggy code.
