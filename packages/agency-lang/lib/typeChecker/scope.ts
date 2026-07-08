import type { VariableType } from "../types.js";

export type ScopeType = VariableType | "any";

export class Scope {
  readonly key: string;
  readonly parent?: Scope;
  private readonly vars: Record<string, ScopeType> = {};
  private readonly consts: Record<string, boolean> = {};
  private readonly isFunctionBoundary: boolean;

  constructor(key: string, parent?: Scope, isFunctionBoundary: boolean = false) {
    this.key = key;
    this.parent = parent;
    this.isFunctionBoundary = isFunctionBoundary;
  }

  /**
   * Declare a binding. Writes to the nearest function scope (function-scoped
   * semantics). Block-level Scope instances delegate upward.
   */
  declare(name: string, type: ScopeType, isConst: boolean = false): void {
    const target = this.functionScope();
    target.vars[name] = type;
    if (isConst) target.consts[name] = true;
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
    return new Scope(key, this);
  }

  private functionScope(): Scope {
    // A function-boundary scope is a declaration target even when it chains
    // to the module scope for lookups — locals must not leak into it.
    if (!this.parent || this.isFunctionBoundary) return this;
    return this.parent.functionScope();
  }
}
