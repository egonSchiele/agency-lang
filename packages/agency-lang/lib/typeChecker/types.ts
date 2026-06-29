import type { Scope } from "./scope.js";
import { AgencyConfig } from "../config.js";
import {
  AgencyNode,
  FunctionDefinition,
  GraphNodeDefinition,
  TypeAliasEntry,
  VariableType,
} from "../types.js";
import { SourceLocation } from "../types/base.js";
import type {
  ImportedFunctionSignature,
  ScopedTypeAliases,
} from "../compilationUnit.js";
import type { InterruptEffect, SymbolTable } from "../symbolTable.js";
import type { InterruptCallGraph } from "./interruptAnalysis.js";

export type TypeCheckError = {
  message: string;
  severity?: "error" | "warning"; // defaults to "error" when omitted
  variableName?: string;
  expectedType?: string;
  actualType?: string;
  loc?: SourceLocation;
};

export type TypeCheckResult = {
  errors: TypeCheckError[];
  scopes: ScopeInfo[];
  interruptEffectsByFunction: Record<string, InterruptEffect[]>;
  interruptCallGraph: InterruptCallGraph;
};

export type ScopeInfo = {
  scope: Scope;
  body: AgencyNode[];
  name: string;
  scopeKey: string;
  /** Absolute path to the .agency file this scope's body lives in. Empty
   *  for the synthetic top-level scope that spans the whole compilation
   *  unit. Populated from `TypeCheckerContext.currentFile`, which itself
   *  comes from `CompilationUnit.fromFile`. */
  file: string;
  returnType?: VariableType | null;
};

export type BuiltinSignature = {
  params: (VariableType | "any")[];
  returnType: VariableType | "any";
  minParams?: number; // if set, arity is [minParams, params.length]; otherwise exact
  restParam?: VariableType | "any"; // if set, accepts unlimited extra args of this type after the fixed params
  /** One-line markdown description shown in LSP hover. */
  description?: string;
  /** If true, the typechecker allows a block argument on calls to this
   *  builtin. Used by language-construct builtins like `fork` / `race`. */
  acceptsBlock?: boolean;
  /** Allowlist of named arguments this builtin recognizes, mapped to
   *  the expected value type. Empty/absent means "no named args
   *  allowed" (today's default — builtins have no parameter names,
   *  so the backend can't bind arbitrary kwargs). Concurrency
   *  builtins use this to permit `fork(items, shared: true)` /
   *  `race(items, shared: true)` without opening the door to typos
   *  silently going through. Values are typechecked against the
   *  declared type; duplicates are rejected. Use `"any"` to skip
   *  value validation. */
  acceptsNamedArgs?: Record<string, VariableType | "any">;
};

export type TypeCheckerContext = {
  programNodes: AgencyNode[];
  scopedTypeAliases: ScopedTypeAliases;
  currentScopeKey: string;
  functionDefs: Record<string, FunctionDefinition>;
  nodeDefs: Record<string, GraphNodeDefinition>;
  importedFunctions: Record<string, ImportedFunctionSignature>;
  /** Names brought in by non-Agency JS imports — see CompilationUnit. */
  jsImportedNames: Record<string, true>;
  interruptEffectsByFunction: Record<string, InterruptEffect[]>;
  errors: TypeCheckError[];
  inferredReturnTypes: Record<string, VariableType | "any">;
  inferringReturnType: Set<string>;
  config: AgencyConfig;
  /** Optional symbol table threaded through from `buildCompilationUnit`.
   *  Used by the interrupt call-graph analysis to resolve cross-file
   *  callee identities for `${file}:${name}`-keyed propagation. Optional
   *  because callers that construct a TypeCheckerContext directly (e.g.
   *  in legacy tests) may not have a symbol table. */
  symbolTable?: SymbolTable;
  /** Absolute path of the file currently being typechecked. Populated
   *  from `CompilationUnit.fromFile` so scope/file tagging (and the
   *  interrupt call-graph analysis) can use a reliable per-file
   *  identity instead of looking names up in the global symbol table. */
  currentFile?: string;
  /** Flow graph built by `buildFlowGraphs` (PR 1b). Populated but not yet
   *  consulted — PR 2 routes `synthValueAccess` through `typeAt`. */
  flowEnv?: import("./flow.js").FlowEnvironment;
  getTypeAliases(): Record<string, TypeAliasEntry>;
  withScope<T>(key: string, fn: () => T): T;
  inferReturnTypeFor(
    name: string,
    def: FunctionDefinition | GraphNodeDefinition,
  ): VariableType | "any";
};
