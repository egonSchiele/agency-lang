# FlowEnvironment memo auto-invalidation via a Scope generation counter

**Issue:** #471 (part 2). Part 1 of that issue — fusing flow-graph construction
into the scope walk and deleting the legacy child-scope narrowing path — is
**deliberately descoped** after owner review (2026-07-10): its remaining unique
benefits (unrequested precision gains, ~150 deleted lines, conceptual
cleanliness) do not justify 2–3 weeks. The dual "where to apply narrowing"
logic is inert — both paths share `analyzeCondition` (fact production) and
`narrowByRefine` (fact application), so a new narrowing form lands in both
automatically. This spec covers the part that has actually caused repeated
work: the human-enforced `FlowEnvironment.memo` soundness contract.

## Problem

`typeAt` (lib/typeChecker/flow.ts) memoizes per (flow node, reference key).
`start` nodes read `scope.lookup(...)` live, so a memoized answer embeds scope
state at query time. Any pass that mutates a scope after answers were cached
makes the cache stale, silently. The current protection is a doc comment
("SOUNDNESS CONTRACT: ... discard the memo") enforced by vigilance. Two passes
have independently paid for it:

- `handlerParamTyping` was moved ahead of `buildFlowGraphs` (index.ts) solely
  to avoid needing a reset.
- `computeMatchExprTypes` must remember `ctx.flowEnv.memo = new WeakMap()`
  after patching consumer scope entries and `assign` flow nodes.

## Mechanism

One integer per check run — the **generation** — owned by the `Scope` tree.

1. **`Scope` gets a `generation` counter.** `declare()` bumps it, propagating
   the bump up the parent chain to the root (`topLevelScope`), so any scope can
   read the tree-wide current generation in O(depth) (depth ≤ 3). The root's
   counter is the single source of truth.
2. **The memo becomes a shared box:** `FlowEnvironment.memo` changes from
   `WeakMap<FlowNode, Record<string, ScopeType>>` to
   `{ gen: number; map: WeakMap<FlowNode, Record<string, ScopeType>> }`.
   The box is shared **by reference** across the per-scope build envs and the
   spread-copied envs in the synthesizer (`{ ...ctx.flowEnv, typeAliases }`),
   so a reset made through any env is visible to all. (Replacing a `memo`
   field on one env object would not be — this is why the box exists.)
3. **`typeAt` checks on entry:** if `box.gen !== scope tree's current
   generation`, set `box.map = new WeakMap()` and `box.gen = current`, then
   proceed. Lazy whole-memo invalidation — identical semantics to today's
   manual resets, but automatic.

### Detached child scopes do not bump (the perf carve-out)

`Scope.child()` creates throwaway scopes for two callers: the synthesizer's
callback-parameter scopes (`xs.map(\(x) -> …)`, scope.ts `declareLocal`) and
the legacy narrowing path. These are created constantly during `checkScopes`;
if their `declareLocal` writes bumped the generation, every lambda synthesis
would flush the whole memo and typeAt memoization would be near-useless in
exactly the pass that needs it.

They don't need to bump: a memo entry can only go stale if the mutated scope
is reachable from a flow node, and flow `start` nodes are built exclusively
over `ScopeInfo` scopes (function/node/top-level scopes, `buildFlowGraphs`) —
never over `child()` scopes. Make that a by-construction rule rather than
vigilance:

- `Scope.child()` marks the child `detached: true` (readonly field).
- `declareLocal()` on a detached scope does not bump. (`declare()` from inside
  a detached child delegates to `functionScope()`, which is attached and DOES
  bump — correct, that mutation is flow-visible.)
- `buildFlowGraphs` asserts `!info.scope.detached` before building a `start`
  node, so a future misuse fails loudly instead of silently un-protecting the
  memo.

## What gets deleted / relaxed

- `computeMatchExprTypes`: the trailing manual memo reset. Its phase-2 patch
  loop already calls `info.scope.declare(...)` for every consumer it patches
  (matchExprTypes.ts:113), and that bump also covers the paired in-place
  `assignFlow.type` patch — any memo entry derived from the old snapshot was
  computed under the pre-bump generation. The **ordering assertion**
  (`flowEnv` must exist) stays: yield synthesis still genuinely requires the
  flow graph; only the memo half of the contract is automated.
- `FlowEnvironment.memo`'s SOUNDNESS CONTRACT doc comment: rewritten to
  describe the automatic mechanism.
- The pass-ordering *hazard* class in index.ts: `handlerParamTyping` stays
  where it is (it must still precede `checkScopes` for H3), but its position
  relative to `buildFlowGraphs` is no longer a correctness cliff; comments at
  both sites updated to say so.
- Audit for any other manual `memo = new WeakMap()` sites (grep during
  execution); delete each one the counter covers.

## What stays (non-goals)

- `matchConsumerAssignFlows` and the two-phase patch structure of
  `computeMatchExprTypes`: cross-scope consumers (module-level
  `const x = match(...)` lowering into a synthesized init function) genuinely
  require patching after all scopes are processed. The counter automates the
  *memo* consequence of the patch, not the patch itself.
- `strictMemberAccessSeverity`'s `!ctx.flowEnv → silent` gate: unchanged.
- The legacy child-scope narrowing path (`walkWithNarrowing` etc.): unchanged;
  descoped per the header. Issue #471 gets a comment recording the decision
  and shrinking its scope to this spec + docs refresh, with the fusion noted
  as "revisit if a passes-disagree bug materializes or a narrowing feature
  cannot live in the dual model."
- `inferReturnTypeFor`'s standalone scopes: they form their own tiny tree
  (no parent), so their bumps never touch the main tree's generation — and
  they never appear in flow nodes, so that is correct, not a gap.

## Docs refresh (same PR)

`docs/dev/typechecker/narrowing/README.md` still says the flow graph "has not
landed" (its status blurb predates the flow-checker series, #359–#386).
Rewrite the status section to describe the current dual model accurately:
flow-typed narrowing + `typeAt` are the primary path consulted by all
diagnostic passes; the scope-chain child-scope path survives only for
declaration-time inference during `buildScopes`; memo invalidation is
automatic (this change).

## Tests (red-first)

1. **Staleness pin (red on main):** flow.test.ts — memoize a start-rooted
   `typeAt` query, `scope.declare` the same name with a different type,
   re-query → must return the new type. On main this returns the stale cached
   type (this is the exact bug class).
2. **Bump propagation:** the declare happens on a *def* scope chained to the
   root; a query through an env holding the root still invalidates.
3. **Detached carve-out:** `declareLocal` on a `child()` scope does NOT
   invalidate (memoized entry survives, by identity) — pins the perf
   carve-out so a future "simplify: always bump" doesn't silently regress
   checkScopes performance. Plus: `buildFlowGraphs` over a detached scope
   throws (the assertion).
4. **Reset deletion is load-bearing:** delete `computeMatchExprTypes`' manual
   reset; the existing match-expression narrowing tests must stay green.
   Red-proof during execution: with the counter reverted but the reset still
   deleted, those tests fail — proving the counter now carries the contract.
5. **Perf gate:** in-process compile benchmark on ui.agency (median of 7),
   branch vs main, expectation: within noise. The counter only invalidates
   when a pass actually mutates an attached scope — the same points where
   manual resets fire today.

## Estimated size

~20 lines of mechanism (Scope counter + box + typeAt check + assert),
~30 lines of deletions/comment rewrites, tests, README refresh. 1–2 days.
