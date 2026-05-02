import type { VariableType } from "../types.js";

export type ScopeType = VariableType | "any";

export class Scope {
  readonly key: string;
  readonly parent?: Scope;
  private readonly vars: Record<string, ScopeType> = {};

  constructor(key: string, parent?: Scope) {
    this.key = key;
    this.parent = parent;
  }

  /**
   * Declare a binding. Writes to the nearest function scope (function-scoped
   * semantics). Block-level Scope instances delegate upward.
   */
  declare(name: string, type: ScopeType): void {
    const target = this.functionScope();
    target.vars[name] = type;
  }

  lookup(name: string): ScopeType | undefined {
    if (name in this.vars) return this.vars[name];
    return this.parent?.lookup(name);
  }

  has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }

  child(key: string = this.key): Scope {
    return new Scope(key, this);
  }

  /**
   * Flat record of all visible bindings (parent chain merged, child wins).
   * Provided for callers that still expect a Record. Prefer lookup()/has().
   */
  toRecord(): Record<string, ScopeType> {
    const merged: Record<string, ScopeType> = {};
    this.collect(merged);
    return merged;
  }

  private collect(out: Record<string, ScopeType>): void {
    if (this.parent) this.parent.collect(out);
    for (const [k, v] of Object.entries(this.vars)) out[k] = v;
  }

  private functionScope(): Scope {
    // A scope with no parent is always the function-scope root.
    // A child scope delegates upward unless it was explicitly created as a
    // function-scope root (no parent). Block-prefixed children and unnamed
    // children (same key as parent) both delegate upward.
    if (!this.parent) return this;
    return this.parent.functionScope();
  }
}
