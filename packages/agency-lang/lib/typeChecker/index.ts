import { color } from "@/utils/termcolors.js";
import type {
  CompilationUnit,
  ImportedFunctionSignature,
} from "../compilationUnit.js";
import { GLOBAL_SCOPE_KEY, ScopedTypeAliases, scopeKey, buildCompilationUnit } from "../compilationUnit.js";
import { AgencyConfig } from "../config.js";
import {
  AgencyProgram,
  FunctionDefinition,
  GraphNodeDefinition,
  VariableType,
} from "../types.js";
import { TypeCheckError, TypeCheckResult, TypeCheckerContext } from "./types.js";
import { validateTypeReferences } from "./validate.js";
import { inferReturnTypes } from "./inference.js";
import { buildScopes } from "./scopes.js";
import { checkScopes } from "./checker.js";
import { isAssignable as _isAssignable } from "./assignability.js";
import { inferReturnTypeFor } from "./inference.js";

export type { TypeCheckError, TypeCheckResult } from "./types.js";

export class TypeChecker {
  private program: AgencyProgram;
  private config: AgencyConfig;
  private scopedTypeAliases: ScopedTypeAliases = new ScopedTypeAliases();
  private currentScopeKey: string = GLOBAL_SCOPE_KEY;
  private functionDefs: Record<string, FunctionDefinition> = {};
  private nodeDefs: Record<string, GraphNodeDefinition> = {};
  private importedFunctions: Record<string, ImportedFunctionSignature> = {};
  private errors: TypeCheckError[] = [];
  private inferredReturnTypes: Record<string, VariableType | "any"> = {};
  private inferringReturnType = new Set<string>();

  constructor(program: AgencyProgram, config: AgencyConfig = {}, info?: CompilationUnit) {
    this.program = program;
    this.config = config;
    const resolved = info ?? buildCompilationUnit(program);
    this.scopedTypeAliases = resolved.typeAliases.clone();
    this.functionDefs = { ...resolved.functionDefinitions };
    this.nodeDefs = Object.fromEntries(
      resolved.graphNodes.map((n) => [n.nodeName, n]),
    );
    this.importedFunctions = { ...resolved.importedFunctions };
  }

  private get typeAliases(): Record<string, VariableType> {
    return this.scopedTypeAliases.visibleIn(this.currentScopeKey);
  }

  private withScope<T>(key: string, fn: () => T): T {
    const prev = this.currentScopeKey;
    this.currentScopeKey = key;
    try {
      return fn();
    } finally {
      this.currentScopeKey = prev;
    }
  }

  private makeContext(): TypeCheckerContext {
    const ctx: TypeCheckerContext = {
      programNodes: this.program.nodes,
      scopedTypeAliases: this.scopedTypeAliases,
      currentScopeKey: this.currentScopeKey,
      functionDefs: this.functionDefs,
      nodeDefs: this.nodeDefs,
      importedFunctions: this.importedFunctions,
      errors: this.errors,
      inferredReturnTypes: this.inferredReturnTypes,
      inferringReturnType: this.inferringReturnType,
      config: this.config,
      getTypeAliases: () => this.typeAliases,
      withScope: <T>(key: string, fn: () => T): T => this.withScope(key, fn),
      inferReturnTypeFor: (name, def) => inferReturnTypeFor(name, def, ctx),
    };
    return ctx;
  }

  check(): TypeCheckResult {
    this.errors = [];
    const ctx = this.makeContext();

    // 1. Validate type alias references
    for (const [sk, scopeAliases] of this.scopedTypeAliases.scopes()) {
      this.withScope(sk, () => {
        for (const [name, aliasedType] of Object.entries(scopeAliases)) {
          validateTypeReferences(aliasedType, name, this.typeAliases, this.errors);
        }
      });
    }

    // 1b. Warn on local definitions that shadow imported functions/nodes.
    // functionDefs and nodeDefs are mutually exclusive by construction
    // (a name is parsed as one or the other, never both).
    for (const [name, def] of Object.entries(this.functionDefs)) {
      if (this.importedFunctions[name]) {
        this.errors.push({
          message: `'${name}' shadows an imported function.`,
          loc: def.loc,
        });
      }
    }
    for (const [name, def] of Object.entries(this.nodeDefs)) {
      if (this.importedFunctions[name]) {
        this.errors.push({
          message: `'${name}' shadows an imported function.`,
          loc: def.loc,
        });
      }
    }

    // 2. Infer return types
    inferReturnTypes(ctx);

    // 3. Build scopes (collects variable types and checks assignments)
    const scopes = buildScopes(ctx);

    // 4. Check function calls, return types, and expressions
    checkScopes(scopes, ctx);

    return { errors: this.deduplicateErrors() };
  }

  private deduplicateErrors(): TypeCheckError[] {
    const seen = new Set<string>();
    return this.errors.filter((err) => {
      const key = `${err.message}:${err.loc?.start ?? -1}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Delegating method preserved for test compatibility. */
  isAssignable(
    source: VariableType | "any",
    target: VariableType | "any",
  ): boolean {
    return _isAssignable(source, target, this.typeAliases);
  }
}

export function typeCheck(
  program: AgencyProgram,
  config: AgencyConfig = {},
  info?: CompilationUnit,
): TypeCheckResult {
  const checker = new TypeChecker(program, config, info);
  return checker.check();
}

export function formatErrors(
  errors: TypeCheckError[],
  errorType: "warning" | "error" = "error",
): string {
  return errors
    .map((err) => {
      const colorFunc = errorType === "warning" ? color.yellow : color.red;
      return `${colorFunc(errorType)}: ${err.message}`;
    })
    .join("\n");
}
