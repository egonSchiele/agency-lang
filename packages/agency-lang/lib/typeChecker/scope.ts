import type { VariableType } from "../types.js";

export type ScopeType = VariableType;

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
  // Null-prototype dictionaries: variable names are user-controlled, and on
  // a plain `{}` assigning the key "__proto__" invokes the prototype setter
  // (losing the binding and mutating the map) instead of storing an entry.
  private readonly vars: Record<string, ScopeType> = Object.create(null);
  private readonly consts: Record<string, boolean> = Object.create(null);
  private readonly isFunctionBoundary: boolean;
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

  /**
   * Declare a binding. Writes to the nearest function scope (function-scoped
   * semantics). Block-level Scope instances delegate upward.
   */
  declare(name: string, type: ScopeType, isConst: boolean = false): void {
    const target = this.functionScope();
    target.vars[name] = type;
    if (isConst) target.consts[name] = true;
    target.bumpGeneration();
  }

  /**
   * Declare a binding *only* in this scope, without delegating to the
   * enclosing function scope. Use this for genuinely block-scoped
   * bindings whose lifetime ends with the enclosing block (e.g. callback
   * parameters introduced when synthesizing the body of a `xs.map(\(x) ->
   * …)` lambda — `x` must not leak to the surrounding function).
   *
   * Behaves like `declare` for one-shot use: `lookup` will find it via
   * the normal parent walk, and dropping the scope drops the binding.
   */
  declareLocal(name: string, type: ScopeType): void {
    this.vars[name] = type;
    if (!this.detached) {
      this.bumpGeneration();
    }
  }

  lookup(name: string): ScopeType | undefined {
    // Own-property check — `name in this.vars` walks the prototype chain
    // and would falsely match names like "toString" / "constructor".
    if (Object.prototype.hasOwnProperty.call(this.vars, name)) {
      return this.vars[name];
    }
    return this.parent?.lookup(name);
  }

  /**
   * Like `lookup`, but stops at the enclosing function boundary instead of
   * walking into outer (module-level) scopes. Used to decide whether a
   * `let`/`const` statement redeclares an existing local or shadows an
   * outer binding with a fresh one.
   */
  lookupInFunction(name: string): ScopeType | undefined {
    if (Object.prototype.hasOwnProperty.call(this.vars, name)) {
      return this.vars[name];
    }
    if (!this.parent || this.isFunctionBoundary) return undefined;
    return this.parent.lookupInFunction(name);
  }

  isConst(name: string): boolean {
    // Own-property check — `name in this.vars` walks the prototype chain.
    if (Object.prototype.hasOwnProperty.call(this.vars, name)) {
      return this.consts[name] === true;
    }
    return this.parent?.isConst(name) ?? false;
  }

  has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }

  child(key: string = this.key): Scope {
    return new Scope(key, this, false, true);
  }

  private functionScope(): Scope {
    // A function-boundary scope is a declaration target even when it chains
    // to the module scope for lookups — locals must not leak into it.
    if (!this.parent || this.isFunctionBoundary) return this;
    return this.parent.functionScope();
  }
}
