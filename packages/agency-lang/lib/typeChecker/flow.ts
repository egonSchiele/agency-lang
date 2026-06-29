import type { AgencyNode, TypeAliasEntry, VariableType } from "../types.js";
import type { Refine } from "./narrowing.js";
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
