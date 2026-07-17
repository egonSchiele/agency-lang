import type { Scope, TypeAliasEntry, VariableType } from "../../types.js";
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
 * `inDestructiveFunction` is tracked here because destructiveness is a
 * property of the function currently being emitted, which conceptually
 * belongs to the scope stack.
 */
export class ScopeManager {
  private stack: Scope[] = [{ type: "global" }];
  private _inDestructiveFunction: boolean = false;

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

  /**
   * Resolve a relative block depth to the frame binding to read through.
   *
   * `depth` counts block scopes outward from the innermost block: 0 = the
   * current block, 1 = its enclosing block, etc. Depth 0 returns
   * `undefined` so callers keep emitting the existing `__bstack` alias
   * (no fixture churn for non-nested blocks). Depth > 0 returns the
   * unique `__bframe_<blockName>` binding that the block-setup template
   * declares for the owning block, which is in lexical closure scope.
   */
  blockFrameVar(depth: number): string | undefined {
    if (!depth) return undefined;
    const blocks = this.stack.filter(
      (s): s is Extract<Scope, { type: "block" }> => s.type === "block",
    );
    const idx = blocks.length - 1 - depth;
    if (idx < 0) {
      throw new Error(
        `blockFrameVar: depth ${depth} exceeds block nesting (${blocks.length})`,
      );
    }
    return `__bframe_${blocks[idx].blockName}`;
  }

  // ---- Destructive-function flag ----

  get inDestructiveFunction(): boolean {
    return this._inDestructiveFunction;
  }

  set inDestructiveFunction(value: boolean) {
    this._inDestructiveFunction = value;
  }

  // ---- Compilation-unit-backed queries ----

  visibleTypeAliases(): Record<string, VariableType> {
    const entries = this.compilationUnit.typeAliases.visibleIn(this.currentKey());
    // Renderers (typeToString, typeToZodSchema) only need the alias body,
    // not its type parameters. Flatten TypeAliasEntry → VariableType here
    // so those modules keep their existing signature.
    const out: Record<string, VariableType> = {};
    for (const [name, entry] of Object.entries(entries)) {
      out[name] = entry.body;
    }
    return out;
  }

  /**
   * Full TypeAliasEntry-form alias registry for callers (resolveTypeDeep)
   * that need type-parameter metadata to substitute user-defined generic
   * aliases.
   */
  visibleTypeAliasesFull(): Record<string, TypeAliasEntry> {
    return this.compilationUnit.typeAliases.visibleIn(this.currentKey());
  }

  /**
   * Declared return type of the currently-executing function or graph node,
   * or `undefined` for global scope, a function with no annotation, or a
   * block scope.
   *
   * Block scopes (`fork(...) as item { ... }`, `guard(cost: $X) as { ... }`,
   * any `as { ... }` body) currently return `undefined` because we don't
   * carry the block's declared return type onto `Scope.block`. The only
   * caller that matters is `processLlmCall` for a `return llm(...)` inside
   * a block — and `processLlmCall` already defaults `undefined` to
   * `string` for structured-output inference. So today, a bare
   * `return llm(...)` from a block is always typed as `string`.
   *
   * Propagating the block's declared return type (from the enclosing
   * function's block-parameter signature) into the builder would require
   * either threading the parameter type through every `scopes.push({
   * type: "block", ... })` site or looking it up via the typechecker —
   * both substantial. Documented in docs/site/guide/llm.md as a known
   * limitation; users who want a non-string structured type should
   * assign the call: `const x: Foo = llm(...); return x`.
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
      case "block":
        return undefined;
      default:
        throw new Error(`Unknown scope type: ${(scope as any).type}`);
    }
  }

  /**
   * Declared return type of the nearest ENCLOSING function or node,
   * walking outward past block scopes. Unlike `returnType()`, which
   * answers for the CURRENT scope (and answers `undefined` for blocks),
   * this is the saveDraft tool's schema key (partials-ergonomics spec
   * Part 2): a guard block owns the draft slot but carries no declared
   * type, so the enclosing def's declared type is the best-effort hint.
   */
  enclosingDeclaredReturnType(): VariableType | undefined {
    // Innermost-first: the nearest non-block scope answers.
    const owner = [...this.stack]
      .reverse()
      .find((scope) => scope.type !== "block");
    if (owner === undefined) return undefined;
    switch (owner.type) {
      case "function":
        return (
          this.compilationUnit.functionDefinitions[owner.functionName]
            ?.returnType ?? undefined
        );
      case "node":
        return (
          this.compilationUnit.graphNodes.find(
            (n) => n.nodeName === owner.nodeName,
          )?.returnType ?? undefined
        );
      default:
        return undefined; // global scope
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
