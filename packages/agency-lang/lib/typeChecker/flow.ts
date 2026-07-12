import { isAnyType } from "./utils.js";
import type { AgencyNode, TypeAliasEntry, VariableType } from "../types.js";
import type { Refine, NarrowCandidate } from "./narrowing.js";
import { narrowByRefine } from "./narrowing.js";
import { Scope, type ScopeType } from "./scope.js";
import { NEVER_T } from "./primitives.js";
import { isNever, safeResolveType } from "./assignability.js";
import { typeKey } from "./typeKey.js";
// The pure path-segment core lives in its own module so `narrowing.ts` can
// value-import it (chainToSegments) without a runtime cycle back through
// `flow.ts` (which value-imports `narrowByRefine` from `narrowing.ts`). Re-export
// it here so existing importers of `flow.js` are unaffected.
import type { PathSegment, Reference } from "./pathSegments.js";
import { referenceKey, isPrefixOf } from "./pathSegments.js";
export {
  type PathSegment,
  type Reference,
  segKey,
  referenceKey,
  isPrefixOf,
  toSegment,
  chainToSegments,
  stablePrefix,
} from "./pathSegments.js";

/**
 * Resolve successive path hops on a type — DIAGNOSTIC-FREE (unlike
 * `synthValueAccess`, which emits strict-member-access errors). Returns "any" on
 * any hop that can't be resolved (missing property, non-object/Record/array
 * receiver), so path narrowing stays conservative. Handles property and
 * literal-index hops (no tuple types exist, so an index resolves to the array
 * element type regardless of the index value).
 */
function resolvePath(
  baseType: ScopeType,
  chain: PathSegment[],
  aliases: Record<string, TypeAliasEntry>,
): ScopeType {
  let current: ScopeType = baseType;
  for (const seg of chain) {
    if (isAnyType(current)) return "any";
    const resolved = safeResolveType(current, aliases);
    if (seg.kind === "prop") {
      if (resolved.type === "objectType") {
        const p = resolved.properties.find((pr) => pr.key === seg.name);
        current = p ? p.value : "any";
      } else if (resolved.type === "genericType" && resolved.name === "Record") {
        current = resolved.typeArgs[1];
      } else {
        return "any";
      }
    } else {
      // index segment: array element, or Record value (Record<K,V>[i] → V)
      if (resolved.type === "arrayType") {
        current = resolved.elementType;
      } else if (resolved.type === "genericType" && resolved.name === "Record") {
        current = resolved.typeArgs[1];
      } else {
        return "any";
      }
    }
  }
  return current;
}

/** The DECLARED (un-narrowed) type of a path, from the base var's scope type. */
export function declaredPathType(
  scope: Scope,
  ref: Reference,
  aliases: Record<string, TypeAliasEntry>,
): ScopeType {
  return resolvePath(scope.lookup(ref.variable) ?? "any", ref.chain, aliases);
}

/**
 * A program point. Type checking builds and discards this graph per check; it
 * NEVER appears in AST output, so it cannot affect lowering, codegen, or
 * interrupt handling. (See the flow-typed checker spec, "Interrupt safety".)
 */
export type FlowNode =
  | { kind: "start"; scope: Scope }
  | { kind: "assign"; prev: FlowNode; ref: Reference; type: ScopeType }
  | { kind: "narrow"; prev: FlowNode; ref: Reference; refine: Refine }
  | { kind: "join"; prev: FlowNode[] }
  | { kind: "loop"; prev: FlowNode; widened: Record<string, ScopeType> }
  | { kind: "exit" };

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

export type FlowEnvironment = {
  scope: Scope;
  flowOf: WeakMap<AgencyNode, FlowNode>;
  typeAliases: Record<string, TypeAliasEntry>;
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
  /**
   * The end-of-body flow node per scopeKey, populated by `buildFlowGraphs`.
   * `exit` means every path through that scope diverges (returns). Consumed by
   * definite-return checking. Optional: bare envs built in tests don't set it.
   */
  scopeTerminals?: Record<string, FlowNode>;
  /**
   * The `assign` flow node created for each expression-match consumer
   * assignment (`const x = match(...)`, tagged `matchExprSource`). Populated by
   * the flow builder's assignment rule; consumed by `computeMatchExprTypes`,
   * which runs AFTER `buildFlowGraphs` (so yield synthesis sees narrowing) and
   * therefore must patch the eagerly-snapshotted `type` on this node with the
   * computed union — otherwise downstream reads of `x` resolve through typeAt
   * to the stale "any" recorded at build time. The paired consumer re-declare
   * bumps the generation, so the memo needs no manual reset. Optional: bare
   * envs in tests.
   */
  matchConsumerAssignFlows?: WeakMap<AgencyNode, FlowNode>;
};

/**
 * Union construction for flow joins. `any` dominates (a branch we can't type
 * makes the join untyped); `never` is the identity element (drops out); members
 * are deduped structurally; a single survivor unwraps; an empty union is
 * `never`. Literal members are preserved (not widened to primitives) so a
 * discriminant union survives a join with full precision.
 *
 * Dedup keys via `typeKey` (typeKey.ts), which resolves top-level aliases,
 * ignores property order and non-semantic metadata, and keys recursive
 * references nominally — the gaps raw `JSON.stringify` keying had.
 */
export function uniteTypes(
  types: ScopeType[],
  aliases: Record<string, TypeAliasEntry>,
): ScopeType {
  if (types.some((t) => isAnyType(t))) return "any";
  const concrete = (types as VariableType[]).filter((t) => !isNever(t));
  if (concrete.length === 0) return NEVER_T;
  const seen: Record<string, VariableType> = {};
  for (const t of concrete) {
    const key = typeKey(t, aliases);
    if (!(key in seen)) seen[key] = t;
  }
  const uniques = Object.values(seen);
  return uniques.length === 1 ? uniques[0] : { type: "unionType", types: uniques };
}

/**
 * Refine a (non-any) type by a single refine. Returns the narrowed type, or
 * null for "no narrowing". Delegates to `narrowByRefine` (the shared dispatcher)
 * so discriminant and presence narrowing stay in lockstep with the legacy path;
 * both are sound/conservative (Result is viewed as a union via resultUnion.ts).
 */
export function applyRefine(
  base: VariableType,
  refine: Refine,
  aliases: Record<string, TypeAliasEntry>,
): VariableType | null {
  return narrowByRefine(refine, base, aliases);
}

/**
 * The type of `ref` at flow node `at`. The single oracle every pass consults.
 * Memoized per (flow node, reference key).
 */
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
    // Null-prototype dict: keys are source identifiers (variable names), so a
    // ref named "__proto__" / "toString" / "constructor" must not collide with
    // Object.prototype on read. Mirrors scope.ts's own-property discipline.
    perNode = Object.create(null) as Record<string, ScopeType>;
    env.memo.map.set(at, perNode);
  }
  const cached = perNode[key];
  if (cached !== undefined) return cached;
  const result = computeTypeAt(ref, key, at, env);
  perNode[key] = result;
  return result;
}

function computeTypeAt(
  ref: Reference,
  key: string,
  at: FlowNode,
  env: FlowEnvironment,
): ScopeType {
  switch (at.kind) {
    case "start": {
      const base = at.scope.lookup(ref.variable) ?? "any";
      return ref.chain.length === 0 ? base : resolvePath(base, ref.chain, env.typeAliases);
    }
    case "assign": {
      // Exact match → the assigned type. A reassignment of any PREFIX of the
      // queried path (e.g. assigning `box` invalidates `box.r`) drops the
      // narrowing: re-resolve the path's tail from the freshly-assigned base.
      // Disjoint refs pass through to the pre-assignment flow unchanged.
      if (referenceKey(at.ref) === key) return at.type;
      if (isPrefixOf(at.ref, ref)) {
        const base = typeAt(at.ref, at, env);
        return resolvePath(base, ref.chain.slice(at.ref.chain.length), env.typeAliases);
      }
      return typeAt(ref, at.prev, env);
    }
    case "narrow": {
      if (referenceKey(at.ref) !== key) return typeAt(ref, at.prev, env);
      const base = typeAt(ref, at.prev, env);
      if (isAnyType(base)) return "any";
      return applyRefine(base, at.refine, env.typeAliases) ?? base;
    }
    case "join":
      return uniteTypes(at.prev.map((p) => typeAt(ref, p, env)), env.typeAliases);
    case "loop":
      // Own-property check: `at.widened` may be a plain object, so a ref named
      // "__proto__" / "toString" must not read from Object.prototype.
      if (Object.prototype.hasOwnProperty.call(at.widened, key)) {
        return at.widened[key];
      }
      // A reassigned PREFIX (the bare base var, the only shape `assignedNames`
      // widens) invalidates this path: re-resolve from the widened base rather
      // than trusting the (possibly narrowed) pre-loop flow. Otherwise
      // `while (…) { box = …; box.r.value }` would trust a stale narrowing.
      if (
        ref.chain.length > 0 &&
        Object.prototype.hasOwnProperty.call(at.widened, ref.variable)
      ) {
        return resolvePath(at.widened[ref.variable], ref.chain, env.typeAliases);
      }
      return typeAt(ref, at.prev, env);
    case "exit":
      throw new Error("typeAt called on an unreachable (exit) flow node");
  }
}

/**
 * Wrap `flow` in a `narrow` node for each candidate (innermost = first). With no
 * candidates the flow is returned unchanged. Used by the builder (PR 1b) to turn
 * a branch's ConditionFacts into flow nodes.
 */
export function wrapFacts(flow: FlowNode, candidates: NarrowCandidate[]): FlowNode {
  return candidates.reduce<FlowNode>(
    (prev, c) => ({
      kind: "narrow",
      prev,
      ref: c.ref,
      refine: c.refine,
    }),
    flow,
  );
}

/**
 * Does a `narrow` node for `ref` (exact key) apply on the flow path before any
 * rebinding of it? Walk back until the first node that (re)establishes the ref's
 * base — `start`/`loop`/`exit`, or an `assign` to `ref` or a prefix of it —
 * returning true iff a `narrow` for `ref` is seen first. `synthValueAccess` uses
 * this to route a member-path read through `typeAt` ONLY when narrowing genuinely
 * applies, so an un-narrowed path still hits the structural walk's diagnostics
 * (e.g. strict member access on un-guarded `b.r.value`).
 */
export function flowHasNarrowFor(ref: Reference, flow: FlowNode): boolean {
  const key = referenceKey(ref);
  let at: FlowNode = flow;
  for (;;) {
    switch (at.kind) {
      case "narrow":
        if (referenceKey(at.ref) === key) return true;
        at = at.prev;
        break;
      case "assign":
        // a rebind of the ref or any prefix resets it — no narrowing survives
        if (referenceKey(at.ref) === key || isPrefixOf(at.ref, ref)) return false;
        at = at.prev;
        break;
      case "join":
        // sound only if narrowing holds on ALL predecessors
        return at.prev.every((p) => flowHasNarrowFor(ref, p));
      case "start":
      case "loop":
      case "exit":
        return false;
    }
  }
}

/**
 * Merge control-flow branch ends. `exit` predecessors (e.g. a branch that
 * `return`ed) are dropped: reaching the code after a merge means a live branch
 * got here. No live branches → `exit` (the after-code is unreachable). One →
 * itself. Two or more → a `join`.
 */
export function mergeFlows(flows: FlowNode[]): FlowNode {
  const live = flows.filter((f) => f.kind !== "exit");
  if (live.length === 0) return { kind: "exit" };
  if (live.length === 1) return live[0];
  return { kind: "join", prev: live };
}

/**
 * Widen at a loop back-edge. For each name, compute its pre-loop and body-end
 * type; if they differ (the body reassigned it) widen to their union, else pass
 * the pre-loop type through. Sound: never under-widens a variable the body
 * changed. Can over-widen when a narrowing actually holds across iterations —
 * acceptable, documented (no fixpoint).
 *
 * The unchanged-check uses `typeKey` equality (same as `uniteTypes`), so
 * alias-vs-body and property-order differences no longer pessimistically
 * widen. The `"any"` sentinel short-circuits before typeKey, which only
 * accepts real VariableTypes.
 */
export function widenAtLoopBackEdge(
  loopEntry: FlowNode,
  bodyEnd: FlowNode,
  names: string[],
  env: FlowEnvironment,
): FlowNode {
  // Null-prototype dict: keys are variable names, so a name like "__proto__"
  // must not invoke the prototype setter on write (matches the read-side guard
  // in typeAt's `loop` case and scope.ts's own-property discipline).
  const widened: Record<string, ScopeType> = Object.create(null);
  for (const name of names) {
    const r: Reference = { variable: name, chain: [] };
    const before = typeAt(r, loopEntry, env);
    const after = bodyEnd.kind === "exit" ? before : typeAt(r, bodyEnd, env);
    const unchanged =
      isAnyType(before) || isAnyType(after)
        ? before === after
        : typeKey(before, env.typeAliases) === typeKey(after, env.typeAliases);
    if (unchanged) {
      widened[referenceKey(r)] = before;
    } else {
      widened[referenceKey(r)] = uniteTypes([before, after], env.typeAliases);
    }
  }
  return { kind: "loop", prev: loopEntry, widened };
}
