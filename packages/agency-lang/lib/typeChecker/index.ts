import { color } from "@/utils/termcolors.js";
import type {
  CompilationUnit,
  ImportedFunctionSignature,
} from "../compilationUnit.js";
import type { InterruptEffect } from "../symbolTable.js";
import {
  GLOBAL_SCOPE_KEY,
  ScopedTypeAliases,
  scopeKey,
  buildCompilationUnit,
} from "../compilationUnit.js";
import { AgencyConfig } from "../config.js";
import {
  AgencyProgram,
  FunctionDefinition,
  GraphNodeDefinition,
  TypeAliasEntry,
  VariableType,
} from "../types.js";
import type { SourceLocation } from "../types/base.js";
import {
  TypeCheckError,
  TypeCheckResult,
  TypeCheckerContext,
} from "./types.js";
import { validateTypeReferences } from "./validate.js";
import { applySuppressions, parseSuppressions } from "./suppression.js";
import { inferReturnTypes } from "./inference.js";
import { buildScopes } from "./scopes.js";
import { buildFlowGraphs } from "./flowBuilder.js";
import { checkScopes } from "./checker.js";
import { isAssignable as _isAssignable } from "./assignability.js";
import { inferReturnTypeFor } from "./inference.js";
import { effectiveReturnType } from "./validation.js";
import {
  analyzeInterruptsFromScopes,
  buildInterruptCallGraph,
  checkUnhandledInterruptWarnings,
  checkCallbackBodyInterrupts,
  checkHandlerBodyInterrupts,
} from "./interruptAnalysis.js";
import { checkAllRaises } from "./functionTypeRaises.js";
import { checkMatchExhaustiveness } from "./matchExhaustiveness.js";
import { computeMatchExprTypes } from "./matchExprTypes.js";
import { checkDefiniteReturns } from "./definiteReturns.js";
import { refineInlineHandlerParams } from "./handlerParamTyping.js";
import { checkEffectPayloads, buildEffectRegistry } from "./effectPayloadCheck.js";
import type { SymbolTable } from "../symbolTable.js";
import { checkUndefinedFunctions } from "./undefinedFunctionDiagnostic.js";
import { checkUndefinedVariables } from "./undefinedVariableDiagnostic.js";
import { checkToolBlockBindings } from "./toolBlockBinding.js";
import { RESERVED_FUNCTION_NAMES } from "./resolveCall.js";
import { RESERVED_GENERIC_NAMES } from "./builtinGenerics.js";
import { validateStaticInit } from "./validateStaticInit.js";
import { walkNodes } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";

export type { TypeCheckError, TypeCheckResult } from "./types.js";

/** Type-alias names that resolve to built-in types. */
const RESERVED_TYPE_NAMES = new Set<string>([
  "Result",
  "Success",
  "Failure",
  // `keyof` is a keyword in type position; an alias with this name would
  // silently change how annotations parse.
  "keyof",
  ...RESERVED_GENERIC_NAMES,
]);

export class TypeChecker {
  private program: AgencyProgram;
  private config: AgencyConfig;
  private scopedTypeAliases: ScopedTypeAliases = new ScopedTypeAliases();
  private currentScopeKey: string = GLOBAL_SCOPE_KEY;
  private functionDefs: Record<string, FunctionDefinition> = {};
  private nodeDefs: Record<string, GraphNodeDefinition> = {};
  private importedFunctions: Record<string, ImportedFunctionSignature> = {};
  private jsImportedNames: Record<string, true> = {};
  private interruptEffectsByFunction: Record<string, InterruptEffect[]> = {};
  private symbolTable?: SymbolTable;
  private currentFile?: string;
  private errors: TypeCheckError[] = [];
  private inferredReturnTypes: Record<string, VariableType | "any"> = {};
  private inferringReturnType = new Set<string>();
  private sourceText: string | undefined;

  constructor(
    program: AgencyProgram,
    config: AgencyConfig = {},
    info?: CompilationUnit,
  ) {
    this.program = program;
    this.config = config;
    const resolved = info ?? buildCompilationUnit(program);
    this.scopedTypeAliases = resolved.typeAliases.clone();
    this.functionDefs = { ...resolved.functionDefinitions };
    this.nodeDefs = Object.fromEntries(
      resolved.graphNodes.map((n) => [n.nodeName, n]),
    );
    this.importedFunctions = { ...resolved.importedFunctions };
    this.jsImportedNames = { ...resolved.jsImportedNames };
    this.interruptEffectsByFunction = resolved.interruptEffectsByFunction ?? {};
    this.symbolTable = resolved.symbolTable;
    this.currentFile = resolved.fromFile;
    this.sourceText = resolved.sourceText;
  }

  private get typeAliases(): Record<string, TypeAliasEntry> {
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
      jsImportedNames: this.jsImportedNames,
      interruptEffectsByFunction: this.interruptEffectsByFunction,
      symbolTable: this.symbolTable,
      currentFile: this.currentFile,
      errors: this.errors,
      inferredReturnTypes: this.inferredReturnTypes,
      inferringReturnType: this.inferringReturnType,
      matchExprTypes: {},
      matchExprYieldTypes: {},
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

    const aliasDeclLocs = this.collectAliasDeclLocs();

    // Validate type alias references
    for (const [sk, scopeAliases] of this.scopedTypeAliases.scopes()) {
      this.withScope(sk, () => {
        for (const [name, entry] of Object.entries(scopeAliases)) {
          // Type parameters declared on a generic alias are in scope inside
          // its own body. Add them to the visible alias set as opaque entries
          // so references like `T` don't get flagged as undefined.
          const localAliases: Record<string, TypeAliasEntry> = {
            ...this.typeAliases,
          };
          if (entry.typeParams) {
            for (const p of entry.typeParams) {
              localAliases[p.name] = {
                body: { type: "typeAliasVariable", aliasName: p.name },
              };
            }
            // Defaults must come after all required parameters.
            let seenDefault = false;
            for (const p of entry.typeParams) {
              if (p.default) {
                seenDefault = true;
              } else if (seenDefault) {
                this.errors.push(
                  diagnostic(
                    "typeParamDefaultOrder",
                    { param: p.name, alias: name },
                    aliasDeclLocs[name] ?? null,
                  ),
                );
              }
            }
          }
          validateTypeReferences(
            entry.body,
            name,
            localAliases,
            this.errors,
          );
        }
      });
    }

    // Warn on local definitions that shadow imported functions/nodes.
    // functionDefs and nodeDefs are mutually exclusive by construction
    // (a name is parsed as one or the other, never both).
    const shadowWarning = (name: string, loc: SourceLocation | undefined) =>
      this.errors.push(diagnostic("shadowsImportedFunction", { name }, loc ?? null));
    for (const [name, def] of Object.entries(this.functionDefs)) {
      if (this.importedFunctions[name]) shadowWarning(name, def.loc);
    }
    for (const [name, def] of Object.entries(this.nodeDefs)) {
      if (this.importedFunctions[name]) shadowWarning(name, def.loc);
    }

    // Reserve names baked into the language. The synth pipeline relies
    // on `success(x)` and `failure(msg)` parameterizing ResultType, and on
    // `Result` being the built-in type. Allowing user definitions of these
    // names would silently change semantics.
    const reservedFn = (name: string, loc: SourceLocation | undefined) =>
      this.errors.push(diagnostic("reservedBuiltinRedefined", { name }, loc ?? null));
    for (const [name, def] of Object.entries(this.functionDefs)) {
      if (RESERVED_FUNCTION_NAMES.has(name)) reservedFn(name, def.loc);
    }
    for (const [name, def] of Object.entries(this.nodeDefs)) {
      if (RESERVED_FUNCTION_NAMES.has(name)) reservedFn(name, def.loc);
    }
    for (const [, aliases] of this.scopedTypeAliases.scopes()) {
      for (const name of Object.keys(aliases)) {
        if (RESERVED_TYPE_NAMES.has(name)) {
          this.errors.push(
            diagnostic(
              "reservedBuiltinTypeRedefined",
              { name },
              aliasDeclLocs[name] ?? null,
            ),
          );
        }
      }
    }

    // Reserved names cannot be `let`/`const` / `static const` declared
    // either. The variable would be unusable as a function (e.g. `schema(X)`
    // always parses as a SchemaExpression regardless of scope), and shadowing
    // primitives like `success`/`failure` silently changes semantics.
    // Walk every assignment in the program — top-level and inside function /
    // graphNode bodies — and check the variable name. Only fires on actual
    // declarations (where `declKind` is set), not reassignments.
    for (const { node } of walkNodes(this.program.nodes)) {
      if (node.type !== "assignment") continue;
      if (!node.declKind) continue;
      if (RESERVED_FUNCTION_NAMES.has(node.variableName)) {
        this.errors.push(
          diagnostic(
            "reservedBuiltinRedefined",
            { name: node.variableName },
            node.loc ?? null,
          ),
        );
      }
    }

    this.checkValidatedParamReturns();
    this.checkDocStringParams();

    // Infer return types
    inferReturnTypes(ctx);

    // Build scopes (collects variable types and checks assignments)
    const scopes = buildScopes(ctx);

    // Analyze interrupts (pure — returns transitive effect sets and pushes
    // no diagnostics; the ctx.errors sites in interruptAnalysis.ts belong to the
    // consumer passes below). Moved ahead of flow/checkScopes so the handler-param
    // refinement can run before field-access checking.
    const interruptEffectsByFunction = analyzeInterruptsFromScopes(scopes, ctx);

    // Build the ambient effect→payload registry ONCE and share it with both
    // the handler-param refinement (below) and checkEffectPayloads below. Building
    // it once avoids double-reporting payload conflicts.
    const effectRegistry = buildEffectRegistry(ctx);

    // H3: re-type each eligible inline handler param `e` as a per-effect
    // discriminated union carrying that effect's declared payload as `data`.
    // MUST run before checkScopes so `e.data` usage sites narrow correctly.
    refineInlineHandlerParams(scopes, interruptEffectsByFunction, ctx, effectRegistry);

    // Build the flow graph AFTER the param retype so the oracle is seeded with
    // the refined `e` from the start. (Ordering kept for oracle-seeding
    // quality; since the generation counter, a post-flow retype would also be
    // sound — the declare would bump the generation and the memo would
    // self-invalidate.)
    buildFlowGraphs(scopes, ctx);

    // Compute the value type of every expression-position `match` (union of
    // its matchYield types). Runs AFTER buildFlowGraphs so yield synthesis sees
    // flow-narrowed bindings (e.g. `"a" => e.val` under a discriminant match),
    // and before checkScopes so the `__matchval_<id>` synth hook and the
    // `matchExprSource` assignment check can read the results. Patches each
    // consumer variable's scope entry AND its eagerly-snapshotted `assign` flow
    // node with the computed union.
    computeMatchExprTypes(scopes, ctx);

    // Check function calls, return types, and expressions. `e.data` is now
    // payload-typed → narrowing on `e.effect` makes `e.data` concrete here.
    checkScopes(scopes, ctx);

    // Build the per-function interrupt call graph used by
    // `agency interrupts` for static handler-set analysis. The
    // existing analyzeInterruptsFromScopes pass continues to compute
    // transitive kinds; this is purely additive structural info.
    const interruptCallGraph = buildInterruptCallGraph(scopes, ctx);

    // Check for unhandled interrupt warnings (uses transitive results)
    checkUnhandledInterruptWarnings(scopes, interruptEffectsByFunction, ctx);

    // Reject `interrupt` inside any callback body. Callbacks fire as
    // side effects; their body cannot pause execution.
    checkCallbackBodyInterrupts(scopes, interruptEffectsByFunction, ctx);

    // Reject handlers whose body may itself raise an interrupt — that
    // re-enters the handler chain and recurses (see HandlerRecursionError).
    checkHandlerBodyInterrupts(scopes, interruptEffectsByFunction, ctx);

    // Verify declared `raises` clauses (on def/node and on function types) are
    // not exceeded by the values' inferred effect sets.
    checkAllRaises(scopes, interruptEffectsByFunction, ctx);

    // Check interrupt payloads against `effect` declarations (shared registry).
    checkEffectPayloads(scopes, ctx, effectRegistry);

    // Match exhaustiveness over closed value types.
    checkMatchExhaustiveness(scopes, ctx);

    // Definite-return: a function with a non-void return type must `return`
    // on every path. Reads the per-scope terminal flow node from buildFlowGraphs.
    checkDefiniteReturns(scopes, ctx);

    // Check for undefined function calls (config-controlled severity).
    checkUndefinedFunctions(scopes, ctx);

    // Check for undefined variable references (config-controlled severity).
    checkUndefinedVariables(scopes, ctx);

    // Tool-position binding validator: at every llm(...) call site
    // with a statically-known tools array, require every function-typed
    // parameter to be bound (error) or warn when an optional one is left
    // dropped. See lib/typeChecker/toolBlockBinding.ts for the helpers
    // and docs/superpowers/specs/2026-06-03-tool-params-blocks-and-variadics-design.md §4.2(e).
    checkToolBlockBindings(this.program, ctx);

    // Validate static initializers + `static <bare>` statements.
    // Direct-only checks against the Phase A surface — per-run-only
    // primitive calls (e.g. `llm()`, `interrupt()`) and obvious
    // post-declaration mutations of statics. Cross-module global
    // reads from statics are caught earlier by `compileClosure`'s
    // `rejectStaticReferencesGlobal`, which has access to the full
    // import closure.
    validateStaticInit(this.program, this.errors);

    this.stampFileOnErrors();

    return {
      errors: this.applySuppressions(this.deduplicateErrors()),
      scopes,
      interruptEffectsByFunction,
      interruptCallGraph,
      flowEnv: ctx.flowEnv,
    };
  }

  /** Validated params let a function short-circuit with a failure before
   *  the body runs. An explicit non-Result return type contradicts that.
   *  (Unannotated returns are auto-wrapped during inference instead.) */
  private checkValidatedParamReturns(): void {
    const checkOne = (
      name: string,
      def: FunctionDefinition | GraphNodeDefinition,
    ) => {
      if (!def.parameters.some((p) => p.validated)) return;
      if (!def.returnType) return;
      const effective = effectiveReturnType(def);
      if (effective && effective.type !== "resultType") {
        const kind = def.type === "function" ? "Function" : "Node";
        // {kind} is a closed enum value (Function | Node), not phrasing —
        // allowed as a param per the sweep recipe.
        this.errors.push(
          diagnostic(
            "validatedParamsRequireResult",
            { kind, name },
            def.loc ?? null,
          ),
        );
      }
    };
    for (const [name, def] of Object.entries(this.functionDefs)) {
      checkOne(name, def);
    }
    for (const [name, def] of Object.entries(this.nodeDefs)) {
      checkOne(name, def);
    }
  }

  /** Doc strings must not interpolate function/node parameters. The
   *  description is built when the tool object is constructed at module
   *  load time — long before the function is ever called — so parameter
   *  values are simply not bound yet. Catch the obvious case here:
   *  `${param}` as a top-level interpolation expression. */
  private checkDocStringParams(): void {
    const checkOne = (def: FunctionDefinition | GraphNodeDefinition) => {
      if (!def.docString) return;
      const paramNames = def.parameters.map((p) => p.name);
      for (const seg of def.docString.segments) {
        if (
          seg.type === "interpolation" &&
          seg.expression.type === "variableName" &&
          paramNames.includes(seg.expression.value)
        ) {
          this.errors.push(
            diagnostic(
              "docStringParamInterpolation",
              { param: seg.expression.value },
              seg.loc ?? def.docString.loc ?? null,
            ),
          );
        }
      }
    };
    for (const def of Object.values(this.functionDefs)) {
      checkOne(def);
    }
    for (const def of Object.values(this.nodeDefs)) {
      checkOne(def);
    }
  }

  /** Locations of locally-declared type aliases, for diagnostics raised
   *  from the alias TABLE (which carries no locs). Imported aliases are not
   *  in program.nodes and resolve to null (file-level diagnostic). */
  private collectAliasDeclLocs(): Record<string, SourceLocation> {
    const aliasDeclLocs: Record<string, SourceLocation> = Object.create(null);
    for (const { node } of walkNodes(this.program.nodes)) {
      if (node.type === "typeAlias" && node.loc) {
        aliasDeclLocs[node.aliasName] = node.loc;
      }
    }
    return aliasDeclLocs;
  }

  /** Stamp the source file onto every diagnostic, once. One checker instance
   *  checks exactly one file (ctx.currentFile), so a single pass here beats
   *  threading the file through every push site. */
  private stampFileOnErrors(): void {
    const file = this.currentFile;
    if (file === undefined) {
      return;
    }
    for (const err of this.errors) {
      err.file = file;
    }
  }

  private applySuppressions(errors: TypeCheckError[]): TypeCheckError[] {
    if (this.sourceText === undefined) return errors;
    return applySuppressions(errors, parseSuppressions(this.sourceText));
  }

  private deduplicateErrors(): TypeCheckError[] {
    return dedupeErrors(this.errors);
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

/**
 * Drop exact duplicates: same code, same rendered message, and same position.
 * The message stays in the key deliberately — one code can render different
 * params at one position (e.g. two assignability checks against different
 * expected types), and both must survive. This is the emit-once band-aid
 * until synth becomes pure (issue: emit-once follow-up); the key just must
 * never be LOSSIER than code+message+position.
 */
export function dedupeErrors(errors: TypeCheckError[]): TypeCheckError[] {
  const seen = new Set<string>();
  return errors.filter((err) => {
    const key = `${err.code}:${err.message}:${err.loc?.start ?? -1}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function formatErrors(errors: TypeCheckError[]): string {
  return errors
    .map((err) => {
      const colorFunc = err.severity === "warning" ? color.yellow : color.red;
      // Display line/col are 1-indexed; loc stores 0-indexed values
      // (docs/dev/locations.md). loc null = file-level diagnostic.
      let where = "";
      if (err.file && err.loc) {
        where = `${err.file}:${err.loc.line + 1}:${err.loc.col + 1} - `;
      } else if (err.file) {
        where = `${err.file} - `;
      }
      return `${where}${colorFunc(err.severity)} ${err.code}: ${err.message}`;
    })
    .join("\n");
}
