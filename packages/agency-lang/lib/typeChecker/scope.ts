import type { VariableType } from "../types.js";

export type ScopeType = VariableType | "any";

export class Scope {
  readonly key: string;
  readonly parent?: Scope;
  private readonly vars: Record<string, ScopeType> = {};
  private readonly consts: Record<string, boolean> = {};

  constructor(key: string, parent?: Scope) {
    this.key = key;
    this.parent = parent;
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

  lookup(name: string): ScopeType | undefined {
    // Own-property check — `name in this.vars` walks the prototype chain
    // and would falsely match names like "toString" / "constructor".
    if (Object.prototype.hasOwnProperty.call(this.vars, name)) {
      return this.vars[name];
    }
    return this.parent?.lookup(name);
  }

  isConst(name: string): boolean {
    if (name in this.vars) return this.consts[name] === true;
    return this.parent?.isConst(name) ?? false;
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
