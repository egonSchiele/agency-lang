import type { AgencyNode, TypeAliasEntry, VariableType } from "../types.js";
import type { Refine, NarrowCandidate } from "./narrowing.js";
import { narrowUnionByDiscriminant } from "./narrowing.js";
import { Scope, type ScopeType } from "./scope.js";
import { NEVER_T } from "./primitives.js";
import { isNever } from "./assignability.js";

// NOTE: `narrowUnionByDiscriminant` and `NarrowCandidate` are added in Task 2
// and Task 3 respectively, alongside the code that uses them. Keeping each
// commit's imports tight to its surface area.

/**
 * A normalized reference path — the bound thing being narrowed. Today the
 * builder only emits empty chains (bare variables); the `chain` is reserved so
 * property-path narrowing (`if (user.profile != null) { user.profile.email }`)
 * can be added without revisiting `FlowNode` or `typeAt`'s signature.
 */
export type Reference = { variable: string; chain: string[] };

/** Stable string key for a reference (map keys, equality). */
export function referenceKey(ref: Reference): string {
  return ref.chain.length === 0 ? ref.variable : `${ref.variable}.${ref.chain.join(".")}`;
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

export type FlowEnvironment = {
  scope: Scope;
  flowOf: WeakMap<AgencyNode, FlowNode>;
  typeAliases: Record<string, TypeAliasEntry>;
  /**
   * Per-flow-node, per-reference-key memo for typeAt. WeakMap because keys are
   * FlowNode identities; without it, nested joins/loops re-walk super-linearly.
   *
   * SOUNDNESS CONTRACT: a `FlowEnvironment` is valid only for a single
   * type-check pass. The cache is keyed by FlowNode identity, but `start` nodes
   * read `scope.lookup(...)` — if the underlying `Scope` mutates (a new
   * declaration is added, a type is rebound) after a `start`-rooted query has
   * been memoized, the cache will return stale results. Discard the env (or
   * call `env.memo = new WeakMap()`) at any point where the scope contents
   * could have changed.
   */
  memo: WeakMap<FlowNode, Record<string, ScopeType>>;
};

/**
 * Union construction for flow joins. `any` dominates (a branch we can't type
 * makes the join untyped); `never` is the identity element (drops out); members
 * are deduped structurally; a single survivor unwraps; an empty union is
 * `never`. Literal members are preserved (not widened to primitives) so a
 * discriminant union survives a join with full precision.
 *
 * KNOWN LIMITATION (PR 1a): dedup is by `JSON.stringify` structural equality
 * and does NOT resolve type aliases. Two members that resolve to the same
 * underlying type via different aliases will both survive. PR 2 will hit this
 * the moment alias-typed locals flow through a join — fix then by resolving
 * with `_aliases` before keying.
 */
export function uniteTypes(
  types: ScopeType[],
  _aliases: Record<string, TypeAliasEntry>,
): ScopeType {
  if (types.some((t) => t === "any")) return "any";
  const concrete = (types as VariableType[]).filter((t) => !isNever(t));
  if (concrete.length === 0) return NEVER_T;
  const seen: Record<string, VariableType> = {};
  for (const t of concrete) {
    const key = JSON.stringify(t);
    if (!(key in seen)) seen[key] = t;
  }
  const uniques = Object.values(seen);
  return uniques.length === 1 ? uniques[0] : { type: "unionType", types: uniques };
}

/**
 * Refine a (non-any) type by a single discriminant. Returns the narrowed type,
 * or null for "no narrowing" — `narrowUnionByDiscriminant` already views Result
 * as a union (resultUnion.ts) and is sound/conservative.
 */
export function applyRefine(
  base: VariableType,
  refine: Refine,
  aliases: Record<string, TypeAliasEntry>,
): VariableType | null {
  return narrowUnionByDiscriminant(base, refine.prop, refine.literal, refine.keep, aliases);
}

/**
 * The type of `ref` at flow node `at`. The single oracle every pass consults.
 * Memoized per (flow node, reference key).
 */
export function typeAt(ref: Reference, at: FlowNode, env: FlowEnvironment): ScopeType {
  const key = referenceKey(ref);
  const perNode = env.memo.get(at);
  const cached = perNode?.[key];
  if (cached !== undefined) return cached;
  const result = computeTypeAt(ref, key, at, env);
  if (perNode) perNode[key] = result;
  else env.memo.set(at, { [key]: result });
  return result;
}

function computeTypeAt(
  ref: Reference,
  key: string,
  at: FlowNode,
  env: FlowEnvironment,
): ScopeType {
  switch (at.kind) {
    case "start":
      // Non-empty chains (property-path narrowing) are a follow-on; today every
      // reference has an empty chain, so this is a bare scope lookup.
      return at.scope.lookup(ref.variable) ?? "any";
    case "assign":
      return referenceKey(at.ref) === key ? at.type : typeAt(ref, at.prev, env);
    case "narrow": {
      if (referenceKey(at.ref) !== key) return typeAt(ref, at.prev, env);
      const base = typeAt(ref, at.prev, env);
      if (base === "any") return "any";
      return applyRefine(base, at.refine, env.typeAliases) ?? base;
    }
    case "join":
      return uniteTypes(at.prev.map((p) => typeAt(ref, p, env)), env.typeAliases);
    case "loop":
      return at.widened[key] ?? typeAt(ref, at.prev, env);
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
      ref: { variable: c.variableName, chain: [] },
      refine: c.refine,
    }),
    flow,
  );
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
