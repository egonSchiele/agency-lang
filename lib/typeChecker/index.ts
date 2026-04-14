import { color } from "@/utils/termcolors.js";
import type { ProgramInfo } from "../programInfo.js";
import { GLOBAL_SCOPE_KEY, getVisibleTypes, scopeKey, collectProgramInfo } from "../programInfo.js";
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
import { makeSynthContext } from "./utils.js";

export type { TypeCheckError, TypeCheckResult } from "./types.js";

export class TypeChecker {
  private program: AgencyProgram;
  private config: AgencyConfig;
  private scopedTypeAliases: Record<string, Record<string, VariableType>> = {};
  private currentScopeKey: string = GLOBAL_SCOPE_KEY;
  private functionDefs: Record<string, FunctionDefinition> = {};
  private nodeDefs: Record<string, GraphNodeDefinition> = {};
  private errors: TypeCheckError[] = [];
  private inferredReturnTypes: Record<string, VariableType | "any"> = {};
  private inferringReturnType = new Set<string>();

  constructor(program: AgencyProgram, config: AgencyConfig = {}, info?: ProgramInfo) {
    this.program = program;
    this.config = config;
    const resolved = info ?? collectProgramInfo(program);
    this.scopedTypeAliases = Object.fromEntries(
      Object.entries(resolved.typeAliases).map(([k, v]) => [k, { ...v }]),
    );
    this.functionDefs = { ...resolved.functionDefinitions };
    this.nodeDefs = Object.fromEntries(
      resolved.graphNodes.map((n) => [n.nodeName, n]),
    );
  }

  private get typeAliases(): Record<string, VariableType> {
    return getVisibleTypes(this.scopedTypeAliases, this.currentScopeKey);
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
    return {
      programNodes: this.program.nodes,
      scopedTypeAliases: this.scopedTypeAliases,
      currentScopeKey: this.currentScopeKey,
      functionDefs: this.functionDefs,
      nodeDefs: this.nodeDefs,
      errors: this.errors,
      inferredReturnTypes: this.inferredReturnTypes,
      inferringReturnType: this.inferringReturnType,
      config: this.config,
      getTypeAliases: () => this.typeAliases,
      withScope: <T>(key: string, fn: () => T): T => this.withScope(key, fn),
    };
  }

  check(): TypeCheckResult {
    this.errors = [];
    const ctx = this.makeContext();

    // 1. Validate type alias references
    for (const [sk, scopeAliases] of Object.entries(this.scopedTypeAliases)) {
      this.withScope(sk, () => {
        for (const [name, aliasedType] of Object.entries(scopeAliases)) {
          validateTypeReferences(aliasedType, name, this.typeAliases, this.errors);
        }
      });
    }

    // Create SynthContext once, shared across all phases
    let synthCtx: ReturnType<typeof makeSynthContext>;
    synthCtx = makeSynthContext(ctx, (name, def) =>
      inferReturnTypeFor(name, def, ctx, synthCtx),
    );

    // 2. Infer return types
    inferReturnTypes(ctx, synthCtx);

    // 3. Build scopes (collects variable types and checks assignments)
    const scopes = buildScopes(ctx, synthCtx);

    // 4. Check function calls, return types, and expressions
    checkScopes(scopes, ctx, synthCtx);

    return { errors: this.deduplicateErrors() };
  }

  private deduplicateErrors(): TypeCheckError[] {
    const seen = new Set<string>();
    return this.errors.filter((err) => {
      const key = err.message;
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
  info?: ProgramInfo,
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
