# FlowEnvironment Generation Counter Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline execution — this owner does not use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

> **Rev 2** applies all findings from
> `docs/superpowers/plans/2026-07-10-flowenv-generation-counter-review.md`:
> blocker 1 (interim in-place flush in Task 2), bench script placement + warmup
> (items 2-3), handlerParamTyping contract site (item 4), Verified Facts
> additions (item 5), comment fixes (items 6-8), `readonly memo` + braced ifs +
> bench constants (anti-pattern audit), and all six test gaps (spread-copy
> pins, guaranteed integration pin, same-type bump, nested detached chains,
> standalone-tree isolation).

**Goal:** Automate `FlowEnvironment.memo` invalidation with a Scope-tree generation counter, deleting the human-enforced "discard the memo if scope contents change" contract (issue #471 part 2; part 1 descoped — see spec header).

**Architecture:** `Scope` gains a tree-wide mutation counter (single integer on the root scope; `declare()` bumps it). The memo becomes a shared box `{ gen, map }` behind a `readonly` field; `typeAt` compares the box generation against the tree generation on entry and lazily rebuilds the map on mismatch. Throwaway `child()` scopes are marked `detached` and skip the bump (they are never flow-reachable — asserted in `buildFlowGraphs`).

**Tech Stack:** TypeScript, vitest. All paths below are relative to `packages/agency-lang/` unless they start with `docs/superpowers/`.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-10-flowenv-generation-counter-design.md`

## Global Constraints

- Repo rules: use types not interfaces, objects not maps, arrays not sets; no dynamic imports; never hold per-run state in a TS module global (the counter lives on Scope instances, per check run); no one-line if statements (brace all bodies).
- Commit messages must contain NO apostrophes (shell quoting breaks); write multi-line messages to a file and use `git commit -F`.
- Save all test-run output to files (e.g. `> /tmp/genctr-task1.log 2>&1`); never rerun a suite just to re-read its failures.
- Do NOT run the agency execution test suite locally; CI runs it on the PR.
- Perf gate (spec): ui.agency typecheck benchmark, branch vs main, 3 warmup + 25 timed iterations, branch median ≤ main median × 1.05. Reviewer-measured main median: ~23.2 ms.

## Verified facts (grep/read against main 2026-07-10; re-verified by external review)

- Memo WRITE sites: `flowBuilder.ts:373` (construction), `matchExprTypes.ts:127` (`ctx.flowEnv.memo = new WeakMap()` — the manual reset, ALSO a type-break site for the box change), `flow.test.ts:66` + `flow.test.ts:323`, `flowBuilder.test.ts:32` (test env helpers). Five sites total.
- Memo consumption: `flow.ts:169/175` inside `typeAt` only. Spread-copied envs (`{ ...ctx.flowEnv, typeAliases }`) at `synthesizer.ts:284-287` and `synthesizer.ts:832` share the memo **by reference** — the box must be mutated in place, never replaced.
- `scope.declare` sites that run AFTER `buildFlowGraphs` on the main tree: only `matchExprTypes.ts:113`. `handlerParamTyping.ts:121` declares on the main tree but runs BEFORE the flow build (enforced by a load-bearing throw + comment at `handlerParamTyping.ts:92-100` — a third home of the old contract, updated in Task 3). Lazy `inferReturnTypeFor` declares only into a standalone `new Scope(defScopeKey)` tree (`inference.ts:56`) whose bumps never touch the main root.
- `declareLocal` production callers: `synthesizer.ts:1201-1203` (callback params on a `child()` scope) and `narrowing.ts:431` (`applyNarrowing`, on the `walkWithNarrowing` child). Both detached under this change. `walkWithNarrowing` NESTS children (`child().child()` chains for nested ifs) — parent chains are arbitrarily deep, so no "depth <= 3" claims.
- All `ScopeInfo` scopes chain to one `topLevelScope` (`scopes.ts:32`/`:67`); `ctx.flowEnv.scope` is that parent-less root (`flowBuilder.ts:394-395`), so the hot-path generation read is O(1). `checkScopes` never calls `declare`/`declareLocal`/`child()`.
- Benchmark: `dist/lib/parser.js` exports `parseAgency`; `dist/lib/typeChecker/index.js` exports `typeCheck` (config/info args optional); ui.agency parses with `applyTemplate: false`. Node resolves `./dist/...` imports relative to the SCRIPT FILE location — the script must live inside each `packages/agency-lang` dir (not the scratchpad) and be deleted before committing.

## File structure

- Modify `lib/typeChecker/scope.ts` — generation counter, `detached` flag, `child()` marks detached. Test: `lib/typeChecker/scope.test.ts`.
- Modify `lib/typeChecker/flow.ts` — `FlowMemo` box type + `freshMemo()`, generation check in `typeAt`, rewritten contract comments. Test: `lib/typeChecker/flow.test.ts`.
- Modify `lib/typeChecker/flowBuilder.ts` — use `freshMemo()`, assert non-detached flow roots, fallback-root note. Test: `lib/typeChecker/flowBuilder.test.ts`.
- Modify `lib/typeChecker/matchExprTypes.ts` — interim in-place flush (Task 2), then delete it (Task 3). Test: `lib/typeChecker/matchExpression.test.ts` (integration pin).
- Modify `lib/typeChecker/handlerParamTyping.ts` + `lib/typeChecker/index.ts` — contract comments.
- Modify `docs/dev/typechecker/narrowing/README.md` — status + memo sections.

## Worktree setup (before Task 1)

```bash
cd /Users/adityabhargava/agency-lang
git worktree add .claude/worktrees/flow-memo-generation -b flow-memo-generation origin/main
cd .claude/worktrees/flow-memo-generation && pnpm install
cd packages/agency-lang && make > /tmp/genctr-setup-make.log 2>&1
```

All subsequent paths are inside `.claude/worktrees/flow-memo-generation/packages/agency-lang/`.

---

### Task 1: Scope generation counter + detached child scopes

**Files:**
- Modify: `lib/typeChecker/scope.ts`
- Test: `lib/typeChecker/scope.test.ts`

**Interfaces:**
- Produces: `Scope.currentGeneration(): number` (tree-wide, readable from any scope in the tree); `Scope.detached: boolean` (readonly, true for `child()` scopes); bump semantics: `declare()` always bumps (even re-declaring the same name/type), `declareLocal()` bumps unless `this.detached`.

- [ ] **Step 1: Write the failing tests** — append to `lib/typeChecker/scope.test.ts`:

```ts
describe("generation counter", () => {
  it("declare bumps the tree-wide generation, readable from any scope", () => {
    const root = new Scope("global");
    const fn = new Scope("fn", root, true);
    const g0 = fn.currentGeneration();
    fn.declare("x", "any");
    expect(fn.currentGeneration()).toBe(g0 + 1);
    expect(root.currentGeneration()).toBe(g0 + 1);
  });

  it("re-declaring the same name and type still bumps", () => {
    // computeMatchExprTypes phase 2 re-declares consumers with a type that can
    // equal the existing entry; the paired assign-node patch relies on the
    // bump regardless. Pins against a skip-if-unchanged "optimization".
    const fn = new Scope("fn");
    fn.declare("x", "any");
    const g0 = fn.currentGeneration();
    fn.declare("x", "any");
    expect(fn.currentGeneration()).toBe(g0 + 1);
  });

  it("declareLocal on a detached child() scope does not bump", () => {
    const fn = new Scope("fn");
    const child = fn.child();
    expect(child.detached).toBe(true);
    const g0 = fn.currentGeneration();
    child.declareLocal("cbParam", "any");
    expect(fn.currentGeneration()).toBe(g0);
  });

  it("declareLocal through a NESTED detached chain does not bump", () => {
    // walkWithNarrowing nests children per nested if — chains are real.
    const fn = new Scope("fn");
    const grandchild = fn.child().child();
    const g0 = fn.currentGeneration();
    grandchild.declareLocal("cbParam", "any");
    expect(fn.currentGeneration()).toBe(g0);
  });

  it("declare from a detached child bumps (delegates to the function scope)", () => {
    const fn = new Scope("fn");
    const child = fn.child();
    const g0 = fn.currentGeneration();
    child.declare("real", "any");
    expect(fn.currentGeneration()).toBe(g0 + 1);
  });

  it("declare through a NESTED detached chain bumps", () => {
    const fn = new Scope("fn");
    const grandchild = fn.child().child();
    const g0 = fn.currentGeneration();
    grandchild.declare("real", "any");
    expect(fn.currentGeneration()).toBe(g0 + 1);
  });

  it("declareLocal on an attached scope bumps", () => {
    const fn = new Scope("fn");
    const g0 = fn.currentGeneration();
    fn.declareLocal("x", "any");
    expect(fn.currentGeneration()).toBe(g0 + 1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/typeChecker/scope.test.ts > /tmp/genctr-task1-red.log 2>&1`
Expected: FAIL — `currentGeneration is not a function` / `detached` undefined.

- [ ] **Step 3: Implement in `lib/typeChecker/scope.ts`**

Add fields/methods (constructor gains a 4th param; existing call sites are unaffected by the default):

```ts
export class Scope {
  readonly key: string;
  readonly parent?: Scope;
  /**
   * True for throwaway child() scopes (synthesizer callback params, legacy
   * branch narrowing). Detached scopes are never flow-reachable — no flow
   * `start` node may be built over one (asserted in buildFlowGraphs) — so
   * their local writes do not bump the generation counter. This is the perf
   * carve-out that keeps lambda synthesis in checkScopes from flushing the
   * typeAt memo on every call.
   */
  readonly detached: boolean;
  // ... existing vars/consts/isFunctionBoundary fields ...
  /**
   * Tree-wide mutation counter, stored on the ROOT scope only. typeAt
   * (flow.ts) compares it against its memo generation and discards stale
   * entries automatically — the mechanism that replaced the manual
   * "discard the memo if scope contents change" contract.
   */
  private generation = 0;

  constructor(
    key: string,
    parent?: Scope,
    isFunctionBoundary: boolean = false,
    detached: boolean = false,
  ) {
    this.key = key;
    this.parent = parent;
    this.isFunctionBoundary = isFunctionBoundary;
    this.detached = detached;
  }

  private root(): Scope {
    return this.parent ? this.parent.root() : this;
  }

  /**
   * The tree-wide mutation count. O(parent-chain depth) in general (narrowing
   * child chains can nest arbitrarily); the hot path (typeAt) reads through
   * the flow env scope, which is the parent-less top-level scope — O(1).
   */
  currentGeneration(): number {
    return this.root().generation;
  }

  private bumpGeneration(): void {
    this.root().generation++;
  }
  // ...
}
```

Wire the bumps and the child flag:

```ts
  declare(name: string, type: ScopeType, isConst: boolean = false): void {
    const target = this.functionScope();
    target.vars[name] = type;
    if (isConst) target.consts[name] = true;
    target.bumpGeneration();
  }

  declareLocal(name: string, type: ScopeType): void {
    this.vars[name] = type;
    if (!this.detached) {
      this.bumpGeneration();
    }
  }

  child(key: string = this.key): Scope {
    return new Scope(key, this, false, true);
  }
```

(The `if (isConst) ...` one-liner is pre-existing code quoted verbatim — leave it in the file's current style.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/typeChecker/scope.test.ts > /tmp/genctr-task1-green.log 2>&1`
Expected: PASS (all pre-existing scope tests too).

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/scope.ts lib/typeChecker/scope.test.ts
git commit -m "Scope generation counter: declare bumps tree-wide, child scopes are detached"
```

---

### Task 2: FlowMemo box + typeAt auto-invalidation

**Files:**
- Modify: `lib/typeChecker/flow.ts:87-120` (FlowEnvironment), `flow.ts:167-182` (typeAt)
- Modify: `lib/typeChecker/flowBuilder.ts:371-403` (buildFlowGraphs)
- Modify: `lib/typeChecker/matchExprTypes.ts:127` (interim in-place flush — deleted in Task 3)
- Test: `lib/typeChecker/flow.test.ts` (env helper at :66, bare env at :323, new pins), `lib/typeChecker/flowBuilder.test.ts` (env helper at :32, assert test)

**Interfaces:**
- Consumes: `Scope.currentGeneration()`, `Scope.detached` (Task 1).
- Produces: `export type FlowMemo = { gen: number; map: WeakMap<FlowNode, Record<string, ScopeType>> }`; `export function freshMemo(): FlowMemo`; `FlowEnvironment.memo: readonly FlowMemo` (readonly FIELD — replacement is a compile error; in-place `memo.map`/`memo.gen` mutation is the only path).

- [ ] **Step 1: Change the memo type** in `lib/typeChecker/flow.ts`. Add above `FlowEnvironment`:

```ts
/**
 * The typeAt memo plus the scope-tree generation it was filled under. A BOX
 * shared by reference across every env that wraps the same check run —
 * including the spread copies the synthesizer makes ({ ...ctx.flowEnv,
 * typeAliases }) — so an invalidation made through any env is visible to all.
 * Mutate the box fields in place; the `readonly` on FlowEnvironment.memo
 * makes replacing the box itself a compile error.
 */
export type FlowMemo = {
  gen: number;
  map: WeakMap<FlowNode, Record<string, ScopeType>>;
};

/** A fresh memo box. gen -1 guarantees the first typeAt query stamps it. */
export function freshMemo(): FlowMemo {
  return { gen: -1, map: new WeakMap() };
}
```

Replace the `memo` field and its SOUNDNESS CONTRACT comment in `FlowEnvironment`:

```ts
  /**
   * Per-flow-node, per-reference-key memo for typeAt. WeakMap because keys are
   * FlowNode identities; without it, nested joins/loops re-walk super-linearly.
   *
   * Invalidation is AUTOMATIC for Scope mutations: `start` nodes read
   * `scope.lookup(...)` live, so any scope mutation stales the cache — typeAt
   * compares `memo.gen` against the scope tree generation
   * (Scope.currentGeneration) on entry and rebuilds the map on mismatch.
   * Passes that retype scope entries (e.g. computeMatchExprTypes) need no
   * manual reset: their declare() calls bump the generation. A FlowNode
   * patched IN PLACE (assignFlow.type = ...) is invisible to the counter and
   * still needs a paired declare() bump — see matchConsumerAssignFlows.
   */
  readonly memo: FlowMemo;
```

- [ ] **Step 2: Add the generation check to `typeAt`** (flow.ts:167). Replace the body's memo access:

```ts
export function typeAt(ref: Reference, at: FlowNode, env: FlowEnvironment): ScopeType {
  // Auto-invalidation: a mismatch means some attached scope mutated since the
  // memo was filled (see FlowMemo). Every entry is suspect — start nodes read
  // scopes live — so drop the whole map (lazy full invalidation, the same
  // semantics as the manual resets this replaced). INVARIANT: nothing mutates
  // scopes mid-walk — gen is stamped before computing, so a mid-walk mutation
  // would go unnoticed for entries computed earlier in the same walk.
  // Recursive typeAt calls re-check harmlessly under that invariant.
  const gen = env.scope.currentGeneration();
  if (env.memo.gen !== gen) {
    env.memo.map = new WeakMap();
    env.memo.gen = gen;
  }
  const key = referenceKey(ref);
  let perNode = env.memo.map.get(at);
  if (perNode === undefined) {
    // (existing null-prototype comment unchanged)
    perNode = Object.create(null) as Record<string, ScopeType>;
    env.memo.map.set(at, perNode);
  }
  const cached = perNode[key];
  if (cached !== undefined) return cached;
  const result = computeTypeAt(ref, key, at, env);
  perNode[key] = result;
  return result;
}
```

- [ ] **Step 3: Fix the five memo write sites.**
  1. `flowBuilder.ts:373`: `const memo = freshMemo();` (import `freshMemo` from `./flow.js`).
  2. `matchExprTypes.ts:127`: the manual reset is now a type error against the box (and would violate `readonly`). Interim in-place flush that respects the box contract — do NOT use `freshMemo()` here (replacing the box is the forbidden pattern):
     ```ts
     ctx.flowEnv.memo.map = new WeakMap();
     ```
     (Belt-and-braces during the transition; Task 3 deletes it.)
  3. `flow.test.ts:66` and `:323`, `flowBuilder.test.ts:32`: replace `memo: new WeakMap()` with `memo: freshMemo()` (add imports).

  Then run `npx tsc --noEmit -p . > /tmp/genctr-task2-tsc.log 2>&1` — clean, no remaining `memo` errors.

- [ ] **Step 4: Add the detached-root assertion + fallback note** in `flowBuilder.ts`. Inside the `for (const info of scopes)` loop, first statement:

```ts
    if (info.scope.detached) {
      throw new Error(
        `buildFlowGraphs: scope for ${info.scopeKey} is a detached child scope. Flow start nodes must be built over function/top-level scopes only - detached scopes do not bump the generation counter, so a start node over one would silently un-protect the typeAt memo.`,
      );
    }
```

At the fallback root (`flowBuilder.ts:394`), add above the line:

```ts
  // Empty scopes list fallback: an orphan root whose generation never moves.
  // Harmless — no flow nodes exist to memoize against in that case.
```

- [ ] **Step 5: Write the pins** — append to `lib/typeChecker/flow.test.ts` (module already defines `env`, `ref`, `STR`, `NUM`, `Scope`, flow-node literals):

```ts
describe("memo auto-invalidation (generation counter)", () => {
  it("returns the fresh type after a scope mutation (stale on main)", () => {
    const scope = new Scope("fn");
    scope.declare("x", NUM);
    const start: FlowNode = { kind: "start", scope };
    const e = env(scope);
    expect(typeAt(ref("x"), start, e)).toEqual(NUM); // memoized
    scope.declare("x", STR); // a later pass retypes x
    expect(typeAt(ref("x"), start, e)).toEqual(STR);
  });

  it("a declare bump also covers a paired in-place assign-node patch", () => {
    // Pins the computeMatchExprTypes phase-2 contract: patch assignFlow.type
    // AND re-declare the consumer; the declare bump invalidates entries
    // derived from the old snapshot.
    const scope = new Scope("fn");
    scope.declare("x", "any");
    const start: FlowNode = { kind: "start", scope };
    const assign: Extract<FlowNode, { kind: "assign" }> = {
      kind: "assign",
      prev: start,
      ref: ref("x"),
      type: "any",
    };
    const e = env(scope);
    expect(typeAt(ref("x"), assign, e)).toBe("any"); // memoized under old gen
    assign.type = STR;
    scope.declare("x", STR);
    expect(typeAt(ref("x"), assign, e)).toEqual(STR);
  });

  it("an invalidation is visible through a spread-copied env (shared box)", () => {
    // The synthesizer queries through { ...ctx.flowEnv, typeAliases } copies
    // (synthesizer.ts:284, :832). The box is shared by reference, so a flush
    // triggered through ANY env must be visible through every copy.
    const scope = new Scope("fn");
    scope.declare("x", NUM);
    const start: FlowNode = { kind: "start", scope };
    const e = env(scope);
    expect(typeAt(ref("x"), start, e)).toEqual(NUM); // memoize via original
    scope.declare("x", STR);
    const copy = { ...e, typeAliases: {} };
    expect(typeAt(ref("x"), start, copy)).toEqual(STR); // read via the COPY
  });

  it("a memo hit survives through a spread copy (no mutation)", () => {
    const scope = new Scope("fn");
    scope.declare("x", STR);
    const start: FlowNode = { kind: "start", scope };
    const a1: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: STR };
    const a2: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: NUM };
    const join: FlowNode = { kind: "join", prev: [a1, a2] };
    const e = env(scope);
    const first = typeAt(ref("x"), join, e);
    const copy = { ...e, typeAliases: {} };
    expect(typeAt(ref("x"), join, copy)).toBe(first); // identity => shared memo
  });

  it("declareLocal on a detached child does not flush the memo (identity pin)", () => {
    // Recomputing this join constructs a FRESH union object (uniteTypes), so
    // object identity across queries proves a memo hit. Guards the perf
    // carve-out: lambda-param child scopes must not flush the memo.
    const scope = new Scope("fn");
    scope.declare("x", STR);
    const start: FlowNode = { kind: "start", scope };
    const a1: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: STR };
    const a2: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: NUM };
    const join: FlowNode = { kind: "join", prev: [a1, a2] };
    const e = env(scope);
    const first = typeAt(ref("x"), join, e);
    scope.child().declareLocal("cbParam", STR); // the synthesizer pattern
    expect(typeAt(ref("x"), join, e)).toBe(first); // same object => memo hit
  });

  it("a declare into an UNRELATED standalone scope tree does not flush", () => {
    // Lazy inferReturnTypeFor declares into its own new Scope(...) tree
    // mid-checkScopes; those bumps must not touch the main tree memo.
    const scope = new Scope("fn");
    scope.declare("x", STR);
    const start: FlowNode = { kind: "start", scope };
    const a1: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: STR };
    const a2: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: NUM };
    const join: FlowNode = { kind: "join", prev: [a1, a2] };
    const e = env(scope);
    const first = typeAt(ref("x"), join, e);
    const standalone = new Scope("inference");
    standalone.declare("y", NUM);
    expect(typeAt(ref("x"), join, e)).toBe(first); // memo hit survives
  });

  it("an unrelated attached declare flushes the whole memo (lazy semantics)", () => {
    // Deliberate pin of whole-memo (not per-name) invalidation, so a future
    // change to finer granularity is a conscious decision with a test diff.
    const scope = new Scope("fn");
    scope.declare("x", STR);
    const start: FlowNode = { kind: "start", scope };
    const a1: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: STR };
    const a2: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: NUM };
    const join: FlowNode = { kind: "join", prev: [a1, a2] };
    const e = env(scope);
    const first = typeAt(ref("x"), join, e);
    scope.declare("unrelated", NUM);
    const second = typeAt(ref("x"), join, e);
    expect(second).toEqual(first);
    expect(second).not.toBe(first); // recomputed => memo was flushed
  });
});
```

And to `lib/typeChecker/flowBuilder.test.ts` (import `buildFlowGraphs`, and `ScopeInfo`/`TypeCheckerContext` types from `./types.js`):

```ts
it("rejects a detached child scope as a flow root", () => {
  const detachedScope = new Scope("fn").child();
  const info = {
    scope: detachedScope,
    body: [],
    name: "f",
    scopeKey: "fn:f",
    file: "",
  } as ScopeInfo;
  const ctx = { getTypeAliases: () => ({}) } as unknown as TypeCheckerContext;
  expect(() => buildFlowGraphs([info], ctx)).toThrow(/detached/);
});
```

- [ ] **Step 6: Red check.** With the Step 2 generation check temporarily commented out, run `npx vitest run lib/typeChecker/flow.test.ts > /tmp/genctr-task2-red.log 2>&1`. Expected RED: the staleness pin, the assign-patch pin, the spread-copy invalidation pin, and the lazy-semantics pin (its `not.toBe` fails on a memo hit). Expected GREEN even without the check: the identity pins (they test caching, which exists on main). Restore the block.

- [ ] **Step 7: Full green.**

Run: `npx vitest run lib/typeChecker > /tmp/genctr-task2-green.log 2>&1`
Expected: PASS across the typeChecker suite.

- [ ] **Step 8: Commit**

```bash
git add lib/typeChecker/flow.ts lib/typeChecker/flowBuilder.ts lib/typeChecker/matchExprTypes.ts lib/typeChecker/flow.test.ts lib/typeChecker/flowBuilder.test.ts
git commit -m "FlowMemo box + generation check in typeAt: memo self-invalidates on scope mutation"
```

---

### Task 3: Delete the manual reset; guaranteed integration pin; update all three contract homes

**Files:**
- Modify: `lib/typeChecker/matchExprTypes.ts` (delete the interim flush from Task 2)
- Modify: `lib/typeChecker/index.ts:323-335` (two comments)
- Modify: `lib/typeChecker/handlerParamTyping.ts:92-100` + trailing comment (the third contract home — re-read the file first, anchors may have drifted)
- Modify: `lib/typeChecker/flow.ts:110-119` (`matchConsumerAssignFlows` doc)
- Test: `lib/typeChecker/matchExpression.test.ts`

**Interfaces:**
- Consumes: automatic invalidation from Task 2.

- [ ] **Step 1: Add the integration pin FIRST** (green on main semantics, red if the counter fails to carry the contract). Append to `lib/typeChecker/matchExpression.test.ts`, adapting to that file's existing typecheck helper if one exists (otherwise `parseAgency` + `typeCheck` directly, as its sibling tests do):

```ts
it("stale phase-1 memo entries do not suppress downstream diagnostics", () => {
  // Two sequential expression-matches. The second match has the higher id, so
  // computeMatchExprTypes phase 1 processes it FIRST and synthesizes its
  // yield `first` — a typeAt query that memoizes the PRE-patch "any" at the
  // flow node after the first consumer assignment. Phase 2 then patches
  // `first` to string. The `const n: number = first` check in checkScopes
  // resolves `first` through that same flow path: with a stale memo the
  // cached "any" propagates (any is assignable to number — diagnostic
  // SUPPRESSED); with invalidation (manual reset on main, generation counter
  // now) the diagnostic fires. Pins the production flush point end-to-end.
  const src = [
    "def f(v: number): string {",
    '  const first = match (v) { 1 => "a"',
    '    _ => "b" }',
    '  const second = match (v) { 1 => first',
    '    _ => "z" }',
    "  const n: number = first",
    "  return second",
    "}",
  ].join("\n");
  const parsed = parseAgency(src, {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("unreachable");
  }
  const result = typeCheck(parsed.result);
  const messages = result.errors.map((e) => e.message).join("\n");
  expect(messages).toContain("not assignable");
  expect(messages).toContain("number");
});
```

Verify it is GREEN before touching the reset (main behavior, reset still present as the Task 2 interim flush). If the match syntax above misparses, debug with `pnpm run ast` on the snippet before proceeding — do not weaken the assertion.

- [ ] **Step 2: Delete the interim flush.** In `matchExprTypes.ts`, replace the trailing comment block + `ctx.flowEnv.memo.map = new WeakMap()` (inside its `if (ctx.flowEnv)`) with:

```ts
  // Scope entries and flow-node types were rebound above. The declare() calls
  // bumped the scope-tree generation, so typeAt discards its stale memo on the
  // next query (see FlowMemo, flow.ts) — no manual reset needed.
```

- [ ] **Step 3: Update the other two contract homes.**

`index.ts` at the `buildFlowGraphs` call (~line 323) — replace "Build the flow graph AFTER the param retype, so its `typeAt` oracle is seeded with the refined `e` (no stale-memo reset needed)." with:

```ts
    // Build the flow graph AFTER the param retype so the oracle is seeded with
    // the refined `e` from the start. (Ordering kept for oracle-seeding
    // quality; since the generation counter, a post-flow retype would also be
    // sound — the declare would bump the generation and the memo would
    // self-invalidate.)
```

`index.ts` at the `computeMatchExprTypes` call comment (~line 330): delete the trailing clause ", then resets the typeAt memo (per the FlowEnvironment soundness contract) so no stale entry survives", ending the sentence at "...with the computed union.".

`handlerParamTyping.ts:92-100`: the ORDERING ASSERTION throw stays (ordering is kept — no reason to pay a whole-memo flush for a retype that can simply run first), but its justification is now false ("a reorder would silently produce stale types" — it would not; the declare at :121 bumps). Rewrite the comment to:

```ts
  // ORDERING ASSERTION: this pass runs BEFORE buildFlowGraphs so the typeAt
  // oracle is seeded with the refined `e` from its first query. Since the
  // Scope generation counter (FlowMemo, flow.ts) a reorder would no longer
  // produce stale types — the declare below bumps the generation and the memo
  // self-invalidates — but running first is still strictly better: it avoids
  // a whole-memo flush and keeps every pass reading the same refined types.
```

Update the trailing "No flow-env memo reset needed: this pass runs BEFORE `buildFlowGraphs`..." comment at the end of the function to match (one sentence: pre-flow ordering means the memo does not exist yet; were it reordered, the counter would cover it).

`flow.ts` `matchConsumerAssignFlows` doc: append one sentence to the existing (still-true) text: "The paired consumer re-declare bumps the generation, so the memo needs no manual reset."

- [ ] **Step 4: Green check.**

Run: `npx vitest run lib/typeChecker/matchExpression.test.ts lib/typeChecker/matchArmNarrowing.test.ts lib/typeChecker/matchExhaustiveness.test.ts lib/typeChecker/flow.test.ts lib/typeChecker/flowNarrowing.test.ts > /tmp/genctr-task3-green.log 2>&1`
Expected: PASS.

- [ ] **Step 5: Red-proof that the counter now carries the contract.** Temporarily comment out the generation check in `typeAt` (the reset is deleted), run the same suites to `/tmp/genctr-task3-redproof.log`. Expected RED: the Step 1 integration pin (guaranteed — this is the production flush point end-to-end) plus the Task 2 unit pins. Record in the PR body whether any PRE-EXISTING match test also went red (tells us whether the old manual reset had independent coverage before this PR). Restore the check, re-run, confirm green.

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker/matchExprTypes.ts lib/typeChecker/index.ts lib/typeChecker/handlerParamTyping.ts lib/typeChecker/flow.ts lib/typeChecker/matchExpression.test.ts
git commit -m "Delete the manual typeAt memo reset; generation counter carries the contract in all three homes"
```

---

### Task 4: Narrowing README refresh

**Files:**
- Modify: `docs/dev/typechecker/narrowing/README.md`: status blockquote (lines 12-21), H1 "Memo reset" bullet (~line 258)

- [ ] **Step 1: Rewrite the stale status blockquote** (it predates the flow-checker series #359-#386 and claims "the flow graph itself has not [landed]"). Replace the whole `> **Status — mid-migration.**` blockquote with:

```markdown
> **Status — dual model, flow-typed primary.** The flow graph and the
> `typeAt(reference, flowNode)` oracle have LANDED (the #359–#386 series):
> every diagnostic pass (`checkScopes`, exhaustiveness, definite returns)
> resolves types through the flow model, and `FlowEnvironment.memo`
> invalidation is automatic (a Scope-tree generation counter — see
> `FlowMemo` in `lib/typeChecker/flow.ts`). The scope-chain model documented
> below survives for ONE job: declaration-time inference during
> `buildScopes`, which runs before the flow graph exists. Both models share
> fact production (`analyzeCondition`) and fact application
> (`narrowByRefine`), so a new narrowing form lands in both automatically.
> Fusing the walks and deleting the scope-chain path was assessed and
> deliberately deferred (issue #471): the duplication is inert and the
> precision delta was not worth the rebuild.
```

- [ ] **Step 2: Update the H1 "Memo reset" bullet** (under "Handler param `.effect` typing"). Replace the bullet's text with:

```markdown
- **Ordering.** The pass runs before `buildFlowGraphs` so the oracle is
  seeded with the refined `e` from the start. Historically this ordering was
  load-bearing (a post-flow retype required a manual memo reset); since the
  generation counter, the memo self-invalidates on `declare()` and the
  ordering is an oracle-seeding-quality choice, not a soundness cliff.
```

- [ ] **Step 3: Commit**

```bash
git add docs/dev/typechecker/narrowing/README.md
git commit -m "Narrowing README: flow model has landed, memo invalidation is automatic"
```

---

### Task 5: Full verification, perf gate, issue update, PR

- [ ] **Step 1: Build + linter + full lib suite.**

```bash
make > /tmp/genctr-task5-make.log 2>&1
pnpm run lint:structure > /tmp/genctr-task5-lint.log 2>&1
npx vitest run lib > /tmp/genctr-task5-tests.log 2>&1
```
Expected: all clean (~7,820+ tests). If `make` drifted `docs/site/stdlib/data/usaspending.md`, revert it; delete any `a.vs.b.verdict.json`.

- [ ] **Step 2: Perf gate.** Write this script as `bench-typecheck.mjs` INSIDE `packages/agency-lang/` of BOTH checkouts (Node resolves the `./dist/...` imports relative to the script file, and `readFileSync` is cwd-relative — so file in package dir, run from package dir). DELETE both copies before committing. For the main-checkout run use `/Users/adityabhargava/agency-lang/packages/agency-lang` after `make` — verify `git status` shows no typeChecker modifications there first; do NOT use git stash (breaks the incremental build).

```js
// bench-typecheck.mjs — run from packages/agency-lang after make. DELETE before committing.
import { readFileSync } from "node:fs";
import { parseAgency } from "./dist/lib/parser.js";
import { typeCheck } from "./dist/lib/typeChecker/index.js";

const WARMUP = 3;
const RUNS = 25;
const src = readFileSync("stdlib/ui.agency", "utf8");
const parsed = parseAgency(src, {}, false);
if (!parsed.success) {
  throw new Error("parse failed");
}
for (let i = 0; i < WARMUP; i++) {
  typeCheck(parsed.result);
}
const times = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  typeCheck(parsed.result);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
console.log("median typecheck ms:", times[Math.floor(RUNS / 2)].toFixed(1));
```

Gate: branch median ≤ main median × 1.05 (expect ~23 ms on main per the review's measurement). Diagnostics from unresolved `std::` imports are identical on both sides — the comparison is valid. If the gate fails, profile before proceeding: the expected flush points are only `computeMatchExprTypes` phase 2, same as the manual reset today.

- [ ] **Step 3: Comment on issue #471** (body via file, `gh issue comment 471 --repo egonSchiele/agency-lang -F <file>`): part 2 (memo automation) is implemented in this PR; part 1 (delete the scope-chain path / fuse the walks) is deliberately deferred with a two-sentence summary of the owner decision (duplication is inert — shared `analyzeCondition` + `narrowByRefine`; ~150 lines and unrequested precision not worth 2-3 weeks; revisit if a passes-disagree bug materializes or a narrowing feature cannot live in the dual model). Do NOT close the issue.

- [ ] **Step 4: Push and open the PR.** Body (via file): what the counter is (three-sentence mechanism), the detached carve-out and its assertion, what was deleted (manual reset, the soundness-cliff framing in all three contract homes), reviewer pointers (the box-shared-by-reference subtlety + `readonly memo`; the identity-based memo-hit pins; the integration pin and how it exercises the production flush point), the red-proof result from Task 3 Step 5 (including whether pre-existing tests covered the reset), benchmark numbers, and the #471 descope note. Title: "Automate typeAt memo invalidation with a Scope generation counter (#471 part 2)".

---

## Self-review notes (rev 2)

- All review findings applied: blocker 1 → Task 2 Step 3.2; item 2-3 → Task 5 Step 2 (script placement, warmup, RUNS const, computed median index); item 4 → Task 3 Step 3 (handlerParamTyping kept-but-rewritten); item 5 → Verified Facts; items 6-8 → comment texts in Tasks 1-2; anti-pattern audit → `readonly memo`, braced `declareLocal` if, braced bench throw; test gaps 1-6 → spread-copy pins + guaranteed integration pin (Task 3 Step 1, replacing the conditional experiment) + same-type bump + nested chains + standalone-tree pin.
- The rebindMatchConsumer helper suggested as optional in the review is deliberately skipped (single caller); the pairing warning lives in the FlowMemo + matchConsumerAssignFlows comments instead, per review item 8.
- Type consistency: `FlowMemo`/`freshMemo` (Task 2 Step 1) consumed in Steps 3/5 and Task 3; `currentGeneration()`/`detached` (Task 1) consumed in Task 2 Steps 2/4/5. Integration pin uses `parseAgency(src, {}, false)` + `typeCheck(parsed.result)` — signatures verified on main.
