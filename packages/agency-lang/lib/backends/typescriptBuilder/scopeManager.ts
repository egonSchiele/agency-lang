import type { Scope, VariableType } from "../../types.js";
import type { CompilationUnit } from "../../compilationUnit.js";
import { scopeKey } from "../../compilationUnit.js";

/**
 * Owns the lexical scope stack and answers scope-related queries.
 *
 * The TypeScriptBuilder pushes a new scope every time it descends into a
 * function, graph node, or block body, and pops on exit. This class
 * centralises that bookkeeping plus the read-only queries that depend on
 * the current scope (return type, visible type aliases, scope-key for
 * symbol lookups, …) so callers can use a declarative API instead of
 * touching a raw array.
 *
 * `inSafeFunction` is tracked here because "safety" is a property of the
 * function currently being emitted, which conceptually belongs to the
 * scope stack.
 */
export class ScopeManager {
  private stack: Scope[] = [{ type: "global" }];
  private _inSafeFunction: boolean = false;

  constructor(private readonly compilationUnit: CompilationUnit) {}

  // ---- Scope stack ----

  push(scope: Scope): void {
    this.stack.push(scope);
  }

  pop(): void {
    this.stack.pop();
  }

  current(): Scope {
    return this.stack[this.stack.length - 1];
  }

  /** Stable string key for the current scope (used for symbol/type-alias lookups). */
  currentKey(): string {
    return scopeKey(this.current());
  }

  /** Function, node, or block name; empty string for global. */
  currentName(): string {
    const scope = this.current();
    if (scope.type === "function") return scope.functionName;
    if (scope.type === "node") return scope.nodeName;
    if (scope.type === "block") return scope.blockName;
    return "";
  }

  // ---- Safe-function flag ----

  get inSafeFunction(): boolean {
    return this._inSafeFunction;
  }

  set inSafeFunction(value: boolean) {
    this._inSafeFunction = value;
  }

  // ---- Compilation-unit-backed queries ----

  visibleTypeAliases(): Record<string, VariableType> {
    return this.compilationUnit.typeAliases.visibleIn(this.currentKey());
  }

  /**
   * Declared return type of the currently-executing function or graph node,
   * or `undefined` for global scope or a function with no annotation.
   */
  returnType(): VariableType | undefined {
    const scope = this.current();
    switch (scope.type) {
      case "global":
        return undefined;
      case "function": {
        const funcDef = this.compilationUnit.functionDefinitions[scope.functionName];
        return funcDef?.returnType ?? undefined;
      }
      case "node": {
        const graphNode = this.compilationUnit.graphNodes.find(
          (n) => n.nodeName === scope.nodeName,
        );
        return graphNode?.returnType ?? undefined;
      }
      default:
        throw new Error(`Unknown scope type: ${(scope as any).type}`);
    }
  }

  /** Whether the surrounding function/node opted-in to runtime return-type validation. */
  returnTypeValidated(): boolean {
    const scope = this.current();
    switch (scope.type) {
      case "function": {
        const funcDef = this.compilationUnit.functionDefinitions[scope.functionName];
        return !!funcDef?.returnTypeValidated;
      }
      case "node": {
        const graphNode = this.compilationUnit.graphNodes.find(
          (n) => n.nodeName === scope.nodeName,
        );
        return !!graphNode?.returnTypeValidated;
      }
      default:
        return false;
    }
  }
}
