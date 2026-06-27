# Result Type Narrowing (Increment 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen the narrowing guard surface so common Result idioms narrow: negated guards (`!isSuccess(r)`), conjunction/disjunction (`isSuccess(a) && isSuccess(b)`), and — the headline — **early-return guards** (`if (isFailure(r)) { return … }` narrows `r` to Success for the rest of the block).

**Architecture:** Extends the Increment 1 machinery without changing its shape. `analyzeCondition` becomes recursive over `binOpExpression` for `!` / `&&` / `||` (the parser desugars `!x` to a `binOpExpression`). `walkScopeBody`'s `ifElse` case gains *post-guard* narrowing: when one branch provably always exits (a `return`), the statements after the `if` run only on the other branch's condition, so they are walked in a child scope carrying the surviving facts. A new `alwaysExits` helper (conservative: `return` only) decides exhaustiveness.

**Tech Stack:** TypeScript, vitest, the Agency type checker (`lib/typeChecker/`). Tests use the existing `check()` harness in `narrowing.test.ts`.

## Global Constraints

- NEVER use dynamic imports. Use `type` aliases not `interface`. Objects over maps; arrays over sets *for data modeling* — but mirror the existing `new Set` membership-constant pattern in `synthesizer.ts`/`narrowing.ts` for new lookup constants. (CLAUDE.md)
- Patterns are lowered **before** the type checker runs (`lib/parser.ts:278`). The checker sees `if (isSuccess(r)) { const v = r.value; ... }`, never `isExpression`/`matchBlock`. Do not add pattern-node handling.
- `isSuccess` / `isFailure` are `RESERVED_FUNCTION_NAMES` (`resolveCall.ts:44-49`) — name matching is unambiguous; no `resolveCall` needed.
- These are vitest **unit** tests: `npx vitest run <path>`, NOT the agency execution runner.
- **Soundness is non-negotiable.** Every addition must be a false-negative-only (never false-positive) approximation, exactly as Increment 1. When unsure whether a construct exits or resumes, treat it as *not* exiting.
- Spec: `type-narrowing-spec.md` (repo root). This plan is **Increment 2**. Increment 1 is merged. The hard-error flip is Increment 3 and is explicitly out of scope here.
- **Verified AST facts (do not re-guess):**
  - `!x` desugars to `{ type: "binOpExpression", operator: "!", left: <bool true>, right: x }` (`parsers.ts:2332,2347`). The operand is `.right`.
  - `a && b` / `a || b` are `{ type: "binOpExpression", operator: "&&"|"||", left, right }` (`lib/types/binop.ts`).
  - `return e` is `{ type: "returnStatement", value }`. `raise` is `interruptStatement` (`viaRaise: true`) and **can resume** — so it is NOT an exit for narrowing purposes. `propagate` semantics are likewise excluded. Only `returnStatement` counts as an exit in Increment 2.
  - Merged Increment-1 signatures: `applyNarrowing(childScope, candidates, branchBody, typeAliases)` and `walkWithNarrowing<C>(parent, body, candidates, typeAliases, ctx, walk)`. The `scopes.ts` call sites pass `ctx.getTypeAliases()`.

## Deferred (NOT in this increment — recorded so the omission is deliberate)

- **Null/undefined + truthiness narrowing** (`if (x != null)`, `if (x)`): independent of Result, does not gate Increment 3. Its own future plan.
- **Member/alias-expression scrutinees** (`isSuccess(obj.field)`): requires keying narrowing on access paths rather than variable names — a substantially larger change, low payoff, not a gate. (Alias-*typed* variables — `let r: MyResult = …` — already narrow, via the Increment-1 `safeResolveType` fix in `applyNarrowing`.)
- **Conflicting-fact dedup** (`isSuccess(r) && isFailure(r)`): the impossible condition produces both facts; `applyNarrowing` applies them in order so the last wins. Harmless (dead code); not worth special-casing.

---

## File Structure

- **Modify** `lib/typeChecker/narrowing.ts` — make `analyzeCondition` recurse over `!`/`&&`/`||`; add the `alwaysExits` and `postGuardFacts` helpers.
- **Modify** `lib/typeChecker/scopes.ts` — convert `walkScopeBody`'s node loop to index-based; extend the `ifElse` case with post-guard narrowing.
- **Modify** `lib/typeChecker/narrowing.test.ts` — unit tests for the analyzer extensions, end-to-end tests for combinators and early-return narrowing.
- **Modify** `docs/dev/typechecker.md` — document the widened guard surface (folded into Task 2).

---

### Task 1: Boolean combinators and negation in `analyzeCondition`

`analyzeCondition` currently bails unless the condition is a `functionCall`. Make it recurse over `binOpExpression` for `!`, `&&`, `||` first. Pure function — fully unit-testable.

**Files:**
- Modify: `lib/typeChecker/narrowing.ts` (the `analyzeCondition` function)
- Test: `lib/typeChecker/narrowing.test.ts`

**Interfaces:**
- Consumes: existing `ConditionFacts` / `NarrowCandidate` types, existing `functionCall` base case.
- Produces: `analyzeCondition` now handles `!`/`&&`/`||`; same `(condition: Expression) => ConditionFacts` signature (unchanged).

- [ ] **Step 1: Write the failing unit tests**

Append to the `describe("analyzeCondition", …)` block in `lib/typeChecker/narrowing.test.ts`:

```ts
  it("negation swaps then/else", () => {
    expect(analyzeCondition(firstIfCondition("!isSuccess(r)"))).toEqual({
      then: [{ variableName: "r", branch: "failure" }],
      else: [{ variableName: "r", branch: "success" }],
    });
  });

  it("conjunction unions then-facts, drops else-facts", () => {
    expect(analyzeCondition(firstIfCondition("isSuccess(a) && isSuccess(b)"))).toEqual({
      then: [
        { variableName: "a", branch: "success" },
        { variableName: "b", branch: "success" },
      ],
      else: [],
    });
  });

  it("disjunction unions else-facts, drops then-facts", () => {
    expect(analyzeCondition(firstIfCondition("isFailure(a) || isFailure(b)"))).toEqual({
      then: [],
      else: [
        { variableName: "a", branch: "success" },
        { variableName: "b", branch: "success" },
      ],
    });
  });

  it("double negation is identity", () => {
    expect(analyzeCondition(firstIfCondition("!!isSuccess(r)"))).toEqual({
      then: [{ variableName: "r", branch: "success" }],
      else: [{ variableName: "r", branch: "failure" }],
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "analyzeCondition"`
Expected: the four new tests FAIL (current `analyzeCondition` returns `NO_FACTS` for any `binOpExpression`).

- [ ] **Step 3: Make `analyzeCondition` recurse over boolean operators**

In `lib/typeChecker/narrowing.ts`, replace the start of `analyzeCondition` (the part before the `if (condition.type !== "functionCall")` guard) so the function begins:

```ts
export function analyzeCondition(condition: Expression): ConditionFacts {
  // Boolean combinators (the parser desugars `!x` into a binOpExpression of
  // the form { operator: "!", left: <true>, right: x }, so the operand is
  // `.right`). These are the standard sound narrowing rules:
  //   !c        → swap then/else
  //   a && b    → then = then(a) ∪ then(b); else unknown (both could be false)
  //   a || b    → else = else(a) ∪ else(b); then unknown (either could be true)
  if (condition.type === "binOpExpression") {
    if (condition.operator === "!") {
      const inner = analyzeCondition(condition.right);
      return { then: inner.else, else: inner.then };
    }
    if (condition.operator === "&&") {
      const l = analyzeCondition(condition.left);
      const r = analyzeCondition(condition.right);
      return { then: [...l.then, ...r.then], else: [] };
    }
    if (condition.operator === "||") {
      const l = analyzeCondition(condition.left);
      const r = analyzeCondition(condition.right);
      return { then: [], else: [...l.else, ...r.else] };
    }
    return NO_FACTS;
  }

  if (condition.type !== "functionCall") return NO_FACTS;
  // ...existing functionCall handling unchanged...
```

(Leave the existing `functionCall` body exactly as-is below this.)

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "analyzeCondition"`
Expected: PASS (all, including the Increment-1 cases).

- [ ] **Step 5: Write failing end-to-end combinator tests**

Append a new describe block to `lib/typeChecker/narrowing.test.ts`:

```ts
describe("Result narrowing — combinators", () => {
  it("narrows both branches of an isSuccess else via negation", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (!isSuccess(r)) {
    let e: number = r.error
  } else {
    let v: string = r.value
  }
}`);
    expect(errs).toContain("Type 'string' is not assignable to type 'number' (assignment to 'e').");
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'v').");
  });

  it("narrows every conjunct in an && guard", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let a = tryParse("ok")
  let b = tryParse("ok")
  if (isSuccess(a) && isSuccess(b)) {
    let x: string = a.value
    let y: string = b.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'x').");
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'y').");
  });
});
```

- [ ] **Step 6: Run them — they should already pass**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "combinators"`
Expected: PASS. (The wiring in `scopes.ts` already feeds `facts.then`/`facts.else` into child scopes; Step 3 is the only code needed for combinators to flow end-to-end. If they fail, the analyzer change in Step 3 is wrong — fix it before proceeding.)

- [ ] **Step 7: Run the whole narrowing suite + commit**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts`
Expected: PASS.

```bash
git add lib/typeChecker/narrowing.ts lib/typeChecker/narrowing.test.ts
git commit -F - <<'EOF'
feat(typechecker): narrow Result through !/&&/|| guard combinators

analyzeCondition now recurses over boolean operators: `!c` swaps then/else,
`a && b` unions then-facts, `a || b` unions else-facts. Standard sound
narrowing rules (false-negative only). Combinators flow end-to-end through
the existing walkWithNarrowing wiring.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Early-return (post-guard) narrowing

When the then-branch of an `if` always returns and there is no else (or the else doesn't exit), the statements *after* the `if` are reached only when the condition was false — so they narrow with `facts.else`. Symmetrically when the else always returns. This is the dominant Result idiom and the gating dependency for Increment 3.

**Files:**
- Modify: `lib/typeChecker/narrowing.ts` (add `alwaysExits`, `postGuardFacts`)
- Modify: `lib/typeChecker/scopes.ts` (index-based loop in `walkScopeBody`; extend the `ifElse` case)
- Modify: `docs/dev/typechecker.md`
- Test: `lib/typeChecker/narrowing.test.ts`

**Interfaces:**
- Consumes: `ConditionFacts`, `NarrowCandidate`, `walkWithNarrowing` (Task 1 / Increment 1).
- Produces: `alwaysExits(body: AgencyNode[]): boolean`; `postGuardFacts(node: IfElse, facts: ConditionFacts): NarrowCandidate[]`.

- [ ] **Step 1: Write the failing unit tests for the helpers**

Append to `lib/typeChecker/narrowing.test.ts`. First adjust imports/helpers:
- Add `alwaysExits, postGuardFacts` to the import from `./narrowing.js` (`analyzeCondition`, `narrowToBranch` are already imported; `type IfElse` is already imported).
- Add `import { walkNodes } from "../utils/node.js";`.
- Replace the existing hand-rolled `firstIfCondition` helper (carried from Increment 1) with one derived from the new `walkNodes`-based `firstIf` below, so there is a single traversal helper rather than two hand-rolled walkers (anti-patterns.md "Duplicating existing code"):

```ts
const firstIfCondition = (cond: string) => firstIf(`if (${cond}) { }`).condition;
```

Then add the `firstIf` helper and the new describe blocks:

```ts
// Parse a snippet and return the first ifElse node in main. Uses the shared
// walkNodes traversal (lib/utils/node.ts) rather than a hand-rolled walker —
// see docs/dev/anti-patterns.md "Duplicating existing code".
function firstIf(srcBody: string): IfElse {
  const parsed = parseAgency(`node main() {\n${srcBody}\n}`);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  for (const { node } of walkNodes(parsed.result.nodes)) {
    if (node.type === "ifElse") return node;
  }
  throw new Error("no ifElse found");
}

describe("alwaysExits", () => {
  it("true when the body has a top-level return", () => {
    expect(alwaysExits(firstIf(`  if (isFailure(r)) { return 0 }`).thenBody)).toBe(true);
  });
  it("false when the body has no return", () => {
    expect(alwaysExits(firstIf(`  if (isFailure(r)) { let x = 1 }`).thenBody)).toBe(false);
  });
  it("true when both arms of a nested if return", () => {
    const node = firstIf(`  if (isFailure(r)) { if (x) { return 1 } else { return 2 } }`);
    expect(alwaysExits(node.thenBody)).toBe(true);
  });
  it("false when only one arm of a nested if returns", () => {
    const node = firstIf(`  if (isFailure(r)) { if (x) { return 1 } }`);
    expect(alwaysExits(node.thenBody)).toBe(false);
  });
});

describe("postGuardFacts", () => {
  it("then-exits, no else → else-facts apply after", () => {
    const node = firstIf(`  if (isFailure(r)) { return 0 }`);
    expect(postGuardFacts(node, analyzeCondition(node.condition))).toEqual([
      { variableName: "r", branch: "success" },
    ]);
  });
  it("neither branch exits → no facts after", () => {
    const node = firstIf(`  if (isFailure(r)) { let x = 1 }`);
    expect(postGuardFacts(node, analyzeCondition(node.condition))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "alwaysExits"`
Expected: FAIL — `alwaysExits`/`postGuardFacts` are not exported yet.

- [ ] **Step 3: Add the helpers to `narrowing.ts`**

Add to `lib/typeChecker/narrowing.ts` (import `IfElse`: extend the top type import to `import type { AgencyNode, Expression, TypeAliasEntry, IfElse } from "../types.js";`):

```ts
/**
 * Conservative "this body always transfers control out of the enclosing
 * function" check. Increment 2 counts ONLY `return`: `raise` (interrupt) can
 * resume and continue, and `propagate` semantics are likewise non-trivial, so
 * treating either as an exit could be unsound. False negatives are fine — they
 * only cost a missed narrowing, never a wrong one.
 */
export function alwaysExits(body: AgencyNode[]): boolean {
  return body.some(
    (node) =>
      node.type === "returnStatement" ||
      (node.type === "ifElse" &&
        !!node.elseBody &&
        alwaysExits(node.thenBody) &&
        alwaysExits(node.elseBody)),
  );
}

/**
 * Facts that hold for the statements *after* an `if`, given which branch (if
 * any) always exits. If the then-branch exits and the else doesn't (or is
 * absent), reaching the after-code means the condition was false → else-facts.
 * Symmetrically for an exiting else-branch. If both or neither exit, nothing
 * is known (both-exit ⇒ after-code is dead; neither ⇒ both paths merge).
 */
export function postGuardFacts(node: IfElse, facts: ConditionFacts): NarrowCandidate[] {
  const thenExits = alwaysExits(node.thenBody);
  const elseExits = !!node.elseBody && alwaysExits(node.elseBody);
  if (thenExits && !elseExits) return facts.else;
  if (elseExits && !thenExits) return facts.then;
  return [];
}
```

- [ ] **Step 4: Run the helper unit tests to verify they pass**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "alwaysExits"` and `-t "postGuardFacts"`
Expected: PASS.

- [ ] **Step 5: Write the failing end-to-end early-return tests**

Append to `lib/typeChecker/narrowing.test.ts`:

```ts
describe("Result narrowing — early-return guards", () => {
  it("narrows after `if (isFailure(r)) { return }`", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isFailure(r)) { return 0 }
  let n: string = r.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("narrows after a negated early-return guard", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (!isSuccess(r)) { return 0 }
  let n: string = r.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("narrows after an else-only exit", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) { } else { return 0 }
  let n: string = r.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("does NOT narrow after a non-exiting guard but DOES after an exiting one", () => {
    // Self-witnessing: `exiting.value` proves post-guard narrowing IS firing
    // in this run; `merged.value` proves it correctly skips when the guard
    // doesn't always exit. If post-guard wiring breaks entirely, the `exiting`
    // assertion fails — no silent-pass trap.
    const errs = check(`${TRY_PARSE}
node main() {
  let exiting = tryParse("ok")
  if (isFailure(exiting)) { return 0 }
  let e: string = exiting.value

  let merged = tryParse("ok")
  if (isFailure(merged)) { let x = 1 }
  let m: string = merged.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'e').");
    expect(errs).not.toContain("(assignment to 'm')");
  });

  it("respects the reassignment gate in the post-guard region", () => {
    // Self-witnessing pair: `safe` proves post-guard narrowing fires;
    // `unsafe` proves the reassignment gate fires when the post-guard tail
    // reassigns the variable. Breaking narrowing entirely fails the `safe`
    // assertion.
    const errs = check(`${TRY_PARSE}
node main() {
  let safeR = tryParse("ok")
  if (isFailure(safeR)) { return 0 }
  let safe: string = safeR.value

  let unsafeR = tryParse("ok")
  if (isFailure(unsafeR)) { return 0 }
  unsafeR = tryParse("again")
  let unsafe: string = unsafeR.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'safe').");
    expect(errs).not.toContain("(assignment to 'unsafe')");
  });

  it("narrows after a chain of early-return guards", () => {
    // Locks that the recursive tail-walk correctly produces nested narrowings
    // — two sequential early-return guards must each narrow a different
    // variable for the rest of the body.
    const errs = check(`${TRY_PARSE}
node main() {
  let a = tryParse("ok")
  let b = tryParse("ok")
  if (isFailure(a)) { return 0 }
  if (isFailure(b)) { return 0 }
  let x: string = a.value
  let y: string = b.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'x').");
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'y').");
  });

  it("emits no post-guard facts when both branches exit", () => {
    // postGuardFacts returns [] when both arms exit (after-code is dead).
    // The dead `m.value` access must NOT narrow (no facts to apply) — but
    // we still need a self-witness that post-guard narrowing exists, so
    // pair with `e` from an exiting-then-only guard in the same body.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isFailure(r)) { return 0 }
  let e: string = r.value

  let m = tryParse("ok")
  if (isSuccess(m)) { return 1 } else { return 2 }
  let dead: string = m.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'e').");
    expect(errs).not.toContain("(assignment to 'dead')");
  });

  it("post-guard narrowing applies inside an outer if's body", () => {
    // The index-loop change must work at every nesting depth, not just
    // top-level. An inner early-return guard inside an outer if's then-body
    // must still narrow the tail of THAT body.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (true) {
    if (isFailure(r)) { return 0 }
    let n: string = r.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });
});

describe("Result narrowing — || end-to-end", () => {
  it("narrows in the else of an || guard via the union of else-facts", () => {
    // If `isFailure(r) || other` is false in the else, then specifically
    // `isFailure(r)` is false → `r` is Success in the else-branch. The
    // disjunction-rule `else = else(l) ∪ else(r)` produces that fact.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  let other = tryParse("ok")
  if (isFailure(r) || isFailure(other)) {
  } else {
    let n: string = r.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("does NOT narrow in the then-branch of an || guard (soundness)", () => {
    // `then: []` for disjunctions — either disjunct could be the true one,
    // so we can't pin `r`. Pair with an end-to-end `&&` then-branch assertion
    // in the same body to witness that narrowing IS otherwise functional.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  let other = tryParse("ok")
  if (isSuccess(r) || isSuccess(other)) {
    let n: string = r.value
  }
  if (isSuccess(r) && isSuccess(other)) {
    let w: string = r.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'w').");
    expect(errs).not.toContain("(assignment to 'n')");
  });
});
```

- [ ] **Step 6: Run to verify the positive cases fail**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "early-return"` and `-t "|| end-to-end"`
Expected: every test in the `early-return guards` describe FAILS — each one now requires at least one positive `toContain` assertion that depends on post-guard wiring (the negative cases were rewritten to be self-witnessing in Step 5, so they no longer pass vacuously). The `|| end-to-end` describe's two tests also FAIL — the negation/else-facts plumbing for `||` is provided by Task 1's analyzer change but the post-guard wiring doesn't affect them, so they exercise the analyzer end-to-end. (If `|| end-to-end` tests pass on this run, Task 1 already produces the right facts — that's expected; rerun after Step 7 to confirm the early-return tests now pass too.)

- [ ] **Step 7: Wire post-guard narrowing into `walkScopeBody`**

In `lib/typeChecker/scopes.ts`, add `alwaysExits, postGuardFacts` to the import from `./narrowing.js`:

```ts
import { analyzeCondition, walkWithNarrowing, postGuardFacts } from "./narrowing.js";
```

Convert the node loop header in `walkScopeBody` from `for (const node of nodes) {` to an index loop:

```ts
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    checkConstMutations(node, scope, ctx);
    switch (node.type) {
```

Then replace the `ifElse` case (merged form at `scopes.ts:426-437`) with:

```ts
      case "ifElse": {
        // Refinements live in throwaway child scopes (walkWithNarrowing →
        // declareLocal), so they never leak; real declarations inside the
        // body still call declare(), which targets the function scope.
        const facts = analyzeCondition(node.condition);
        const aliases = ctx.getTypeAliases();
        walkWithNarrowing(scope, node.thenBody, facts.then, aliases, ctx, walkScopeBody);
        if (node.elseBody) {
          walkWithNarrowing(scope, node.elseBody, facts.else, aliases, ctx, walkScopeBody);
        }
        // Post-guard narrowing: if exactly one branch always exits (returns),
        // the statements AFTER this if run only on the surviving branch's
        // condition, so walk the remainder of THIS body in a child scope that
        // carries those facts. Delegating the tail here (and returning) keeps
        // the refinement scoped to exactly the post-guard region.
        // The early `return` is load-bearing: without it the outer for-loop
        // would re-walk `rest` in the wrong (un-narrowed) scope, producing
        // duplicate diagnostics and ignoring the post-guard facts entirely.
        const afterFacts = postGuardFacts(node, facts);
        const rest = nodes.slice(i + 1);
        if (afterFacts.length > 0 && rest.length > 0) {
          walkWithNarrowing(scope, rest, afterFacts, aliases, ctx, walkScopeBody);
          return;
        }
        break;
      }
```

- [ ] **Step 8: Run the early-return tests to verify they pass**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "early-return"`
Expected: PASS (all five).

- [ ] **Step 9: Run the full narrowing suite + the whole typechecker suite**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts` → Expected: PASS.
Run: `npx vitest run lib/typeChecker/ 2>&1 | tee /tmp/tc-inc2.log` → Expected: PASS (no regressions). If any pre-existing test newly fails, inspect `/tmp/tc-inc2.log` — the index-loop change touches every body walk, so a regression here is most likely a missed structural detail in Step 7.

- [ ] **Step 10: Update the docs**

In `docs/dev/typechecker.md`, in the narrowing section, add a short paragraph: the guard surface now recognizes `!` / `&&` / `||` combinators and post-guard (early-return) narrowing — after `if (isFailure(r)) { return }`, `r` is Success for the rest of the block. Note the exit check is conservative (`return` only; `raise`/`propagate` excluded because they may resume).

- [ ] **Step 11: Commit**

```bash
git add lib/typeChecker/narrowing.ts lib/typeChecker/scopes.ts lib/typeChecker/narrowing.test.ts docs/dev/typechecker.md
git commit -F - <<'EOF'
feat(typechecker): early-return (post-guard) Result narrowing

After a guard whose taken branch always returns — `if (isFailure(r)) { return }`
or `if (isSuccess(r)) { } else { return }` — the statements after the if are
reached only on the surviving condition, so r narrows there. alwaysExits is
conservative (return only; raise/propagate may resume). The reassignment gate
applies to the post-guard region too.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Self-Review

**Spec coverage (against `type-narrowing-spec.md`, Increment 2 row):**
- Negation `!` → Task 1 Step 3, tested Step 1/Step 5. ✓
- `&&` / `||` → Task 1 Step 3, tested Step 1/Step 5. ✓
- Early-return guard narrowing for rest-of-block (needs reachability) → Task 2 (`alwaysExits` = the reachability check; `postGuardFacts` + `walkScopeBody` wiring). ✓
- Null/undefined + truthiness narrowing → **explicitly deferred** (Deferred section), with rationale (independent, non-gating). Flagged so a reviewer sees the omission is intentional, not a miss.
- Member/alias *expression* scrutinees → **explicitly deferred** (Deferred section). Alias-*typed* variables already covered by the Increment-1 `safeResolveType` fix.

**Soundness review:**
- `alwaysExits` counts only `return` — `raise`/`interrupt` may resume and `propagate` is non-trivial, so excluding them is the sound (false-negative) choice. Stated in the helper's doc comment and the Global Constraints.
- `postGuardFacts` returns `[]` when both or neither branch exits — both-exit makes the tail dead (no harm), neither-exit means the paths merge (narrowing would be unsound). ✓
- Post-guard narrowing reuses `walkWithNarrowing` → `applyNarrowing`, so the reassignment gate and alias resolution from Increment 1 apply unchanged to the tail (tested Task 2 Step 5, "respects the reassignment gate").
- No leak into return-type inference: unchanged from Increment 1 — `inferReturnTypeFor` re-synths return values against the plain function scope (`inference.ts:82`), never the narrowed child scopes.

**Placeholder scan:** None — every code step shows complete code; every run step shows command + expected outcome.

**Anti-pattern review (docs/dev/anti-patterns.md):**
- "Duplicating existing code" — test traversal uses the shared `walkNodes` (`firstIf`), and `firstIfCondition` is derived from it, so there is one traversal helper, not two hand-rolled walkers.
- "Imperative code everywhere" — the declarative seams are `analyzeCondition` (facts for a condition), `postGuardFacts` (facts after an `if`), and `walkWithNarrowing` (walk a body under narrowings); `alwaysExits` is written declaratively with `.some()`. The one deliberately-inline spot is the post-guard orchestration in `walkScopeBody` (Task 2 Step 7): it reuses `walkWithNarrowing` but open-codes the tail-slice and a load-bearing `return` to stop the outer loop. Kept as-is by decision — the alternative (a scope accumulator) removes the `return` but threads a mutable `cur` through every case; the early `return` is explained in an inline comment.
- "Nested ternaries" — none. The lone single ternary (`postGuardFacts`'s `elseExits`) was rewritten to `!!node.elseBody && alwaysExits(node.elseBody)` so the plan introduces zero ternaries.
- "Putting too much on a single line" — none. The only offender (the `for … if … visit()` walker line in the old `firstIf`) was removed when `firstIf` switched to `walkNodes`.
- "One-line if statements" — the new control-flow code (`analyzeCondition` binOp block, `walkScopeBody` ifElse) uses block bodies. Guard-clause one-liners (`if (cond) return X;`) remain in two places: the pre-existing `analyzeCondition` early-returns (carried from Increment 1, not modified — matches codebase style) and the `firstIf` test helper's `if (node.type === "ifElse") return node;`. Left as-is for codebase consistency; trivially block-ifiable if desired.
- No hits for: order-dependent mutable state, leaky abstractions, useless special cases, try/catch swallowing, nested type defs, dynamic requires, magic numbers. `alwaysExits` was confirmed not to duplicate any existing control-flow helper.

**Type consistency:** `alwaysExits(body: AgencyNode[]): boolean` and `postGuardFacts(node: IfElse, facts: ConditionFacts): NarrowCandidate[]` are defined in Task 2 Step 3 and used with identical names/signatures in Step 7 and the tests. `analyzeCondition`'s signature is unchanged (Task 1 only adds branches). The `IfElse` import is added in Task 2 Step 3.

**Execution risk to watch:** Task 2 Step 7 changes `walkScopeBody`'s loop from `for…of` to indexed and adds an early `return`. The early `return` fires only when post-guard facts exist AND there's a non-empty tail; in every other case control still hits `break` and the loop proceeds as before. Confirm via Step 9 that no existing body-walk behavior regressed (const-mutation checks, nested blocks, return-type inference fixtures).
```
