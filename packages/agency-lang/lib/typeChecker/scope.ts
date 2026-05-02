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

  private functionScope(): Scope {
    if (!this.parent) return this;
    return this.parent.functionScope();
  }
}
