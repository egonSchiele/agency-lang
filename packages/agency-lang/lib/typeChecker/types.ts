import type { Scope } from "./scope.js";
import type { FlowEnvironment } from "./flow.js";
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
// Type-only import: diagnostics.ts type-imports TypeCheckError from here, so
// this pair of type-only imports has no runtime cycle.
import type { DiagnosticName } from "./diagnostics.js";

// Every checker diagnostic is built by the diagnostic() factory
// (lib/typeChecker/diagnostics.ts) from the DIAGNOSTICS registry — the
// single source of codes, default severities, and message templates.
export type TypeCheckError = {
  /** Stable AG#### code from the registry (suppression, docs, tests). */
  code: string;
  /** The registry key — the diagnostic's programmatic identity. */
  name: DiagnosticName;
  /** Rendered message (template + params). */
  message: string;
  severity: "error" | "warning";
  /** The structured payload: template placeholders plus any extra
   *  machine-readable keys the site attached. */
  params: Record<string, string | number>;
  /** null = deliberate file-level diagnostic (no AST node reachable). */
  loc: SourceLocation | null;
  /** Source file, stamped once in TypeChecker.check(). */
  file?: string;
};

export type TypeCheckResult = {
  errors: TypeCheckError[];
  scopes: ScopeInfo[];
  interruptEffectsByFunction: Record<string, InterruptEffect[]>;
  interruptCallGraph: InterruptCallGraph;
  /** The flow graph built during the check (PR 1b). Exposed for tests/tooling
   *  (identity guard now; LSP hover / PR 4 later). Undefined if the check threw
   *  before buildFlowGraphs. */
  flowEnv?: FlowEnvironment;
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
  params: (VariableType)[];
  returnType: VariableType;
  minParams?: number; // if set, arity is [minParams, params.length]; otherwise exact
  restParam?: VariableType; // if set, accepts unlimited extra args of this type after the fixed params
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
  acceptsNamedArgs?: Record<string, VariableType>;
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
  inferredReturnTypes: Record<string, VariableType>;
  inferringReturnType: Set<string>;
  /** The value type of each expression-position `match`, keyed by its match id.
   *  Populated by `computeMatchExprTypes` (runs after buildFlowGraphs, before
   *  checkScopes): the widened union of the match's `matchYield` value types, or
   *  "any" if any yield is "any". Consumed by the `__matchval_<id>` synth hook
   *  and the `matchExprSource` assignment check. */
  matchExprTypes: Record<number, VariableType>;
  /** The UNWIDENED value type + source loc of every `matchYield` of each
   *  expression-position `match`, keyed by match id. Populated alongside
   *  `matchExprTypes` by `computeMatchExprTypes`. In a CHECKED position (the
   *  consumer has an annotation / declared return type), each yield is checked
   *  against the expected type individually against ITS unwidened type — a
   *  literal-union annotation (`type C = "a" | "b"`) accepts `"a" => "a"`, and
   *  the error anchors on the offending arm's value. The widened union in
   *  `matchExprTypes` is used only for synthesis (unannotated) positions. */
  matchExprYieldTypes: Record<
    number,
    { type: VariableType; loc: SourceLocation | undefined }[]
  >;
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
  flowEnv?: FlowEnvironment;
  getTypeAliases(): Record<string, TypeAliasEntry>;
  withScope<T>(key: string, fn: () => T): T;
  inferReturnTypeFor(
    name: string,
    def: FunctionDefinition | GraphNodeDefinition,
  ): VariableType;
};
