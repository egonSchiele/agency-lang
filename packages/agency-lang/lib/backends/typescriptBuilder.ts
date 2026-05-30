/* eslint-disable max-lines -- legacy file slated for incremental refactor */
import {
  AgencyComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  BlockType,
  Expression,
  Keyword,
  Literal,
  NamedArgument,
  PromptSegment,
  FunctionScope,
  ScopeType,
  SplatExpression,
  TypeAlias,
  VariableType,
} from "../types.js";
import path from "path";
import { formatTypeHint, formatTypeHintTs } from "@/utils/formatType.js";
import {
  BUILTIN_FUNCTIONS,
  BUILTIN_TOOLS,
  BUILTIN_VARIABLES,
  TYPES_THAT_DONT_TRIGGER_NEW_PART,
} from "@/config.js";
import type { SourceLocationOpts } from "@/runtime/state/checkpointStore.js";
import { BlockArgument } from "@/types/blockArgument.js";
import { DebuggerStatement } from "@/types/debuggerStatement.js";
import { SchemaExpression } from "@/types/schemaExpression.js";
import { expressionToString } from "@/utils/node.js";
import { trimDocStringSegments } from "@/utils/docStringText.js";
import { toCompiledImportPath } from "../importPaths.js";
import * as renderDebugger from "../templates/backends/typescriptGenerator/debugger.js";
import * as renderImports from "../templates/backends/typescriptGenerator/imports.js";
import * as renderInterruptAssignment from "../templates/backends/typescriptGenerator/interruptAssignment.js";
import * as renderInterruptReturn from "../templates/backends/typescriptGenerator/interruptReturn.js";
import * as renderBlockSetup from "../templates/backends/typescriptGenerator/blockSetup.js";
import * as renderForkBlockSetup from "../templates/backends/typescriptGenerator/forkBlockSetup.js";
import * as renderBuiltinToolRegistration from "../templates/backends/typescriptGenerator/builtinToolRegistration.js";
import * as renderResultCheckpointSetup from "../templates/backends/typescriptGenerator/resultCheckpointSetup.js";
import * as renderFunctionCatchFailure from "../templates/backends/typescriptGenerator/functionCatchFailure.js";


import { AgencyConfig } from "@/config.js";
import {
  BinOpArgument,
  BinOpExpression,
  Operator,
  PRECEDENCE,
} from "@/types/binop.js";
import { MessageThread } from "@/types/messageThread.js";
import { walkNodes } from "@/utils/node.js";
import { AccessChainElement, ValueAccess } from "../types/access.js";
import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
} from "../types/dataStructures.js";
import { ForLoop } from "../types/forLoop.js";
import { TryExpression } from "../types/tryExpression.js";
import {
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
} from "../types/function.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { HandleBlock } from "../types/handleBlock.js";
import { WithModifier } from "../types/withModifier.js";
import { IfElse } from "../types/ifElse.js";
import {
  ImportNodeStatement,
  ImportStatement,
} from "../types/importStatement.js";
import { MatchBlock, MatchBlockCase } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { GotoStatement } from "../types/gotoStatement.js";
import { WhileLoop } from "../types/whileLoop.js";
import { NewExpression } from "../types/newExpression.js";
import { InterruptStatement } from "../types/interruptStatement.js";
import { moduleIdToOrigin } from "../runtime/origin.js";
import { escape, mergeDeep } from "../utils.js";
import {
  generateBuiltinHelpers,
  mapFunctionName,
} from "./typescriptGenerator/builtins.js";
import {
  DEFAULT_SCHEMA,
  mapTypeToValidationSchema,
} from "./typescriptGenerator/typeToZodSchema.js";
import {
  buildValidationDescriptor,
  hasAnyValidateTag,
} from "./typescriptGenerator/validationDescriptor.js";
import { resolveTypeDeep } from "../typeChecker/assignability.js";

import { $, ts } from "../ir/builders.js";
import { printTs } from "../ir/prettyPrint.js";
import type {
  TsNode,
  TsObjectEntry,
  TsParam,
  TsTemplatePart,
} from "../ir/tsIR.js";
import type { CompilationUnit } from "../compilationUnit.js";
import { SourceMapBuilder } from "./sourceMap.js";
import { ScopeManager } from "./typescriptBuilder/scopeManager.js";
import { StepPathTracker } from "./typescriptBuilder/stepPathTracker.js";
import { NameClassifier } from "./typescriptBuilder/nameClassifier.js";
import { PipeChainEmitter } from "./typescriptBuilder/pipeChainEmitter.js";
import { AssignmentEmitter } from "./typescriptBuilder/assignmentEmitter.js";
import {
  assembleSections,
  partitionProgram,
} from "./typescriptBuilder/sectionAssembler.js";
import { resolveNamedArgs } from "./typescriptBuilder/namedArgsResolver.js";

const DEFAULT_PROMPT_NAME = "__promptVar";

/** Maps Agency compound-assignment operators to their underlying binary
 *  operator. Used to lower `foo <op>= rhs` into a get/set pair when `foo`
 *  is a global, since globals can't appear on the LHS of an assignment.
 *  Covers every compound operator the parser recognizes. */
const COMPOUND_ASSIGN_TO_BINARY: Record<string, string> = {
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "??=": "??",
  "||=": "||",
  "&&=": "&&",
};

/** Runner IR node kinds that already manage their own step counter/path and
 *  must NOT be wrapped inside a runnerStep by processBodyAsParts. */
const COMPOUND_RUNNER_KINDS: ReadonlySet<TsNode["kind"]> = new Set([
  "runnerHandle",
  "runnerHookStep",
  "runnerIfElse",
  "runnerLoop",
  "runnerWhileLoop",
  "runnerThread",
]);

/**
 * Recursively walk a TsNode tree and flip `topLevel: true` on every
 * `scopedVar` node. Used by the tool-description docstring emission
 * path: a `description: "version ${toolVersion}"` interpolation is
 * eagerly evaluated as part of the module-load tool registration
 * object literal, BEFORE any function or node body runs and BEFORE
 * any `agencyStore.run(...)` wrap installs an ALS frame. The pretty
 * printer reads `topLevel` to emit `__globalCtx.globals.get(...)`
 * instead of `getRuntimeContext().ctx.globals.get(...)` — the strict
 * accessor would throw at module load.
 *
 * Generic walker: visits every object-valued field whose value carries
 * a `kind` discriminator, plus arrays of such values. Returns a
 * structurally cloned tree (does NOT mutate the input).
 */
function markTopLevelScopedVars<T extends TsNode>(node: T): T {
  return walkMarkTopLevel(node) as T;
}

/**
 * Recursive helper for `markTopLevelScopedVars`. Walks any plain
 * object (not just TsNode kinds), since some IR carriers like
 * `TsTemplatePart` and `TsObjectEntry` are plain object literals
 * without a `kind` discriminator but still hold nested TsNode
 * children (e.g. `parts[i].expr` for templateLit).
 */
function walkMarkTopLevel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(walkMarkTopLevel);
  }
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj.kind === "scopedVar") {
    return { ...obj, topLevel: true };
  }
  const out: Record<string, unknown> = { ...obj };
  for (const [key, v] of Object.entries(obj)) {
    out[key] = walkMarkTopLevel(v);
  }
  return out;
}

export class TypeScriptBuilder {
  // Output assembly
  private generatedStatements: TsNode[] = [];
  private generatedTypeAliases: TsNode[] = [];
  /**
   * TypeAlias AST nodes whose declaration has been hoisted to the
   * containing function/node's outer scope (so it's visible to every
   * runner.step closure). When processNode sees one of these inside a
   * body, it returns ts.empty() to avoid a redeclaration.
   */
  private hoistedTypeAliasNodes: Set<TypeAlias> = new Set();

  // Import tracking
  private importStatements: TsNode[] = [];
  private toolRegistrations: TsNode[] = [];

  // Function tracking
  private functionsUsed: Set<string> = new Set();

  // Scope management, step-path bookkeeping, and name classification
  // (extracted to helpers).
  private scopes: ScopeManager;
  private steps: StepPathTracker = new StepPathTracker();
  private names: NameClassifier;
  private pipes: PipeChainEmitter;
  private assigns: AssignmentEmitter;

  // Config
  private agencyConfig: AgencyConfig = {};

  // Graph topology tracking
  private adjacentNodes: Record<string, string[]> = {};
  private currentAdjacentNodes: string[] = [];
  private isInsideGraphNode: boolean = false;

  // Threading & control flow
  private loopVars: string[] = [];
  private insideHandlerBody: boolean = false;
  private insideGlobalInit: boolean = false;

  /*
  We break up every function and node body into steps,
  and wrap each statement in an if statement. If that statement
  contains an async function call, we also need to check
  whether we have branch data for this function call already,
  which would indicate that we are returning from an interrupt,
  and need to deserialize the state for this branch. This property
  is here as a flag to indicate that the branch check is needed,
  because this statement contains an async function call.
  */
  private _asyncBranchCheckNeeded: boolean = false;

  private _sourceMapBuilder: SourceMapBuilder = new SourceMapBuilder();


  private compilationUnit: CompilationUnit;
  private moduleId: string;
  private outputFile: string | undefined;

  /**
   * @param config - Agency compiler configuration (model defaults, logging, etc.)
   * @param info - Pre-collected program metadata (function definitions, graph nodes, imports, type hints)
   * @param moduleId - Unique identifier for this module (e.g., "foo.agency"), used to
   *   namespace global variables in the GlobalStore so that different modules' globals
   *   don't collide. Must be consistent between the defining module and any importers.
   * @param outputFile - Absolute path where the generated code will be written.
   *   Used to compute relative import paths for stdlib. If not provided, falls
   *   back to resolving moduleId against cwd.
   */
  constructor(
    config: AgencyConfig | undefined,
    info: CompilationUnit,
    moduleId: string,
    outputFile?: string,
  ) {
    this.agencyConfig = mergeDeep(this.configDefaults(), config || {});
    this.compilationUnit = info;
    this.scopes = new ScopeManager(info);
    this.names = new NameClassifier(info);
    this.pipes = new PipeChainEmitter({
      processNode: (n) => this.processNode(n),
      processValueAccess: (n) => this.processValueAccess(n),
      buildAssignmentLhs: (scope, varName, accessChain) =>
        this.assigns.lhs(scope, varName, accessChain),
      buildStateConfig: () => this.buildStateConfig(),
      zodSchemaFor: (t) => this.zodSchemaFor(t),
      scopes: this.scopes,
    });
    this.assigns = new AssignmentEmitter({
      moduleId,
      processNode: (n) => this.processNode(n),
      buildCallDescriptor: (call) => this.buildCallDescriptor(call),
      buildStateConfig: () => this.buildStateConfig(),
    });
    this.moduleId = moduleId;
    this.outputFile = outputFile;
  }

  private configDefaults(): Partial<AgencyConfig> {
    return {
      maxToolCallRounds: 10,
      // Top-level threshold for runtime subsystem loggers (memory,
      // etc.). Distinct from `client.logLevel` which is the
      // smoltalk-internal one. "info" matches the existing
      // no-debug-by-default behavior — users opt in via agency.json.
      logLevel: "info",
      log: {
        host: "https://statelog.adit.io",
      },
      client: {
        logLevel: "warn",
        defaultModel: "gpt-4o-mini",
        statelog: {
          host: "https://statelog.adit.io",
          projectId: "smoltalk",
        },
      },
    };
  }

  /** Convert a TsNode to string (for use in template-based methods) */
  private str(node: TsNode): string {
    return printTs(node);
  }

  // ------- Lookup helpers -------

  /** Returns the template opts for checkpoint creation (moduleId, scopeName, stepPath as JSON-quoted strings). */
  private checkpointOpts(): Record<keyof SourceLocationOpts, string> {
    return {
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(this.scopes.currentName()),
      stepPath: JSON.stringify(this.steps.joined()),
    };
  }

  private forkBranchSetup(branchKey: string): TsNode[] {
    const stackBranches = ts.prop(ts.runtime.stack, "branches");
    const branchWithBranchKey = ts.index(stackBranches, ts.str(branchKey));

    // forked is a state stack that we will either get from the branch data (if returning from an interrupt)
    // or create new by forking the current stack (if first time hitting this async call)
    const forked = ts.id("__forked");
    return [
      ts.if(
        ts.and(stackBranches, branchWithBranchKey),
        ts.statements([
          ts.assign(forked, ts.prop(branchWithBranchKey, "stack")),
          ts.call(ts.prop(forked, "deserializeMode")),
        ]),
        {
          elseBody: ts.assign(
            forked,
            // Immediate deref inside a step body — use the strict
            // accessor so a missing ALS frame throws the dedicated
            // error instead of `Cannot read 'forkStack' of undefined`.
            ts.call(ts.prop(ts.raw("getRuntimeContext().ctx"), "forkStack")),
          ),
        },
      ),
      ts.assign(stackBranches, ts.or(stackBranches, ts.obj({}))),
      ts.assign(branchWithBranchKey, ts.obj({ stack: forked })),
    ];
  }


  /** Generate a TsNode for `hasInterrupts(x)` */
  private interruptCheck(expr: TsNode): TsNode {
    return ts.call(ts.id("hasInterrupts"), [expr]);
  }

  /** Generate a raw string for `hasInterrupts(x)` */
  private interruptCheckRaw(exprStr: string): TsNode {
    return ts.raw(`hasInterrupts(${exprStr})`);
  }

  private agencyFileToDefaultImportName(agencyFile: string): string {
    return `__graph_${agencyFile.replace(".agency", "").replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }

  // ------- BinOp precedence helpers -------

  private needsParensLeft(child: BinOpArgument, parentOp: Operator): boolean {
    if (child.type !== "binOpExpression") return false;
    // For right-associative ops like **, (2 ** 3) ** 4 needs parens on the left
    if (parentOp === "**") return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
    return PRECEDENCE[child.operator] < PRECEDENCE[parentOp];
  }

  private needsParensRight(child: BinOpArgument, parentOp: Operator): boolean {
    if (child.type !== "binOpExpression") return false;
    return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
  }

  // ------- Main entry point -------

  build(program: AgencyProgram): TsNode {
    // Generate tool registry (empty — AgencyFunction.create() populates it)
    this.generatedStatements.push(this.generateToolRegistry());

    // Sort program nodes into static-init / global-init / top-level buckets.
    const partition = partitionProgram(program, {
      processNode: (n) => this.processNode(n),
      processNodeInGlobalInit: (n) => this.processNodeInGlobalInit(n),
      buildHandlerArrow: (h) => this.buildHandlerArrow(h),
      isTopLevelDeclaration: (n) => this.names.isTopLevelDeclaration(n),
      moduleId: this.moduleId,
    });
    this.generatedStatements.push(...partition.topLevelStatements);

    return assembleSections({
      moduleId: this.moduleId,
      preprocess: this.preprocess(),
      importStatements: this.importStatements,
      generatedImports: this.generateImports(),
      generatedBuiltins: this.generateBuiltins(),
      toolRegistrations: this.toolRegistrations,
      typeAliases: this.generatedTypeAliases,
      staticVarNames: partition.staticVarNames,
      exportedStaticVarNames: partition.exportedStaticVarNames,
      staticInitStatements: partition.staticInitStatements,
      globalInitStatements: partition.globalInitStatements,
      topLevelCallbackStatements: partition.topLevelCallbackStatements,
      generatedStatements: this.generatedStatements,
      postprocess: this.postprocess(),
      sourceMapJson: JSON.stringify(this._sourceMapBuilder.build()),
    });
  }

  // ------- Node dispatch -------

  /** Process a function call argument, unwrapping NamedArgument and SplatExpression. */
  private processCallArg(
    arg: Expression | SplatExpression | NamedArgument,
  ): TsNode {
    if (arg.type === "namedArgument") {
      return this.processNode(arg.value as AgencyNode);
    }
    if (arg.type === "splat") {
      return ts.spread(this.processNode(arg.value as AgencyNode));
    }
    return this.processNode(arg as AgencyNode);
  }

  /** Process resolved arguments into TsNodes, tracking function usage. */
  private processResolvedArgs(
    args: (Expression | SplatExpression)[],
  ): TsNode[] {
    return args.map((arg) => {
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        return this.generateFunctionCallExpression(
          arg as FunctionCall,
          "functionArg",
        );
      } else {
        return this.processCallArg(arg);
      }
    });
  }

  /**
   * Adjust call-site arguments to match the function's parameter list:
   * 1. Pad omitted optional args (those with defaults) with null
   * 2. Wrap extra args into an array for variadic params
   */

  private processNode(node: AgencyNode): TsNode {
    switch (node.type) {
      case "typeAlias":
        if (this.hoistedTypeAliasNodes.has(node)) return ts.empty();
        return this.processTypeAlias(node);
      case "assignment":
        return this.processAssignment(node);
      case "function":
        return this.processFunctionDefinition(node);
      case "functionCall":
        return this.processFunctionCall(node);
      case "valueAccess":
        return this.processValueAccess(node);
      case "comment":
        return this.processComment(node);
      case "multiLineComment":
        return ts.empty();
      case "matchBlock":
        return this.insideHandlerBody
          ? this.processBlockPlain(node)
          : this.processMatchBlockWithSteps(node);
      case "number":
      case "unitLiteral":
      case "multiLineString":
      case "string":
      case "variableName":
      case "boolean":
      case "null":
        return this.generateLiteral(node);
      case "returnStatement":
        return this.processReturnStatement(node);
      case "gotoStatement":
        return this.processGotoStatement(node);
      case "agencyArray":
        return this.processAgencyArray(node);
      case "agencyObject":
        return this.processAgencyObject(node);
      case "graphNode":
        return this.processGraphNode(node);
      case "importStatement":
        this.importStatements.push(this.processImportStatement(node));
        return ts.empty();
      case "importNodeStatement":
        this.importStatements.push(this.processImportNodeStatement(node));
        return ts.empty();
      case "forLoop":
        return this.insideHandlerBody
          ? this.processBlockPlain(node)
          : this.processForLoopWithSteps(node);
      case "whileLoop":
        return this.insideHandlerBody
          ? this.processBlockPlain(node)
          : this.processWhileLoopWithSteps(node);
      case "ifElse":
        return this.insideHandlerBody
          ? this.processBlockPlain(node)
          : this.processIfElseWithSteps(node);
      case "newLine":
        return ts.empty();
      case "rawCode":
        return ts.raw(node.value);
      case "messageThread":
        return this.processMessageThread(node);
      case "handleBlock":
        return this.processHandleBlockWithSteps(node);
      case "withModifier":
        return this.processWithModifier(node);
      case "skill":
        return ts.empty();
      case "binOpExpression":
        return this.processBinOpExpression(node);
      case "keyword":
        return this.processKeyword(node);
      case "debuggerStatement":
        return this.processDebuggerStatement(node);
      case "tryExpression":
        return this.processTryExpression(node);
      case "newExpression":
        return this.processNewExpression(node);
      case "schemaExpression":
        return this.processSchemaExpression(node);
      case "interruptStatement":
        return this.processInterruptStatement(node);
      case "regex":
        return ts.raw(`/${node.pattern}/${node.flags}`);
      case "blockArgument":
        return this.processBlockAsExpression(node);
      default:
        throw new Error(`Unhandled Agency node type: ${(node as any).type}`);
    }
  }

  private processKeyword(node: Keyword): TsNode {
    // Inside a handler body or not inside a stepped loop: emit bare keyword
    const loopSubKey =
      this.steps.currentLoopKey();
    if (this.insideHandlerBody || loopSubKey === undefined) {
      return node.value === "break" ? ts.break() : ts.continue();
    }

    // Inside a runner loop: use runner.breakLoop() / runner.continueLoop()
    // and return from the callback. The runner handles iteration cleanup.
    const method = node.value === "break" ? "breakLoop" : "continueLoop";
    return ts.statements([
      ts.methodCall(ts.id("runner"), method),
      ts.raw("return"),
    ]);
  }

  // ------- Type system (side effects only) -------

  /**
   * Walk a function/node body and collect every typeAlias declaration
   * that belongs to this body's scope. Used to hoist body-local type
   * aliases up to the enclosing function/node's outer scope so the
   * generated zod schemas are visible to every runner.step closure.
   *
   * Delegates body recursion to `walkNodes` so any new body-bearing
   * AST node (thread, parallelBlock, seqBlock, …) is automatically
   * handled. Aliases nested inside a function/graphNode/class method
   * are skipped — those defs hoist their own aliases when their bodies
   * are built.
   */
  private collectBodyTypeAliases(body: AgencyNode[]): TypeAlias[] {
    const collected: TypeAlias[] = [];
    for (const { node, ancestors } of walkNodes(body)) {
      if (node.type !== "typeAlias") continue;
      const inNestedDef = ancestors.some(
        (a) =>
          a.type === "function" ||
          a.type === "graphNode",
      );
      if (inNestedDef) continue;
      collected.push(node);
    }
    return collected;
  }

  /**
   * Hoist body-local type aliases. Returns the generated TS declarations
   * (to be inserted at the top of the enclosing function/node body) and
   * marks each AST node so processNode skips its in-body emission.
   *
   * Coalesces duplicates by alias name: if the same name appears in
   * multiple branches/blocks, only the first declaration is emitted to
   * avoid redeclaration errors at the function scope. (The Agency
   * typechecker is responsible for diagnosing genuine name collisions.)
   */
  private hoistBodyTypeAliases(body: AgencyNode[]): TsNode[] {
    const aliases = this.collectBodyTypeAliases(body);
    const out: TsNode[] = [];
    const seen = new Set<string>();
    for (const alias of aliases) {
      this.hoistedTypeAliasNodes.add(alias);
      if (seen.has(alias.aliasName)) continue;
      seen.add(alias.aliasName);
      out.push(this.processTypeAlias(alias));
    }
    return out;
  }

  private processTypeAlias(node: TypeAlias): TsNode {
    // Generic aliases (type Container<T> = ...) can't be turned into a single
    // zod schema because the body references type parameters that have no
    // runtime value. Usages like `Container<number>` are normalized away by
    // resolveTypeDeep before the zod mapper sees them.
    //
    // For exported aliases we still emit a runtime *stub* (`undefined`) so
    // that another module's `import { Container } from "./a.agency"` resolves
    // at runtime. Concrete uses on the importer side have already been
    // resolved away at codegen, so the imported symbol is never actually
    // consulted as a schema value.
    if (node.typeParams && node.typeParams.length > 0) {
      if (!node.exported) return ts.empty();
      return ts.raw(`export const ${node.aliasName} = undefined;`);
    }
    // Value-parameterized aliases (e.g. `type NumberInRange(low, high) = ...`)
    // have no single schema — every use-site inlines a fresh substituted
    // schema. Emit nothing at the declaration site; importers should never
    // reference the bare name (use-sites are resolved before codegen).
    if (node.valueParams && node.valueParams.length > 0) {
      return ts.empty();
    }
    const exportPrefix = node.exported ? "export " : "";
    // Thread alias-level @validate / @jsonSchema tags onto the body type so
    // appendMeta (in typeToZodSchema) attaches the `.meta(...)` chain to the
    // top-level alias schema. Without this, alias-level annotations would
    // never reach the codegen since only use-site `VariableType.tags` are
    // consulted; alias-level tags live on the `TypeAlias` node itself.
    const aliasedWithTags: VariableType = node.tags
      ? { ...node.aliasedType, tags: [...(node.aliasedType.tags ?? []), ...node.tags] }
      : node.aliasedType;
    const zodSchema = this.zodSchemaFor(aliasedWithTags);
    const stmts: TsNode[] = [
      ts.raw(`${exportPrefix}const ${node.aliasName} = ${zodSchema};`),
      ts.raw(`${exportPrefix}type ${node.aliasName} = z.infer<typeof ${node.aliasName}>;`),
    ];
    // If the alias body carries any `@validate(...)` annotation, attach a
    // descriptor to the schema const so use-site `Foo!` validations can
    // pick it up without re-importing the validator identifiers themselves
    // (those are in scope here, not in the consumer module).
    const aliasesFull = this.scopes.visibleTypeAliasesFull();
    if (hasAnyValidateTag(aliasedWithTags, aliasesFull)) {
      const resolved = resolveTypeDeep(aliasedWithTags, aliasesFull);
      const descriptor = buildValidationDescriptor(
        resolved,
        this.scopes.visibleTypeAliases(),
        aliasesFull,
      );
      // `(Foo as any).__agency_descriptor = ...` — keeps the runtime metadata
      // co-located with the schema and avoids exporting/importing a second
      // symbol. Cast to `any` because Zod's typings don't know about us.
      stmts.push(
        ts.assign(
          ts.prop(
            ts.raw(`(${node.aliasName} as any)`),
            "__agency_descriptor",
          ),
          descriptor,
        ),
      );
    }
    return ts.statements(stmts);
  }

  /**
   * Build a zod validation schema string for a VariableType taken from user
   * source. Deep-resolves user-defined generic aliases first so that uses
   * like `Container<number>` become a concrete object/array/etc. before the
   * (alias-unaware) zod mapper runs.
   */
  private zodSchemaFor(t: VariableType): string {
    const aliasesFull = this.scopes.visibleTypeAliasesFull();
    const resolved = resolveTypeDeep(t, aliasesFull);
    return mapTypeToValidationSchema(
      resolved,
      this.scopes.visibleTypeAliases(),
      aliasesFull,
    );
  }

  /**
   * Build the validation expression for a `!` site. If the resolved type
   * carries no `@validate(...)` tag anywhere, return the existing
   * `__validateType(value, schema)` call (zero behavior change). Otherwise
   * return `await __validateChainRecursive(value, <descriptor>, __ctx)`,
   * which runs Zod parse + the validator chain at each level.
   */
  private validateExpr(t: VariableType, value: TsNode): TsNode {
    const aliasesFull = this.scopes.visibleTypeAliasesFull();
    const resolved = resolveTypeDeep(t, aliasesFull);
    const aliases = this.scopes.visibleTypeAliases();
    if (!hasAnyValidateTag(resolved, aliasesFull)) {
      const zodSchema = mapTypeToValidationSchema(resolved, aliases, aliasesFull);
      return ts.validateType(value, ts.raw(zodSchema));
    }
    const descriptor = buildValidationDescriptor(resolved, aliases, aliasesFull);
    return ts.validateChainRecursive(value, descriptor);
  }

  // ------- Proper IR node methods -------

  private processComment(node: AgencyComment): TsNode {
    return ts.comment(node.content);
  }

  private processAgencyObject(node: AgencyObject): TsNode {
    const entries = node.entries.map((entry): TsObjectEntry => {
      if ("type" in entry && entry.type === "splat") {
        return ts.setSpread(this.processNode(entry.value));
      }
      const kv = entry as AgencyObjectKV;
      if (kv.computedKey) {
        return ts.setComputed(
          this.processNode(kv.computedKey),
          this.processNode(kv.value),
        );
      }
      const keyCode = kv.key.replace(/"/g, '\\"');
      return ts.set(`"${keyCode}"`, this.processNode(kv.value));
    });
    return ts.obj(entries);
  }

  private processAgencyArray(node: AgencyArray): TsNode {
    const items = node.items.map((item) => {
      if (item.type === "splat") {
        return ts.spread(this.processNode(item.value));
      }
      return this.processNode(item);
    });
    return ts.arr(items);
  }

  private generateLiteral(literal: Literal): TsNode {
    switch (literal.type) {
      case "number":
        return ts.num(parseFloat(literal.value));
      case "unitLiteral":
        return ts.num(literal.canonicalValue);
      case "string":
        return this.generateStringLiteralNode(literal.segments);
      case "multiLineString":
        return this.generateStringLiteralNode(literal.segments);
      case "variableName": {
        const importedOrUnknownScope =
          literal.scope === "imported" || !literal.scope;
        const isBuiltinVar = BUILTIN_VARIABLES.includes(literal.value);
        const isLoopVar = this.loopVars.includes(literal.value);
        if (importedOrUnknownScope || isBuiltinVar || isLoopVar) {
          return ts.id(literal.value);
        }
        return ts.scopedVar(literal.value, literal.scope!, this.moduleId);
      }
      case "boolean":
        return ts.bool(literal.value);
      case "null":
        return ts.id("null");
    }
  }

  private generateStringLiteralNode(segments: PromptSegment[]): TsNode {
    const parts: TsTemplatePart[] = [];

    for (const segment of segments) {
      if (segment.type === "text") {
        // Pass raw text — the templateLit printer (prettyPrint.ts) handles
        // all template-literal escaping (\, `, ${). Escaping here would
        // cause the printer to escape our escapes, producing broken output
        // (e.g. a literal `\\\`` instead of `\``).
        const text = segment.value;
        if (parts.length > 0 && parts[parts.length - 1].expr) {
          // Previous part had an expr; start a new part for this text
          parts.push({ text });
        } else if (parts.length > 0) {
          // Previous part is text-only, append to it
          parts[parts.length - 1].text += text;
        } else {
          parts.push({ text });
        }
      } else {
        // Interpolation segment
        const exprNode = this.processNode(segment.expression);
        if (parts.length > 0 && !parts[parts.length - 1].expr) {
          // Previous part is text-only, add expr to it
          parts[parts.length - 1].expr = exprNode;
        } else {
          parts.push({ text: "", expr: exprNode });
        }
      }
    }

    return ts.template(parts);
  }

  private processValueAccess(node: ValueAccess): TsNode {
    let result = this.processNode(node.base);
    // If the base is a function call, await it before accessing properties/methods
    // on the result. Without this, chaining like getGreeting().trim() would call
    // .trim() on the Promise instead of the resolved value.
    if (node.base.type === "functionCall" && node.chain.length > 0) {
      result = ts.raw(`(${this.str(ts.await(result))})`);
    } else if (
      node.chain.length > 0 &&
      node.base.type !== "functionCall" &&
      node.base.type !== "variableName" &&
      node.base.type !== "valueAccess"
    ) {
      // For any non-trivial base (binOp, tryExpression, newExpression,
      // unary, object/array literals, etc.) wrap in parens before
      // applying the chain so `.foo` / `[i]` / `.method()` bind to the
      // whole base expression.
      result = ts.raw(`(${this.str(result)})`);
    }
    for (const element of node.chain) {
      switch (element.kind) {
        case "property":
          result = ts.prop(result, element.name, { optional: element.optional });
          break;
        case "index":
          result = ts.index(result, this.processNode(element.index), { optional: element.optional });
          break;
        case "slice": {
          const args: TsNode[] = [];
          if (element.start) {
            args.push(this.processNode(element.start));
            if (element.end) args.push(this.processNode(element.end));
          } else if (element.end) {
            args.push(ts.raw("0"));
            args.push(this.processNode(element.end));
          }
          const sliceProp = ts.prop(result, "slice", { optional: element.optional });
          result = ts.call(sliceProp, args);
          break;
        }
        case "methodCall": {
          const fnCall = element.functionCall;
          const descriptor = this.buildCallDescriptor(fnCall);
          const callArgs: TsNode[] = [result, ts.str(fnCall.functionName), descriptor];
          if (element.optional) callArgs.push(ts.bool(true));
          result = this.awaitChainCall(ts.call(ts.id("__callMethod"), callArgs), element === node.chain[node.chain.length - 1]);
          break;
        }
        case "call": {
          const descriptor = this.buildCallDescriptor(element);
          const callArgs: TsNode[] = [result, descriptor];
          if (element.optional) callArgs.push(ts.bool(true));
          result = this.awaitChainCall(ts.call(ts.id("__call"), callArgs), element === node.chain[node.chain.length - 1]);
          break;
        }
      }
    }
    return result;
  }

  private awaitChainCall(callExpr: TsNode, isLast: boolean): TsNode {
    return isLast ? ts.await(callExpr) : ts.raw(`(${this.str(ts.await(callExpr))})`);
  }

  private processBinOpExpression(node: BinOpExpression): TsNode {
    if (node.operator === "|>") {
      return this.processPipeExpression(node);
    }
    if (node.operator === "catch") {
      return this.processCatchExpression(node);
    }
    if (node.operator === "=~" || node.operator === "!~") {
      return this.processRegexMatchExpression(node);
    }
    if (node.operator === "++" || node.operator === "--") {
      return ts.postfix(this.processNode(node.left), node.operator);
    }
    if (node.operator === "typeof" || node.operator === "void") {
      return ts.unaryOp(node.operator, this.processNode(node.right));
    }
    // Compound assignment to a global variable: globals are accessed via
    // `__ctx.globals.get(...)`, which is not a valid assignment target,
    // so `foo <op>= rhs` would emit invalid JS. Lower it to an IIFE so
    // the expression still evaluates to the new value (matching JS
    // semantics for `let x = foo += 1`, `return foo += 1`, etc.):
    //
    //   ((__v) => (__ctx.globals.set(file, name, __v), __v))(
    //     __ctx.globals.get(file, name) <op> rhs
    //   )
    const compoundOp = COMPOUND_ASSIGN_TO_BINARY[node.operator];
    if (
      compoundOp !== undefined &&
      node.left.type === "variableName" &&
      node.left.scope === "global"
    ) {
      const name = node.left.value;
      const getNode = ts.scopedVar(name, "global", this.moduleId);
      const rightNode = this.processNode(node.right);
      const newValueExpr = ts.binOp(getNode, compoundOp, rightNode, {
        parenRight: true,
      });
      const setCall = ts.globalSet(this.moduleId, name, ts.id("__v"));
      // Arrow-fn IIFE: `((__v) => (set(...), __v))(newValueExpr)`. The
      // outer parens around the arrow are required — without them JS
      // parses `(__v) => (...)(args)` as an arrow whose body invokes
      // `__v(args)`, never running the IIFE.
      return ts.raw(
        `((__v) => (${this.str(setCall)}, __v))(${this.str(newValueExpr)})`,
      );
    }
    const leftNode = this.processNode(node.left);
    const rightNode = this.processNode(node.right);
    // Agency uses strict equality/inequality: == → ===, != → !==
    const emitOp = node.operator === "==" ? "===" :
      node.operator === "!=" ? "!==" : node.operator;
    return ts.binOp(leftNode, emitOp, rightNode, {
      parenLeft: this.needsParensLeft(node.left, node.operator),
      parenRight: this.needsParensRight(node.right, node.operator),
    });
  }

  private processRegexMatchExpression(node: BinOpExpression): TsNode {
    const leftNode = this.processNode(node.left);
    const rightNode = this.processNode(node.right);
    // foo =~ /bar/ → /bar/.test(foo)
    // foo !~ /bar/ → !(/bar/.test(foo))
    const testCall = ts.call(ts.prop(rightNode, "test"), [leftNode]);
    if (node.operator === "!~") {
      return ts.unaryOp("!", testCall, { paren: true });
    }
    return testCall;
  }

  private processCatchExpression(node: BinOpExpression): TsNode {
    const left = this.processNode(node.left);
    const right = this.processNode(node.right);
    return ts.await(
      ts.call(ts.id("__catchResult"), [
        left,
        ts.arrowFn([], ts.statements([ts.return(right)]), { async: true }),
      ]),
    );
  }

  private processPipeExpression(node: BinOpExpression): TsNode {
    const left = this.processNode(node.left);
    return this.pipes.bind(left, node.right);
  }

  private processTryExpression(node: TryExpression): TsNode {
    if (node.call.type === "functionCall" && node.call.functionName === "throw") {
      throw new Error(
        "Cannot use 'try' with 'throw' — throw always raises an error.",
      );
    }
    const callNode = this.processNode(node.call as AgencyNode);
    const args: TsNode[] = [ts.arrowFn([], callNode, { async: true })];
    const scope = this.scopes.current();
    if (scope.type === "function") {
      args.push(
        ts.obj({
          // Inside the function body's withAlsFrame wrap — strict
          // accessor so a missing frame throws cleanly instead of a
          // generic "Cannot read 'getResultCheckpoint' of undefined".
          checkpoint: ts.raw("getRuntimeContext().ctx.getResultCheckpoint()"),
          functionName: ts.str((scope as FunctionScope).functionName),
          args: ts.raw("__stack.args"),
        }),
      );
    }
    return ts.await(ts.call(ts.id("__tryCall"), args));
  }

  // ------- Class compilation -------

  private processNewExpression(node: NewExpression): TsNode {
    const args = node.arguments.map((a) => this.processNode(a as AgencyNode));
    return ts.new(ts.id(node.className), args);
  }

  private processSchemaExpression(node: SchemaExpression): TsNode {
    const zodSchema = this.zodSchemaFor(node.typeArg);
    return ts.new(ts.id("Schema"), [ts.raw(zodSchema)]);
  }

  /**
   * After the ALS migration AND the trailing-`state`-arg drop, every
   * Agency call site reads `ctx` / `stack` / `threads` / `callsite`
   * from the active `agencyStore` frame. `__call` / `__callMethod` no
   * longer accept a state-extras object, and the codegen never emits
   * one. This helper is kept as a stable seam in case future codegen
   * needs to attach per-call metadata, but for now it always returns
   * `undefined` — callers should simply omit the third positional.
   *
   * Async-fork sites that need to override the active branch stack
   * wrap their `__call(...)` invocation in an `agencyStore.run`
   * frame in codegen (see `emitRuntimeDispatchCall`) — not via this
   * helper.
   */
  private buildStateConfig(): TsNode | undefined {
    return undefined;
  }


  private processIfElseWithSteps(node: IfElse): TsNode {
    const id = this.steps.currentId();

    // Flatten the else-if chain.
    // Each branch gets a unique range of substep IDs so source map
    // entries never collide between branches.
    const branches: { condition: TsNode; body: TsNode[] }[] = [];
    let elseBranch: TsNode[] | undefined;
    let nextStartId = 0;

    const thenBody = this.processBodyAsParts(node.thenBody, nextStartId);
    nextStartId += thenBody.length;
    branches.push({
      condition: this.processNode(node.condition),
      body: thenBody,
    });

    let current: IfElse | undefined =
      node.elseBody?.length === 1 && node.elseBody[0].type === "ifElse"
        ? (node.elseBody[0] as IfElse)
        : undefined;
    let remainingElse = current ? undefined : node.elseBody;

    while (current) {
      const body = this.processBodyAsParts(current.thenBody, nextStartId);
      nextStartId += body.length;
      branches.push({
        condition: this.processNode(current.condition),
        body,
      });
      if (
        current.elseBody?.length === 1 &&
        current.elseBody[0].type === "ifElse"
      ) {
        current = current.elseBody[0] as IfElse;
      } else {
        remainingElse = current.elseBody;
        current = undefined;
      }
    }

    if (remainingElse && remainingElse.length > 0) {
      elseBranch = this.processBodyAsParts(remainingElse, nextStartId);
    }

    return ts.runnerIfElse({ id, branches, elseBranch });
  }

  private processForLoopWithSteps(node: ForLoop): TsNode {
    const id = this.steps.currentId();

    // Register loop variables so they bypass scope resolution
    this.loopVars.push(node.itemVar as string);
    if (node.indexVar) {
      this.loopVars.push(node.indexVar);
    }

    const subKey = this.steps.joined();

    this.steps.pushLoop(subKey);
    const bodyNodes = this.processBodyAsParts(node.body);
    this.steps.popLoop();

    // Unregister loop variables
    this.loopVars = this.loopVars.filter(
      (v) => v !== node.itemVar && v !== node.indexVar,
    );

    // For range form, build an array expression: Array.from({length: end - start}, (_, i) => i + start)
    // Actually, the Runner's loop() takes an array of items. For range loops,
    // we generate the range as an array expression.
    if (
      node.iterable.type === "functionCall" &&
      node.iterable.functionName === "range"
    ) {
      const args = node.iterable.arguments;
      const startNode =
        args.length >= 2 ? this.processCallArg(args[0]) : ts.num(0);
      const endNode =
        args.length >= 2
          ? this.processCallArg(args[1])
          : this.processCallArg(args[0]);
      // Generate: Array.from({length: end - start}, (_, i) => i + start)
      const rangeExpr = ts.raw(
        `Array.from({length: ${printTs(endNode, 0)} - ${printTs(startNode, 0)}}, (_, __i) => __i + ${printTs(startNode, 0)})`,
      );
      return ts.runnerLoop({
        id,
        items: rangeExpr,
        itemVar: node.itemVar as string,
        body: bodyNodes,
      });
    }

    const iterableNode = this.processNode(node.iterable);

    return ts.runnerLoop({
      id,
      items: iterableNode,
      itemVar: node.itemVar as string,
      indexVar: node.indexVar,
      body: bodyNodes,
    });
  }

  private processWhileLoopWithSteps(node: WhileLoop): TsNode {
    const id = this.steps.currentId();
    const subKey = this.steps.joined();
    const condition = this.processNode(node.condition);

    this.steps.pushLoop(subKey);
    const bodyNodes = this.processBodyAsParts(node.body);
    this.steps.popLoop();

    return ts.runnerWhileLoop({ id, condition, body: bodyNodes });
  }

  private processMatchBlockWithSteps(node: MatchBlock): TsNode {
    const id = this.steps.currentId();
    const expression = this.processNode(node.expression);

    const filteredCases = node.cases.filter(
      (c) => c.type !== "comment",
    ) as MatchBlockCase[];

    const branches: { condition: TsNode; body: TsNode[] }[] = [];
    let elseBranch: TsNode[] | undefined;

    for (const caseItem of filteredCases) {
      if (caseItem.caseValue === "_") {
        elseBranch = [this.processNode(caseItem.body)];
      } else {
        branches.push({
          condition: ts.binOp(
            expression,
            "===",
            this.processNode(caseItem.caseValue as AgencyNode),
          ),
          body: [this.processNode(caseItem.body)],
        });
      }
    }

    return ts.runnerIfElse({ id, branches, elseBranch });
  }

  private processImportStatement(node: ImportStatement): TsNode {
    const from = toCompiledImportPath(node.modulePath, this.outputFile ?? path.resolve(this.moduleId));
    const imports = node.importedNames.map((nameType) => {
      switch (nameType.type) {
        case "namedImport":
          return ts.importDecl({
            importKind: "named",
            names: nameType.importedNames.map((name) => {
              const alias = nameType.aliases[name];
              return alias ? { name, alias } : name;
            }),
            from,
          });
        case "namespaceImport":
          return ts.importDecl({
            importKind: "namespace",
            namespaceName: nameType.importedNames,
            from,
          });
        case "defaultImport":
          return ts.importDecl({
            importKind: "default",
            defaultName: nameType.importedNames,
            from,
          });
      }
    });
    const importNode = imports.length === 1 ? imports[0] : ts.statements(imports);

    // Auto-register any AgencyFunction instances imported from .agency files.
    if (node.isAgencyImport) {
      for (const nameType of node.importedNames) {
        switch (nameType.type) {
          case "namedImport":
            for (const name of nameType.importedNames) {
              const localName = nameType.aliases[name] ?? name;
              this.toolRegistrations.push(ts.raw(`__registerTool(${localName});`));
            }
            break;
          case "namespaceImport": {
            const ns = nameType.importedNames;
            this.toolRegistrations.push(ts.raw(
              `for (const [__k, __v] of Object.entries(${ns})) { __registerTool(__v, __k); }`
            ));
            break;
          }
        }
      }
    }
    return importNode;
  }

  private processImportNodeStatement(_node: ImportNodeStatement): TsNode {
    return ts.empty(); // handled in preprocess
  }


  // ------- TsRaw wrapper methods (template-heavy) -------


  /**
   * Process a block argument into a wrapped AgencyFunction TsNode.
   * Shared by generateFunctionCallExpression and buildCallDescriptor.
   */
  private processBlockArgument(node: Pick<FunctionCall, "block"> & { functionName?: string }): TsNode {
    const block = node.block!;
    const fnDef = node.functionName ? this.compilationUnit.functionDefinitions[node.functionName] : undefined;
    const imported = node.functionName ? this.compilationUnit.importedFunctions[node.functionName] : undefined;
    const paramList = fnDef?.parameters ?? imported?.parameters;
    const blockType = paramList
      ?.map((p) => p.typeHint)
      .find((t): t is BlockType => t?.type === "blockType");

    const blockParams: TsParam[] = block.params.map((p, i) => ({
      name: p.name,
      typeAnnotation: blockType?.params[i]
        ? formatTypeHintTs(blockType.params[i].typeAnnotation)
        : "any",
    }));

    const blockName = this.steps.nextBlockName();
    const parentScopeName = this.scopes.currentName();
    this.scopes.push({ type: "block", blockName });
    this._sourceMapBuilder.enterScope(this.moduleId, blockName);
    const bodyParts = this.processBodyAsParts(block.body);
    this._sourceMapBuilder.enterScope(this.moduleId, parentScopeName);
    this.scopes.pop();

    const bodyStr = bodyParts.map((n) => printTs(n, 1)).join("\n");

    const blockSetupCode = renderBlockSetup.default({
      params: block.params.map((p) => ({
        paramName: p.name,
        paramNameQuoted: JSON.stringify(p.name),
      })),
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(blockName),
      body: bodyStr,
    });

    const blockFn = ts.arrowFn(
      blockParams,
      ts.statements([ts.raw(blockSetupCode)]),
      { async: true },
    );
    return ts.agencyFunctionWrap(
      blockFn,
      blockName,
      this.moduleId,
      block.params.map((p) => ({ name: p.name })),
    );
  }

  /**
   * Compile a BlockArgument that appears as a standalone expression
   * (e.g. as a named arg value in .partial(), or assigned to a variable).
   * Uses type annotations on the block params if present, falls back to 'any'.
   */
  private processBlockAsExpression(block: BlockArgument): TsNode {
    const blockParams: TsParam[] = block.params.map((p) => ({
      name: p.name,
      typeAnnotation: p.typeHint ? formatTypeHintTs(p.typeHint) : "any",
    }));

    const blockName = this.steps.nextBlockName();
    const parentScopeName = this.scopes.currentName();
    this.scopes.push({ type: "block", blockName });
    this._sourceMapBuilder.enterScope(this.moduleId, blockName);
    const bodyParts = this.processBodyAsParts(block.body);
    this._sourceMapBuilder.enterScope(this.moduleId, parentScopeName);
    this.scopes.pop();

    const bodyStr = bodyParts.map((n) => printTs(n, 1)).join("\n");

    const blockSetupCode = renderBlockSetup.default({
      params: block.params.map((p) => ({
        paramName: p.name,
        paramNameQuoted: JSON.stringify(p.name),
      })),
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(blockName),
      body: bodyStr,
    });

    const blockFn = ts.arrowFn(
      blockParams,
      ts.statements([ts.raw(blockSetupCode)]),
      { async: true },
    );
    return ts.agencyFunctionWrap(
      blockFn,
      blockName,
      this.moduleId,
      block.params.map((p) => ({ name: p.name })),
    );
  }

  /**
   * Build a tool definition TsNode for an Agency function.
   * Returns ts.id("null") if the function has no parameters (no schema needed for tools).
   */
  private buildToolDefinition(node: FunctionDefinition): TsNode {
    const { functionName, parameters } = node;
    if (
      this.compilationUnit.graphNodes.map((n) => n.nodeName).includes(functionName)
    ) {
      throw new Error(
        `There is already a node named '${functionName}'. Functions can't have the same name as an existing node.`,
      );
    }

    const nonBlockParams = parameters.filter(
      (p) => !p.typeHint || p.typeHint.type !== "blockType",
    );

    const properties: Record<string, string> = {};
    nonBlockParams.forEach((param: FunctionParameter) => {
      const typeHint = param.typeHint || {
        type: "primitiveType" as const,
        value: "string",
      };
      let tsType = this.zodSchemaFor(typeHint);
      if (param.defaultValue) {
        const defaultStr = expressionToString(param.defaultValue);
        tsType += `.nullable().describe(${JSON.stringify("Default: " + defaultStr)})`;
      }
      properties[param.name] = tsType;
    });
    let schema = "";
    for (const [key, value] of Object.entries(properties)) {
      schema += `"${key.replace(/"/g, '\\"')}": ${value}, `;
    }

    const schemaArg = Object.keys(properties).length > 0 ? `{${schema}}` : "{}";
    // Trim leading/trailing indentation from doc-string segments before
    // emission so the LLM sees clean text, while keeping the AST
    // untouched for faithful formatter round-trips.
    const trimmedDocSegments = node.docString
      ? trimDocStringSegments(node.docString.segments)
      : [];
    return ts.obj({
      name: ts.str(functionName),
      description:
        trimmedDocSegments.length > 0
          // Flip `topLevel` on every TsScopedVar so the pretty-printer
          // reads through `__globalCtx` instead of the strict ALS
          // accessor — this subtree is eagerly evaluated at module
          // load when no ALS frame is installed.
          ? markTopLevelScopedVars(
              this.generateStringLiteralNode(trimmedDocSegments),
            )
          : ts.str("No description provided."),
      schema: $.z()
        .prop("object")
        .call([ts.raw(schemaArg)])
        .done(),
    });
  }

  /**
   * Returns true if any function or graph node in the compilation unit
   * has a doc string with at least one interpolation segment.
   */
  private hasDocStringInterpolation(): boolean {
    const fns = Object.values(this.compilationUnit.functionDefinitions);
    for (const fn of fns) {
      if (
        fn.docString?.segments.some((s) => s.type === "interpolation")
      ) {
        return true;
      }
    }
    for (const node of this.compilationUnit.graphNodes) {
      if (
        node.docString?.segments.some((s) => s.type === "interpolation")
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Generate __toolRegistry as an empty object. AgencyFunction.create() calls
   * register local functions into it. Imported and builtin tools are registered
   * here directly. The reviver is bound at the end.
   */
  private generateToolRegistry(): TsNode {
    // __toolRegistry is declared in the imports template (before checkpoint wrappers).
    const stmts: TsNode[] = [];

    // Builtin tools: wrap as AgencyFunction instances
    for (const toolName of BUILTIN_TOOLS) {
      const internalName = BUILTIN_FUNCTIONS[toolName] || toolName;
      stmts.push(ts.raw(renderBuiltinToolRegistration.default({
        toolName,
        toolNameQuoted: JSON.stringify(toolName),
        moduleIdQuoted: JSON.stringify(this.moduleId),
        internalName,
      })));
    }

    // No-op assignment for historical clarity. `__toolRegistry` is
    // already aliased to `__functionRefReviver.registry` in the imports
    // template, so every module's helpers — and any blocks registered
    // by `AgencyFunction.create` at runtime — live in the same shared
    // object the reviver reads from.
    stmts.push(ts.raw("__functionRefReviver.registry = __toolRegistry;"));

    return ts.statements(stmts);
  }


  /**
   * For Result-returning functions: emit a pinned checkpoint at function entry
   * and a preamble that applies arg overrides on restore (for result.retry()).
   */
  private buildResultCheckpointSetup(
    functionName: string,
    parameters: FunctionParameter[],
  ): TsNode {
    let paramsStr = "";
    parameters.forEach((p) => {
      paramsStr += `  if (${JSON.stringify(p.name)} in __overrides) {
    ${p.name} = __overrides[${JSON.stringify(p.name)}];
    __stack.args[${JSON.stringify(p.name)}] = ${p.name};
  }
`;
    });
    const str = renderResultCheckpointSetup.default({
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(functionName),
      paramsStr,
    });

    return ts.raw(str);
  }

  /**
   * Build the body statements for an Agency function or class method.
   * Includes setup, runner, result checkpoint, try/catch/finally, hooks.
   * Shared between processFunctionDefinition and class method compilation.
   */
  private buildFunctionBody(opts: {
    functionName: string;
    parameters: FunctionParameter[];
    bodyCode: TsNode[];
    skipHooks?: boolean;
    hoistedAliases?: TsNode[];
  }): TsNode[] {
    const { functionName, parameters, bodyCode, skipHooks } = opts;
    const hoistedAliases = opts.hoistedAliases ?? [];
    const args = parameters.map((p) => p.name);

    // Build args object for hook data
    const argsObj: Record<string, TsNode> = {};
    for (const arg of args) {
      argsObj[arg] = ts.id(arg);
    }

    // Setup block. `setupFunction()` reads `ctx` / `threads` from the
    // active `agencyStore` ALS frame seeded by the caller (a
    // `runner.step` body, `runNode`'s top-level frame, or
    // `runBatch.runInBranchAlsFrame`). Tool dispatch by an LLM also runs
    // inside the issuing `runner.step` frame, so a frame is always
    // active here.
    const setupStmts: TsNode[] = [
      ts.constDecl(
        "__setupData",
        $(ts.id("setupFunction")).call([]).done(),
      ),

      ts.setupEnv({
        stack: $(ts.id("__setupData")).prop("stack").done(),
        step: $(ts.id("__setupData")).prop("step").done(),
        self: $(ts.id("__setupData")).prop("self").done(),
        ctx: ts.raw("getRuntimeContext().ctx"),
      }),

      // Ensure this module's globals are initialized on the current ctx.
      // Runs BEFORE the `withAlsFrame` wrap installs the per-scope ALS
      // frame, so `__ctx` here is the setupEnv-emitted local — not the
      // `__ctx()` accessor (which would return undefined).
      ts.if(
        ts.raw(
          `!__ctx.globals.isInitialized(${JSON.stringify(this.moduleId)})`,
        ),
        ts.await(ts.call(ts.id("__initializeGlobals"), [ts.id("__ctx")])),
      ),

      ...(skipHooks ? [] : [ts.time("__funcStartTime")]),
    ];

    // Param assignments to stack
    for (const param of parameters) {
      const stackTarget = $(ts.stack("args")).index(ts.str(param.name)).done();
      if (param.defaultValue) {
        const defaultNode = this.processNode(param.defaultValue);
        setupStmts.push(
          ts.assign(
            stackTarget,
            ts.ternary(
              ts.binOp(ts.id(param.name), "===", ts.id("__UNSET")),
              defaultNode,
              ts.id(param.name),
            ),
          ),
        );
      } else {
        setupStmts.push(ts.assign(stackTarget, ts.id(param.name)));
      }
    }

    // __self.__retryable
    setupStmts.push(
      ts.assign(
        ts.self("__retryable"),
        ts.binOp(ts.self("__retryable"), "??", ts.bool(true)),
      ),
    );

    // Create runner for step execution. `threads` is read directly from
    // the setup-function result, which now resolves it from the active
    // ALS frame instead of an `__state` positional.
    setupStmts.push(
      ts.raw(
        `const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: ${JSON.stringify(this.moduleId)}, scopeName: ${JSON.stringify(functionName)}, threads: __setupData.threads });`,
      ),
    );

    // Pinned checkpoint at entry (enables result.retry and error-to-failure wrapping)
    setupStmts.push(this.buildResultCheckpointSetup(functionName, parameters));

    // Validation guards for parameters with ! (bang) syntax.
    // Placed inside the try block so the finally cleanup (stateStack.pop) always runs.
    const validationGuards: TsNode[] = [];
    for (const param of parameters) {
      if (param.validated && param.typeHint) {
        const stackArg = $(ts.stack("args")).index(ts.str(param.name)).done();
        const vrName = `__vr_${param.name}`;
        const vrId = ts.id(vrName);
        validationGuards.push(
          ts.constDecl(vrName, this.validateExpr(param.typeHint, stackArg)),
          ts.if(
            ts.not(ts.prop(vrId, "success")),
            ts.return(vrId),
          ),
          ts.assign(stackArg, ts.prop(vrId, "value")),
        );
      }
    }

    // Try/catch wrapping the body, with finally to always pop the state stack.
    // onFunctionStart fires inside the try at substep id 0 as a wrapped
    // `await runner.hook(0, async () => await callHook(...))`. The
    // runner.hook wrapper gives the hook substep-counter idempotency so
    // it fires exactly once across resume cycles (without it the function
    // would re-fire onFunctionStart on every resume). Callback bodies
    // cannot raise interrupts (statically forbidden by the typechecker —
    // see `checkCallbackBodyInterrupts`).
    const onFunctionStartHook: TsNode[] = skipHooks ? [] : [
      ts.runnerHookStep({
        id: 0,
        body: [
          ts.callHook("onFunctionStart", {
            functionName: ts.str(functionName),
            args: ts.obj(argsObj),
            isBuiltin: ts.bool(false),
            moduleId: ts.str(this.moduleId),
          }),
        ],
      }),
    ];
    setupStmts.push(
      ts.tryCatch(
        ts.statements([
          // Validation guards stay OUTSIDE the agencyStore.run wrap:
          // they emit `return __vr_x` for failures, and we need that
          // value to escape the outer function, not just the inner
          // async callback.
          ...validationGuards,
          ...hoistedAliases,
          // Body-level ALS frame (defense-in-depth). Today every
          // callback site re-seeds ALS via Runner.runInScope, but the
          // wrap closes the gap for code that runs between steps and
          // makes the per-scope frame contract explicit.
          //
          // `stack:` carries the StateStack (not the current State
          // frame) — matches what the now-pruned `const __stateStack =
          // __setupData.stateStack;` line used to bind, so
          // `__stateStack()` reads inside the wrap return a real
          // StateStack rather than a per-frame State.
          ts.withAlsFrame({
            ctx: ts.id("__ctx"),
            stack: $(ts.id("__setupData")).prop("stateStack").done(),
            threads: $(ts.id("__setupData")).prop("threads").done(),
            body: [
              ...onFunctionStartHook,
              ...bodyCode,
            ],
          }),
          ts.raw(
            "if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }",
          ),
        ]),
        ts.raw(
          renderFunctionCatchFailure.default({
            functionName: JSON.stringify(functionName),
          }),
        ),
        "__error",
        // finally block: pop state stack and conditionally fire onFunctionEnd.
        // The optional chain handles the rare case where the finally
        // runs outside any ALS frame (e.g. a function invoked as a tool
        // without an outer agencyStore.run wrap).
        ts.statements([
          ts.raw("__stateStack()?.pop()"),
          ...(skipHooks ? [] : [
            ts.if(
              ts.id("__functionCompleted"),
              ts.callHook("onFunctionEnd", {
                functionName: ts.str(functionName),
                timeTaken: $(ts.id("performance"))
                  .prop("now")
                  .call()
                  .minus(ts.id("__funcStartTime"))
                  .done(),
              }),
            ),
          ]),
        ]),
      ),
    );

    return setupStmts;
  }

  private processFunctionDefinition(node: FunctionDefinition): TsNode {
    this.scopes.push({ type: "function", functionName: node.functionName });
    this._sourceMapBuilder.enterScope(this.moduleId, node.functionName);
    const { functionName, parameters } = node;

    const prevSafe = this.scopes.inSafeFunction;
    this.scopes.inSafeFunction = !!node.safe;
    // Hoist body-local type aliases to the function's outer scope so
    // every runner.step closure can reference the generated zod schemas.
    const hoistedAliases = this.hoistBodyTypeAliases(node.body);
    // Body steps occupy substep ids 1..N — id 0 is reserved for the
    // onFunctionStart hook (wrapped in `runner.hook` for substep-counter
    // idempotency on resume).
    const bodyCode = this.processBodyAsParts(node.body, 1);
    this.scopes.inSafeFunction = prevSafe;
    this.scopes.pop();

    // Build function params from the source signature. The legacy
    // trailing `__state: InternalFunctionState | undefined` positional
    // is gone — `ctx` / `threads` / `stateStack` flow through ALS.
    const fnParams: TsParam[] = parameters.map((p) => {
      const baseType = p.typeHint ? formatTypeHintTs(p.typeHint) : "any";
      if (p.defaultValue) {
        return {
          name: p.name,
          typeAnnotation: `${baseType} | typeof __UNSET`,
          defaultValue: ts.id("__UNSET"),
        };
      }
      return { name: p.name, typeAnnotation: baseType };
    });

    const implName = `__${functionName}_impl`;
    const setupStmts = this.buildFunctionBody({ functionName, parameters, bodyCode, skipHooks: false, hoistedAliases });

    const funcDecl = ts.functionDecl(implName, fnParams, ts.statements(setupStmts), {
      async: true,
    });

    // Build AgencyFunction.create() params metadata
    // Include all params (including block-typed) so .partial() can bind them by name.
    // Block-typed params are separately excluded from the tool schema (buildToolDefinition).
    const paramNodes = parameters.map((p) =>
      ts.obj({
        name: ts.str(p.name),
        hasDefault: ts.bool(!!p.defaultValue),
        defaultValue: ts.id("undefined"),
        variadic: ts.bool(!!p.variadic),
      }),
    );

    // Build tool definition (Zod schema)
    const toolDef = this.buildToolDefinition(node);

    const createCall = $
      .id("__AgencyFunction")
      .prop("create")
      .call([
        ts.obj({
          name: ts.str(functionName),
          module: ts.str(this.moduleId),
          fn: ts.id(implName),
          params: ts.arr(paramNodes),
          toolDefinition: toolDef,
          safe: ts.bool(!!node.safe),
          exported: ts.bool(!!node.exported),
        }),
        ts.id("__toolRegistry"),
      ])
      .done();

    const constDecl = ts.varDecl("const", functionName, createCall);
    const exportedConst = node.exported ? ts.export(constDecl) : constDecl;

    return ts.statements([funcDecl, exportedConst]);
  }

  private processStatement(node: AgencyNode): TsNode {
    if (node.type === "functionCall") {
      return this.processFunctionCallAsStatement(node);
    }
    return this.processNode(node);
  }

  private interruptTemplateArgs(kind: string, message: string, data: string, origin: string) {
    return {
      kind: JSON.stringify(kind),
      message,
      data,
      origin: JSON.stringify(origin),
    };
  }

  private buildInterruptReturnStructured(kind: string, messageExpr: string, dataExpr: string): TsNode {
    const origin = moduleIdToOrigin(this.moduleId);
    const opts = this.checkpointOpts();
    return ts.raw(
      renderInterruptReturn.default({
        ...this.interruptTemplateArgs(kind, messageExpr, dataExpr, origin),
        nodeContext: this.scopes.current().type === "node",
        interruptIdKey: `__interruptId_${this.steps.joined("_")}`,
        ...opts,
      }),
    );
  }

  private extractInterruptFields(node: InterruptStatement): { kind: string; messageExpr: string; dataExpr: string } {
    return {
      kind: node.kind,
      messageExpr: node.arguments && node.arguments.length > 0
        ? this.str(this.processCallArg(node.arguments[0]))
        : '""',
      dataExpr: node.arguments && node.arguments.length > 1
        ? this.str(this.processCallArg(node.arguments[1]))
        : "{}",
    };
  }

  private isInterruptExpression(node: AgencyNode): boolean {
    return node.type === "interruptStatement";
  }

  private processInterruptStatement(node: InterruptStatement): TsNode {
    const { kind, messageExpr, dataExpr } = this.extractInterruptFields(node);
    return this.buildInterruptReturnStructured(kind, messageExpr, dataExpr);
  }

  private processFunctionCallAsStatement(node: FunctionCall): TsNode {
    if (node.functionName === "_emit") {
      return this.processFunctionCall(node);
    }

    const callNode = this.processFunctionCall(node);
    const scope = this.scopes.current();

    if (
      this.names.shouldHandleInterrupts(node.functionName) &&
      scope.type !== "global"
    ) {
      // Async unassigned calls: register with pending promise store, no interrupt check
      if (node.async) {
        // Fork the stack for per-thread isolation
        if (this.names.shouldHandleInterrupts(node.functionName)) {
          this._asyncBranchCheckNeeded = true;
          const branchKey = this.steps.joined();
          let statements = ts.statements(this.forkBranchSetup(branchKey));
          const callWithStack = this.generateFunctionCallExpression(
            node,
            "topLevelStatement",
            { stateStack: ts.id("__forked") },
          );

          statements = ts.statementsPush(
            statements,
            // Strict accessor inside a step body (under the
            // withAlsFrame wrap) — keeps missing-frame failures
            // actionable instead of "Cannot read 'add' of undefined".
            ts.raw(
              `getRuntimeContext().ctx.pendingPromises.add(${this.str(callWithStack)})`,
            ),
          );
          return statements;
        }
        return ts.raw(
          `getRuntimeContext().ctx.pendingPromises.add(${this.str(callNode)})`,
        );
      }

      // Sync calls: check for interrupt result
      const tempVar = "__funcResult";
      if (this.insideHandlerBody) {
        return ts.statements([
          ts.constDecl(tempVar, callNode),
          ts.if(
            this.interruptCheckRaw(tempVar),
            ts.throw(`new Error("Cannot throw an interrupt inside a handler body")`),
          ),
        ]);
      }
      const nodeContext = scope.type === "node";
      // In node context, wrap with state for the driver.
      // In function context, halt with the interrupt array directly so the
      // caller's hasInterrupts check can detect it.
      const haltValue = nodeContext
        ? ts.obj([
          ts.setSpread(ts.runtime.state),
          ts.set("data", ts.id(tempVar)),
        ])
        : ts.id(tempVar);
      return ts.statements([
        ts.constDecl(tempVar, callNode),
        ts.if(
          this.interruptCheck(ts.id(tempVar)),
          ts.statements([
            ts.awaitMethodCall(
              // Strict accessor — immediate deref of `pendingPromises`
              // inside a step body under the withAlsFrame wrap.
              ts.prop(ts.raw("getRuntimeContext().ctx"), "pendingPromises"),
              "awaitAll",
            ),
            ts.methodCall(ts.id("runner"), "halt", [haltValue]),
            ts.return(),
          ]),
        ),
      ]);
    }

    return callNode;
  }

  private processFunctionCall(node: FunctionCall): TsNode {
    if (
      (node.functionName === "fork" || node.functionName === "race") &&
      node.block
    ) {
      return this.processForkCall(node);
    }

    if (
      node.functionName === "failure" &&
      this.scopes.current().type === "function"
    ) {
      // Inside functions, inject checkpoint, function name, and args
      const scope = this.scopes.current() as FunctionScope;
      const argNodes: TsNode[] = node.arguments.map((arg) =>
        this.processCallArg(arg),
      );
      return ts.call(ts.id("failure"), [
        ...argNodes,
        ts.raw(
          // Strict accessor — emitted inside the function body's
          // withAlsFrame wrap. See processTryExpression above for the
          // sibling shape.
          `{ checkpoint: getRuntimeContext().ctx.getResultCheckpoint(), functionName: ${JSON.stringify(scope.functionName)}, args: __stack.args }`,
        ),
      ]);
    }

    if (node.functionName === "throw") {
      // throw("message") → throw new Error("message")
      const argNodes: TsNode[] = node.arguments.map((arg) =>
        this.processCallArg(arg),
      );
      const arg = argNodes.length > 0 ? argNodes[0] : ts.str("");
      return ts.throw(`new Error(${this.str(arg)})`);
    }

    if (node.functionName === "_emit") {
      const argNodes: TsNode[] = node.arguments.map((arg) =>
        this.processCallArg(arg),
      );
      const data = argNodes.length > 0 ? argNodes[0] : ts.id("undefined");
      // Wrap in `runner.hook(id, ...)` for substep-counter idempotency on
      // resume — without it, every resume cycle would re-fire onEmit.
      return ts.runnerHookStep({
        id: this.steps.currentId(),
        body: [ts.callHook("onEmit", data)],
      });
    }

    if (node.functionName === "__objectRest") {
      return ts.raw(this.buildObjectRestIIFE(node));
    }

    if (node.functionName === "llm") {
      // Standalone llm() call (not assigned to variable)
      return this.processLlmCall(
        DEFAULT_PROMPT_NAME,
        this.scopes.returnType(),
        node,
        "local",
      );
    }

    if (this.names.isGraphNode(node.functionName)) {
      if (this.scopes.current().type === "function") {
        throw new Error(
          `Cannot call graph node '${node.functionName}' from inside function '${(this.scopes.current() as any).functionName}'. Node transitions can only be made from within graph nodes.`,
        );
      }
      this.currentAdjacentNodes.push(node.functionName);
      this.functionsUsed.add(node.functionName);
      return this.generateNodeCallExpression(node);
    }

    this.functionsUsed.add(node.functionName);
    const callNode = this.generateFunctionCallExpression(
      node,
      "topLevelStatement",
    );

    const mappedName = mapFunctionName(node.functionName);
    const isBuiltinFunction = mappedName !== node.functionName;

    if (isBuiltinFunction) {
      return ts.await(callNode);
    }
    return callNode;
  }

  private generateFunctionCallExpression(
    node: FunctionCall,
    context: "valueAccess" | "functionArg" | "topLevelStatement",
    options?: { stateStack?: TsNode },
  ): TsNode {
    const functionName =
      context === "valueAccess"
        ? node.functionName
        : mapFunctionName(node.functionName);

    const shouldAwait = !node.async && context !== "valueAccess";

    // __-prefixed helpers and DIRECT_CALL_FUNCTIONS: emit plain direct call
    if (
      functionName.startsWith("__") ||
      this.names.isDirectCallFunction(functionName)
    ) {
      return this.emitDirectFunctionCall(node, functionName, shouldAwait);
    }

    // Everything else goes through __call runtime dispatch
    return this.emitRuntimeDispatchCall(node, functionName, shouldAwait, options);
  }

  private emitRuntimeDispatchCall(
    node: FunctionCall,
    functionName: string,
    shouldAwait: boolean,
    options?: { stateStack?: TsNode },
  ): TsNode {
    const descriptor = this.buildCallDescriptor(node);

    const callee = node.scope
      ? ts.scopedVar(functionName, node.scope, this.moduleId)
      : ts.id(functionName);

    const callExpr = ts.call(ts.id("__call"), [callee, descriptor]);

    // Async-fork sites need the branch's isolated stack visible to the
    // callee (so its checkpoints/handlers/etc. push/pop on the branch
    // stack rather than the parent's). Install a fresh ALS frame
    // inline at the call site that overrides `stack`; the callee picks
    // it up via `getRuntimeContext()`.
    if (options?.stateStack) {
      const frame = ts.obj([
        ts.setSpread(ts.call(ts.id("getRuntimeContext"))),
        ts.set("stack", options.stateStack),
      ]);
      const wrapped = ts.call(ts.prop(ts.id("agencyStore"), "run"), [
        frame,
        ts.arrowFn([], callExpr),
      ]);
      return shouldAwait ? ts.await(wrapped) : wrapped;
    }

    return shouldAwait ? ts.await(callExpr) : callExpr;
  }

  /**
   * Emit a plain direct function call: `f(arg1, arg2, blockArg?)`.
   * Context-injected builtins reuse this with `prependArgs =
   * [__ctx]`; the registry lookup at the call site is what marks the
   * intent, no separate method needed.
   */
  private emitDirectFunctionCall(
    node: FunctionCall,
    functionName: string,
    shouldAwait: boolean,
    prependArgs: TsNode[] = [],
  ): TsNode {
    const argNodes: TsNode[] = [
      ...prependArgs,
      ...node.arguments.map((a) => this.processCallArg(a)),
    ];

    if (node.block) {
      argNodes.push(this.processBlockArgument(node));
    }

    const call = $.id(functionName).call(argNodes).done();
    return shouldAwait ? ts.await(call) : call;
  }

  /**
   * Build a CallType descriptor TsNode for an Agency function call.
   * Determines whether to emit positional or named call type based on arguments.
   */
  private buildCallDescriptor(node: Pick<FunctionCall, "arguments" | "block">): TsNode {
    const args = node.arguments;
    const hasNamedArgs = args.some((a) => a.type === "namedArgument");

    if (hasNamedArgs) {
      // Named call: { type: "named", positionalArgs: [...], namedArgs: {...} }
      const positionalNodes: TsNode[] = [];
      const namedEntries: Record<string, TsNode> = {};

      for (const arg of args) {
        if (arg.type === "namedArgument") {
          namedEntries[arg.name] = this.processNode(arg.value as AgencyNode);
        } else {
          positionalNodes.push(this.processCallArg(arg));
        }
      }

      // Pass any trailing block as a dedicated descriptor field so
      // the runtime can bind it to the last (block) parameter — see
      // CallType.blockArg in lib/runtime/agencyFunction.ts. Without
      // this, `f(name: val) as { ... }` would drop the block on the
      // floor and the runtime would report a missing-arg error.
      const descriptor: Record<string, TsNode> = {
        type: ts.str("named"),
        positionalArgs: ts.arr(positionalNodes),
        namedArgs: ts.obj(namedEntries),
      };
      if (node.block) {
        descriptor.blockArg = this.processBlockArgument(node);
      }
      return ts.obj(descriptor);
    }

    const argNodes: TsNode[] = [];
    for (const arg of args) {
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        argNodes.push(
          this.generateFunctionCallExpression(arg as FunctionCall, "functionArg"),
        );
      } else {
        argNodes.push(this.processCallArg(arg));
      }
    }

    if (node.block) {
      argNodes.push(this.processBlockArgument(node));
    }

    return ts.obj({
      type: ts.str("positional"),
      args: ts.arr(argNodes),
    });
  }

  private processForkCall(node: FunctionCall): TsNode {
    const mode = node.functionName === "fork" ? "all" : "race";
    const block = node.block!;
    const paramName = block.params[0]?.name ?? "_";
    const id = this.steps.currentId();

    const itemsNode =
      node.arguments.length > 0
        ? this.processCallArg(node.arguments[0])
        : ts.arr([]);

    const blockName = this.steps.nextBlockName();
    const parentScopeName = this.scopes.currentName();
    // Track that we're now generating code inside a fork-block body so
    // any nested fork can carry parent block args forward. Capture the
    // depth value the inner fork will see, then increment for the body
    // walk and restore after.
    const isNestedInForkBlock = this.steps.isNestedInForkBlock();
    this.steps.enterForkBlock();
    this.scopes.push({ type: "block", blockName });
    this._sourceMapBuilder.enterScope(this.moduleId, blockName);
    const bodyParts = this.processBodyAsParts(block.body);
    this._sourceMapBuilder.enterScope(this.moduleId, parentScopeName);
    this.scopes.pop();
    this.steps.exitForkBlock();

    const bodyStr = bodyParts.map((n) => printTs(n, 1)).join("\n");

    const blockSetupCode = renderForkBlockSetup.default({
      paramName,
      paramNameQuoted: JSON.stringify(paramName),
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(blockName),
      body: bodyStr,
      isNested: isNestedInForkBlock,
    });

    const blockFn = ts.arrowFn(
      [
        { name: "__forkItem" },
        { name: "__forkIndex" },
        { name: "__forkBranchStack" },
      ],
      ts.statements([ts.raw(blockSetupCode)]),
      { async: true },
    );

    return $(ts.id("runner"))
      .prop("fork")
      .call([
        ts.num(id),
        itemsNode,
        blockFn,
        ts.str(mode),
        // `runner.fork` requires the current StateStack to push branch
        // frames onto. Use the strict accessor so a missing ALS frame
        // throws the actionable error instead of producing a generic
        // TypeError deep inside the fork machinery.
        ts.raw("getRuntimeContext().stack"),
      ])
      .await()
      .done();
  }

  private generateNodeCallExpression(node: FunctionCall): TsNode {
    const functionName = mapFunctionName(node.functionName);
    const targetNode = this.compilationUnit.graphNodes.find(
      (n) => n.nodeName === functionName,
    );
    const resolvedArgs = resolveNamedArgs(node, targetNode?.parameters, true);
    const argNodes = this.processResolvedArgs(resolvedArgs);

    let dataNode: TsNode;
    if (targetNode && targetNode.parameters.length > 0) {
      const entries: Record<string, TsNode> = {};
      targetNode.parameters.forEach((p, i) => {
        entries[p.name] = argNodes[i];
      });
      dataNode = ts.obj(entries);
    } else if (argNodes.length > 0) {
      const entries = $(ts.id(`__${functionName}NodeParams`))
        .map(
          ts.raw(
            `(k, i) => [k, [${argNodes.map((n) => this.str(n)).join(", ")}][i]]`,
          ),
        )
        .done();
      dataNode = ts.methodCall(ts.id("Object"), "fromEntries", [entries]);
    } else {
      dataNode = ts.obj({});
    }

    const goToArgs = ts.obj({
      messages: ts.runtime.threads,
      ctx: ts.runtime.ctx,
      data: dataNode,
    });

    return ts.statements([
      // Pop the current node's frame before transitioning — it won't be re-entered on resume.
      // Optional chain defends against the rare goto reached outside any ALS frame.
      ts.raw("__stateStack()?.pop()"),
      ts.functionReturn(ts.goToNode(functionName, goToArgs)),
    ]);
  }

  private processGraphNode(node: GraphNodeDefinition): TsNode {
    this.scopes.push({ type: "node", nodeName: node.nodeName });
    this._sourceMapBuilder.enterScope(this.moduleId, node.nodeName);
    const { nodeName, body, parameters } = node;
    this.adjacentNodes[nodeName] = [];
    this.currentAdjacentNodes = [];
    this.isInsideGraphNode = true;

    for (const stmt of body) {
      if (stmt.type === "functionCall" && this.names.isGraphNode(stmt.functionName)) {
        throw new Error(
          `Call to graph node '${stmt.functionName}' inside graph node '${nodeName}' must use goto or return, eg: goto ${stmt.functionName}(...)`,
        );
      }
    }

    // Hoist body-local type aliases to the outer arrow body so every
    // runner.step closure can reference the generated zod schemas.
    const hoistedAliases = this.hoistBodyTypeAliases(body);

    // Body steps occupy substep ids 1..N. Id 0 is reserved for the
    // onNodeStart hook (wrapped in runner.hook for idempotency on
    // resume). onNodeEnd sits at id N+1.
    const bodyCode = this.processBodyAsParts(body, 1);
    const onNodeStartId = 0;
    const onNodeEndId = bodyCode.length + 1;

    this.adjacentNodes[nodeName] = [...this.currentAdjacentNodes];
    this.isInsideGraphNode = false;
    this.scopes.pop();
    // Build the arrow function body
    const stmts: TsNode[] = [
      ts.constDecl(
        "__setupData",
        $(ts.id("setupNode"))
          .call([ts.obj({ state: ts.runtime.state })])
          .done(),
      ),

      ts.setupEnv({
        stack: $(ts.id("__setupData")).prop("stack").done(),
        step: $(ts.id("__setupData")).prop("step").done(),
        self: $(ts.id("__setupData")).prop("self").done(),
        // `runNode` (and the resume / rewind variants) install the
        // top-level `agencyStore` frame before `graph.run` invokes
        // this node body. Read `ctx` from ALS so the local matches
        // the same per-run context that `setupNode` just used.
        ctx: ts.raw("getRuntimeContext().ctx"),
      }),

      // Pass `threads` explicitly so the Runner's ALS frame is seeded
      // with the per-node ThreadStore that `setupNode` reconstituted
      // from `stack.threads` JSON (or created fresh). `__threads()`
      // accessors emitted inside step bodies will then resolve to this
      // same store via `Runner.runInScope`.
      ts.raw(
        `const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: ${JSON.stringify(this.moduleId)}, scopeName: ${JSON.stringify(nodeName)}, threads: __setupData.threads });`,
      ),
      ...hoistedAliases,
    ];

    // Param assignments (only when not resuming)
    if (parameters.length > 0) {
      const paramStmts = parameters.map((p) =>
        ts.assign(
          $(ts.stack("args")).index(ts.str(p.name)).done(),
          $(ts.runtime.state).prop("data").prop(p.name).done(),
        ),
      );
      stmts.push(ts.if(ts.raw("!__state.isResume"), ts.statements(paramStmts)));
    }

    // Body wrapped in try-catch so node errors return failure instead
    // of crashing. onNodeStart at id 0 and onNodeEnd at id N+1 are both
    // wrapped in `runner.hook` for substep-counter idempotency on
    // resume. Callback bodies cannot raise interrupts (typechecker-
    // enforced via `checkCallbackBodyInterrupts`), so the hooks are
    // fire-and-forget. The post-body halted check covers ordinary
    // user-code interrupts.
    stmts.push(
      ts.tryCatch(
        ts.statements([
          // Body-level ALS frame (defense-in-depth). The onNodeStart
          // hook and user body go inside the wrap. The post-body
          // halted check and onNodeEnd hook stay outside: the wrap's
          // inner callback may bare-`return` from `runner.halt(...)`
          // emissions, and we want the outer node arrow to keep
          // running into the halted check / onNodeEnd / final return.
          //
          // `stack:` carries the StateStack (not the current State
          // frame) — matches what the now-pruned `const __stateStack =
          // __state.ctx.stateStack;` line used to bind, so
          // `__stateStack()` reads inside the wrap return a real
          // StateStack rather than a per-frame State.
          ts.withAlsFrame({
            ctx: ts.id("__ctx"),
            stack: ts.raw("__ctx.stateStack"),
            threads: $(ts.id("__setupData")).prop("threads").done(),
            body: [
              ts.runnerHookStep({
                id: onNodeStartId,
                body: [
                  ts.callHook("onNodeStart", { nodeName: ts.str(nodeName) }),
                ],
              }),
              ...bodyCode,
            ],
          }),
          ts.raw("if (runner.halted) return runner.haltResult;"),
          ts.runnerHookStep({
            id: onNodeEndId,
            body: [
              ts.callHook("onNodeEnd", {
                nodeName: ts.str(nodeName),
                data: ts.id("undefined"),
              }),
            ],
          }),
          ts.return(
            ts.obj({
              messages: ts.runtime.threads,
              data: ts.id("undefined"),
            }),
          ),
        ]),
        ts.statements([
          ts.if(
            ts.raw("__error instanceof RestoreSignal"),
            ts.statements([ts.throw("__error")]),
          ),
          ts.if(
            ts.raw("__error instanceof GuardExceededError"),
            ts.statements([ts.throw("__error")]),
          ),
          ts.consoleError(
            ts.template([
              {
                text: "\\nAgent crashed: ",
                expr: $(ts.id("__error")).prop("message").done(),
              },
            ]),
          ),
          ts.consoleError($(ts.id("__error")).prop("stack").done()),
          ts.return(
            ts.obj({
              messages: ts.runtime.threads,
              data: ts.raw(
                `failure(__error instanceof Error ? __error.message : String(__error), { functionName: ${JSON.stringify(nodeName)} })`,
              ),
            }),
          ),
        ]),
        "__error",
      ),
    );

    return $(ts.id("graph"))
      .prop("node")
      .call([
        ts.str(nodeName),
        ts.arrowFn(
          [{ name: "__state", typeAnnotation: "GraphState" }],
          ts.statements(stmts),
          { async: true },
        ),
      ])
      .done();
  }

  /** If the enclosing function/node has returnTypeValidated, wrap value in __validateType */
  private maybeWrapReturnValidation(valueNode: TsNode): TsNode {
    if (!this.scopes.returnTypeValidated()) return valueNode;
    const returnType = this.scopes.returnType();
    if (!returnType) return valueNode;
    return this.validateExpr(returnType, valueNode);
  }

  private processGotoStatement(node: GotoStatement): TsNode {
    if (!this.isInsideGraphNode) {
      throw new Error(
        `goto can only be used inside a node body`,
      );
    }
    if (!this.names.isGraphNode(node.nodeCall.functionName)) {
      throw new Error(
        `goto target '${node.nodeCall.functionName}' is not a node`,
      );
    }
    this.currentAdjacentNodes.push(node.nodeCall.functionName);
    this.functionsUsed.add(node.nodeCall.functionName);
    return this.generateNodeCallExpression(node.nodeCall);
  }

  private processReturnStatement(node: ReturnStatement): TsNode {
    // Bare return (no value)
    if (!node.value) {
      if (this.insideHandlerBody) return ts.return();
      if (this.scopes.current().type === "block") return ts.runnerHalt(ts.id("undefined"));
      if (this.isInsideGraphNode) return ts.nodeResult(ts.id("undefined"));
      return ts.functionReturn(ts.id("undefined"));
    }

    // Handler bodies use plain returns — no node/function wrapping
    if (this.insideHandlerBody) {
      return ts.return(this.processNode(node.value));
    }

    // Block bodies: halt the block's runner with the raw value
    if (this.scopes.current().type === "block") {
      if (this.isInterruptExpression(node.value)) {
        return this.processInterruptStatement(node.value as InterruptStatement);
      }
      // `return llm(...)` from a block: processLlmCall emits multiple
      // statements (assigning the result to __prompt), so we must hoist
      // them above the runnerHalt and pass the result var as the halt
      // value — wrapping the statements list directly in runnerHalt
      // would produce invalid TS like `runner.halt(stmt; stmt; ...)`.
      // Scope must be "block" so processLlmCall assigns into
      // `__bstack.locals.__prompt`, which is what `ts.self(...)`
      // resolves to inside a block (where `__self = __bstack.locals`).
      // The block's declared return type is unknown to the builder
      // (see ScopeManager.returnType comment), so processLlmCall falls
      // back to a string-typed structured-output schema.
      if (
        node.value.type === "functionCall" &&
        node.value.functionName === "llm"
      ) {
        const llmNode = this.processLlmCall(
          DEFAULT_PROMPT_NAME,
          this.scopes.returnType(),
          node.value,
          "block",
        );
        return ts.statements([
          llmNode,
          ts.runnerHalt(ts.self(DEFAULT_PROMPT_NAME)),
        ]);
      }
      const valueNode = this.processNode(node.value);
      return ts.runnerHalt(valueNode);
    }

    if (this.isInsideGraphNode) {
      if (this.isInterruptExpression(node.value)) {
        return this.processInterruptStatement(node.value as InterruptStatement);
      }
      if (
        node.value.type === "functionCall" &&
        node.value.functionName === "llm"
      ) {
        const llmNode = this.processLlmCall(
          DEFAULT_PROMPT_NAME,
          this.scopes.returnType(),
          node.value,
          "local",
        );
        return ts.statements([
          llmNode,
          ts.nodeResult(this.maybeWrapReturnValidation(ts.self(DEFAULT_PROMPT_NAME))),
        ]);
      }
      const valueNode = this.processNode(node.value);
      if (
        node.value.type === "functionCall" &&
        this.names.isGraphNode(node.value.functionName)
      ) {
        return valueNode;
      }
      return ts.nodeResult(this.maybeWrapReturnValidation(valueNode));
    }

    if (this.isInterruptExpression(node.value)) {
      return this.processInterruptStatement(node.value as InterruptStatement);
    } else if (
      node.value.type === "functionCall" &&
      node.value.functionName === "llm"
    ) {
      const llmNode = this.processLlmCall(
        DEFAULT_PROMPT_NAME,
        this.scopes.returnType(),
        node.value,
        "local",
      );
      return ts.statements([
        llmNode,
        ts.functionReturn(this.maybeWrapReturnValidation(ts.self(DEFAULT_PROMPT_NAME))),
      ]);
    }
    const valueNode = this.processNode(node.value);
    return ts.functionReturn(this.maybeWrapReturnValidation(valueNode));
  }

  private processAssignment(node: Assignment): TsNode {
    const result = this._processAssignmentInner(node);
    // If the type annotation has !, wrap the assigned value in __validateType
    // (or __validateChainRecursive if the type carries @validate tags).
    if (node.validated && node.typeHint) {
      const varRef = ts.scopedVar(node.variableName, node.scope!, this.moduleId);
      const validateStmt = ts.assign(
        varRef,
        this.validateExpr(node.typeHint, varRef),
      );
      if (result.kind === "statements") {
        return ts.statementsPush(result, validateStmt);
      }
      return ts.statements([result, validateStmt]);
    }
    return result;
  }

  private _processAssignmentInner(node: Assignment): TsNode {
    const { variableName, typeHint, value } = node;

    if (value.type === "functionCall" && value.functionName === "llm") {
      return this.processLlmCall(variableName, typeHint, value, node.scope!);
    } else if (this.isInterruptExpression(value)) {
      const { kind, messageExpr, dataExpr } = this.extractInterruptFields(value as InterruptStatement);
      const origin = moduleIdToOrigin(this.moduleId);
      const makeAssign = (val: string) =>
        this.str(
          this.assigns.scopedAssign(
            node.scope!,
            variableName,
            ts.raw(val),
            node.accessChain,
          ),
        );
      const opts = this.checkpointOpts();
      return ts.raw(
        renderInterruptAssignment.default({
          assignResolve: makeAssign("__response.value"),
          assignApprove: makeAssign("true"),
          handlerApprove: makeAssign("__handlerResult.value"),
          ...this.interruptTemplateArgs(kind, messageExpr, dataExpr, origin),
          nodeContext: this.scopes.current().type === "node",
          interruptIdKey: `__interruptId_${this.steps.joined("_")}`,
          ...opts,
        }),
      );
    } else if (value.type === "functionCall") {
      const varRef = this.assigns.lhs(
        node.scope!,
        variableName,
        node.accessChain,
      );
      const stmts: TsNode[] = [
        this.assigns.scopedAssign(
          node.scope!,
          variableName,
          this.processNode(value),
          node.accessChain,
        ),
      ];

      if (value.async) {
        // Fork the stack for per-thread isolation
        if (this.names.shouldHandleInterrupts(value.functionName)) {
          this._asyncBranchCheckNeeded = true;
          const branchKey = this.steps.joined();
          stmts.unshift(...this.forkBranchSetup(branchKey));
          stmts[stmts.length - 1] = this.assigns.scopedAssign(
            node.scope!,
            variableName,
            this.generateFunctionCallExpression(value, "topLevelStatement", {
              stateStack: ts.id("__forked"),
            }),
            node.accessChain,
          );
        }

        // Async: register with pending promise store, store the key, skip interrupt check
        const pendingKeyVar = `__pendingKey_${variableName}`;
        stmts.push(
          ts.assign(
            ts.self(pendingKeyVar),
            ts.raw(
              // Strict accessor — inside step body under the wrap.
              `getRuntimeContext().ctx.pendingPromises.add(${this.str(varRef)}, (val) => { ${this.str(varRef)} = val; })`,
            ),
          ),
        );
      } else if (this.scopes.current().type !== "global") {
        if (this.insideHandlerBody) {
          stmts.push(
            ts.if(
              this.interruptCheckRaw(this.str(varRef)),
              ts.throw(`new Error("Cannot throw an interrupt inside a handler body")`),
            ),
          );
        } else {
          // Sync: interrupt check with awaitAll before halt.
          // In function context, halt with the interrupt array directly so
          // the caller's hasInterrupts check can detect it.
          const haltValue =
            this.scopes.current().type === "node"
              ? ts.obj([ts.setSpread(ts.runtime.state), ts.set("data", varRef)])
              : varRef;
          stmts.push(
            ts.if(
              this.interruptCheck(varRef),
              ts.statements([
                ts.awaitMethodCall(
                  // Strict accessor — immediate deref inside step body.
                  ts.prop(ts.raw("getRuntimeContext().ctx"), "pendingPromises"),
                  "awaitAll",
                ),
                ts.methodCall(ts.id("runner"), "halt", [haltValue]),
                ts.return(),
              ]),
            ),
          );
        }
      }
      return ts.statements(stmts);
    } else if (value.type === "messageThread") {
      return this.processMessageThread(value, node);
    } else {
      return this.assigns.scopedAssign(
        node.scope!,
        variableName,
        this.processNode(value),
        node.accessChain,
      );
    }
  }

  /**
   * Process an llm() function call. Generates a direct runPrompt() call
   * (no inner function wrapper). Handles async/sync, interrupt checking,
   * response format from type hints, and tools from config object.
   */
  private processLlmCall(
    variableName: string,
    variableType: VariableType | undefined,
    node: FunctionCall,
    scope: ScopeType,
  ): TsNode {
    const _variableType = variableType || {
      type: "primitiveType" as const,
      value: "string",
    };

    const zodSchema = this.zodSchemaFor(_variableType);

    // Extract prompt from first argument, using processNode to get scoped variable references
    const promptArg = node.arguments[0];
    const promptNode = promptArg
      ? this.processCallArg(promptArg)
      : ts.raw("``");

    // Config is the second argument — passed straight through to runPrompt.
    // Tools (AgencyFunction instances, MCP tools) live in config.tools and
    // are handled entirely by runPrompt at runtime.
    const configArg = node.arguments[1];
    let clientConfig: TsNode;

    if (configArg) {
      clientConfig = this.processCallArg(configArg);
    } else {
      clientConfig = ts.obj({});
    }

    // Thread expression — always use the shared active thread.
    // For async prompts, fork via subthread so they get context but don't
    // write back to the shared thread.
    let threadExpr: TsNode = ts.threads.getOrCreateActive();
    if (node.async) {
      threadExpr = ts.threads.createAndReturnSubthread();
    }

    // Build runPrompt config object. `ctx` and `stateStack` are no longer
    // passed at the call site — `runPrompt` reads them from the active
    // ALS frame via `getRuntimeContext()`.
    const runPromptEntries: Record<string, TsNode> = {
      prompt: promptNode,
      messages: $(threadExpr).done(),
    };
    if (zodSchema !== DEFAULT_SCHEMA) {
      runPromptEntries.responseFormat = $.z()
        .prop("object")
        .namedArgs({ response: ts.raw(zodSchema) })
        .done();
    }
    runPromptEntries.clientConfig = clientConfig;
    runPromptEntries.maxToolCallRounds = ts.num(
      this.agencyConfig.maxToolCallRounds || 10,
    );
    runPromptEntries.removedTools = ts.self("__removedTools");
    runPromptEntries.checkpointInfo = ts.raw("runner.getCheckpointInfo()");

    const runPromptCall = $(ts.id("runPrompt"))
      .call([ts.obj(runPromptEntries)])
      .done();

    const varRef = ts.scopedVar(variableName, scope, this.moduleId);
    const stmts: TsNode[] = [
      ts.assign(
        ts.self("__removedTools"),
        ts.binOp(ts.self("__removedTools"), "||", ts.arr([])),
      ),
    ];

    if (node.async) {
      // Async: no await, no interrupt check. Register with pending promise store.
      stmts.push(ts.assign(varRef, runPromptCall));
      const pendingKeyVar = `__pendingKey_${variableName}`;
      stmts.push(
        ts.assign(
          ts.self(pendingKeyVar),
          ts.raw(
            // Strict accessor — inside step body under the wrap.
            `getRuntimeContext().ctx.pendingPromises.add(${this.str(varRef)}, (val) => { ${this.str(varRef)} = val; })`,
          ),
        ),
      );
    } else {
      // Sync: await + interrupt check
      stmts.push(ts.assign(varRef, ts.await(runPromptCall)));
      if (this.insideHandlerBody) {
        stmts.push(
          ts.if(
            this.interruptCheckRaw(this.str(varRef)),
            ts.throw(`new Error("Cannot throw an interrupt inside a handler body")`),
          ),
        );
      } else {
        stmts.push(ts.comment("halt if this is an interrupt"));
        const isNodeContext = this.scopes.current().type === "node";
        const haltValue = isNodeContext
          ? ts.obj({ messages: ts.runtime.threads, data: varRef })
          : varRef;
        stmts.push(
          ts.if(
            this.interruptCheck(varRef),
            ts.statements([
              ts.awaitMethodCall(
                // Strict accessor — immediate deref inside step body.
                ts.prop(ts.raw("getRuntimeContext().ctx"), "pendingPromises"),
                "awaitAll",
              ),
              ts.methodCall(ts.id("runner"), "halt", [haltValue]),
              ts.return(),
            ]),
          ),
        );
      }
    }

    return ts.statements(stmts);
  }

  private processDebuggerStatement(node: DebuggerStatement): TsNode {
    if (this.agencyConfig?.instrument === false) {
      // Debug/trace mode off: debugger keyword is a no-op
      return ts.empty();
    }

    return ts.runnerDebugger({
      id: this.steps.currentId(),
      label: node.label || "",
    });
  }

  private processMessageThread(
    node: MessageThread,
    assignTo?: Assignment,
  ): TsNode {
    const id = this.steps.currentId();
    const method =
      node.threadType === "subthread"
        ? ("createSubthread" as const)
        : ("create" as const);

    // Body: process each statement with substep tracking
    const bodyNodes = this.processBodyAsParts(node.body);

    // The Runner's thread() method handles setup (create + pushActive) and
    // cleanup (popActive). If the thread result is assigned, clone messages
    // INSIDE the callback (before popActive runs in the finally block).
    if (assignTo) {
      bodyNodes.push(
        this.assigns.scopedAssign(
          assignTo.scope!,
          assignTo.variableName,
          ts.methodCall(ts.threads.active(), "cloneMessages"),
          assignTo.accessChain,
        ),
      );
    }

    // Optional named args: thread(label, summarize, continue, session, hidden).
    // Each is an Expression in the AST — process to TsNode so codegen
    // can splice it into the opts arg. Codegen-time mutual exclusion
    // check defends parse-time guard.
    if (node.continueExpr && node.sessionExpr) {
      throw new Error(
        "thread() cannot use both `continue` and `session` — they are mutually exclusive",
      );
    }
    // `subthread` is identity-bound to its parent's context at create
    // time; resuming via `continue` or `session` would either need to
    // re-derive that parent (ambiguous) or strip the subthread linkage
    // (silently lossy). Reject at codegen so users see a clear error
    // instead of confusing runtime behaviour. (Parse-time rejection
    // would be nicer but the shared parser doesn't know which variant
    // we're in.)
    if (
      node.threadType === "subthread" &&
      (node.continueExpr || node.sessionExpr)
    ) {
      throw new Error(
        "subthread() does not support `continue` or `session` — those modes " +
          "resume a top-level thread. Use `thread(continue: ...)` or " +
          "`thread(session: ...)` instead.",
      );
    }
    const label = node.label ? this.processNode(node.label) : null;
    const summarize = node.summarize ? this.processNode(node.summarize) : null;
    const continueExpr = node.continueExpr
      ? this.processNode(node.continueExpr)
      : null;
    const sessionExpr = node.sessionExpr
      ? this.processNode(node.sessionExpr)
      : null;
    const hidden = node.hidden ? this.processNode(node.hidden) : null;

    return ts.runnerThread({
      id,
      method,
      body: bodyNodes,
      label,
      summarize,
      continueExpr,
      sessionExpr,
      hidden,
    });
  }

  private processBlockPlain(
    node: IfElse | WhileLoop | ForLoop | MatchBlock,
  ): TsNode {
    const processBody = (body: AgencyNode[]): TsNode =>
      ts.statements(body.map((s) => this.processNode(s)));

    if (node.type === "ifElse") {
      const elseBody = node.elseBody?.length
        ? node.elseBody.length === 1 && node.elseBody[0].type === "ifElse"
          ? this.processBlockPlain(node.elseBody[0] as IfElse)
          : processBody(node.elseBody)
        : undefined;
      return ts.if(
        this.processNode(node.condition),
        processBody(node.thenBody),
        { elseBody },
      );
    }
    if (node.type === "whileLoop") {
      return ts.while(this.processNode(node.condition), processBody(node.body));
    }
    if (node.type === "matchBlock") {
      // Match compiles to if/else chain
      const expression = this.processNode(node.expression);
      const filteredCases = node.cases.filter(
        (c) => c.type !== "comment",
      ) as MatchBlockCase[];
      let result: TsNode | undefined;
      let elseBody: TsNode | undefined;
      for (const caseItem of filteredCases) {
        if (caseItem.caseValue === "_") {
          elseBody = this.processNode(caseItem.body);
        }
      }
      const nonDefault = filteredCases.filter((c) => c.caseValue !== "_");
      if (nonDefault.length === 0) {
        return elseBody ?? ts.empty();
      }
      const elseIfs = nonDefault.slice(1).map((c) => ({
        condition: ts.binOp(
          expression,
          "===",
          this.processNode(c.caseValue as AgencyNode),
        ),
        body: this.processNode(c.body),
      }));
      return ts.if(
        ts.binOp(
          expression,
          "===",
          this.processNode(nonDefault[0].caseValue as AgencyNode),
        ),
        this.processNode(nonDefault[0].body),
        { elseIfs, elseBody },
      );
    }
    // forLoop — for-of with optional index
    if (node.indexVar) {
      // for (item, index in iterable) → for (let index = 0; index < iterable.length; index++) { const item = iterable[index]; ... }
      const iterableNode = this.processNode(node.iterable);
      const iterableVar = `__iter_${node.itemVar}`;
      return ts.statements([
        ts.constDecl(iterableVar, iterableNode),
        ts.forC(
          ts.letDecl(node.indexVar, ts.num(0)),
          ts.binOp(
            ts.id(node.indexVar),
            "<",
            ts.prop(ts.id(iterableVar), "length"),
          ),
          ts.postfix(ts.id(node.indexVar), "++"),
          ts.statements([
            ts.constDecl(
              node.itemVar as string,
              ts.index(ts.id(iterableVar), ts.id(node.indexVar)),
            ),
            ...node.body.map((s) => this.processNode(s)),
          ]),
        ),
      ]);
    }
    return ts.forOf(
      node.itemVar as string,
      this.processNode(node.iterable),
      processBody(node.body),
    );
  }

  /**
   * Compile the synthetic `__objectRest(source, ["a", "b", ...])` call emitted
   * by the pattern lowering pass for `let { a, b, ...rest } = obj` into a
   * native-JS IIFE. No runtime helper required.
   *
   *   __objectRest(source, ["a", "b"])
   *   → (({ a: __k0, b: __k1, ...__r }) => __r)(<resolved source>)
   *
   * For `let { ...rest } = obj` (no excluded keys), emits
   *   (({ ...__r }) => __r)(<resolved source>)
   */
  private buildObjectRestIIFE(node: FunctionCall): string {
    const [sourceArg, keysArg] = node.arguments;
    const sourceJs = this.str(this.processNode(sourceArg as Expression));

    const keys: string[] = [];
    if (keysArg && "type" in keysArg && keysArg.type === "agencyArray") {
      for (const item of keysArg.items) {
        if ("type" in item && item.type === "string") {
          const value = item.segments[0];
          if (value?.type === "text" && value.value.length > 0) {
            keys.push(value.value);
          }
        }
      }
    }

    const destructured = keys.map((k, i) => `${k}: __k${i}`).join(", ");
    // Empty destructured (no excluded keys) collapses the leading comma so
    // we never emit invalid `(({ , ...__r }) => ...)`.
    const params = destructured.length > 0
      ? `{ ${destructured}, ...__r }`
      : `{ ...__r }`;
    return `((${params}) => __r)(${sourceJs})`;
  }

  private processNodeInGlobalInit(node: AgencyNode): TsNode {
    this.insideGlobalInit = true;
    try {
      return this.processNode(node);
    } finally {
      this.insideGlobalInit = false;
    }
  }

  private buildHandlerArrow(handlerName: string): TsNode {
    if (this.names.isDirectCallFunction(handlerName)) {
      // Built-in handler (approve/reject/propagate): call with no args
      return ts.arrowFn(
        [{ name: "__data", typeAnnotation: "any" }],
        ts.call(ts.id(handlerName), []),
        { async: true },
      );
    }

    const args = [ts.id("__data")];

    // User-defined function handler: use __call
    const descriptor = ts.obj({
      type: ts.str("positional"),
      args: ts.arr(args),
    });
    const configObj = this.buildStateConfig();
    const callArgs: TsNode[] = [ts.id(handlerName), descriptor];
    if (configObj) callArgs.push(configObj);
    const callExpr = ts.call(ts.id("__call"), callArgs);
    return ts.arrowFn(
      [{ name: "__data", typeAnnotation: "any" }],
      ts.await(callExpr),
      { async: true },
    );
  }

  private processHandleBlockWithSteps(node: HandleBlock): TsNode {
    const id = this.steps.currentId();
    const subKey = this.steps.joined();
    const handlerName = `__handler_${subKey}`;

    // Build handler arrow function
    let handler: TsNode;
    if (node.handler.kind === "inline") {
      const prevInsideHandlerBody = this.insideHandlerBody;
      this.insideHandlerBody = true;
      const handlerBody = node.handler.body.map((stmt) =>
        this.processStatement(stmt),
      );
      this.insideHandlerBody = prevInsideHandlerBody;
      const paramType = node.handler.param.typeHint
        ? formatTypeHintTs(node.handler.param.typeHint)
        : "any";
      handler = ts.arrowFn(
        [{ name: node.handler.param.name, typeAnnotation: paramType }],
        ts.statements(handlerBody),
        { async: true },
      );
    } else {
      handler = this.buildHandlerArrow(node.handler.functionName);
    }

    // Body: process each statement with substep tracking
    const bodyNodes = this.processBodyAsParts(node.body);

    return ts.runnerHandle({ id, handler, body: bodyNodes });
  }

  private processWithModifier(node: WithModifier): TsNode {
    const id = this.steps.currentId();
    const handler = this.buildHandlerArrow(node.handlerName);
    const bodyNodes = this.processBodyAsParts([node.statement]);
    return ts.runnerHandle({ id, handler, body: bodyNodes });
  }

  /** In debugger mode, insert debuggerStatement nodes before each
   *  step-triggering statement so that debugStep() is called at every
   *  substep boundary, not just top-level steps. */
  private insertDebugSteps(body: AgencyNode[]): AgencyNode[] {
    if (this.agencyConfig?.instrument === false) return body;
    const expanded: AgencyNode[] = [];
    for (const stmt of body) {
      if (
        !TYPES_THAT_DONT_TRIGGER_NEW_PART.includes(stmt.type) &&
        stmt.type !== "debuggerStatement"
      ) {
        // Borrow the loc of the statement about to execute (see spec note on this)
        expanded.push({
          type: "debuggerStatement",
          loc: stmt.loc,
        } as DebuggerStatement);
      }
      expanded.push(stmt);
    }
    return expanded;
  }


  // ── Body processing ──

  private processBodyAsParts(
    body: AgencyNode[],
    startId = 0,
  ): TsNode[] {
    const result: TsNode[] = [];
    const branchKeys: Record<number, string> = {};

    // Track the current "part" being built (for non-pipe statements)
    let currentPart: TsNode[] | null = null;

    const nextId = () => startId + result.length;

    const flushPart = () => {
      if (currentPart) {
        const id = nextId();
        if (branchKeys[id]) {
          result.push(
            ts.runnerBranchStep({
              id,
              branchKey: branchKeys[id],
              body: currentPart,
            }),
          );
        } else {
          result.push(ts.runnerStep({ id, body: currentPart }));
        }
        currentPart = null;
      }
    };

    for (const stmt of body) {
      // Pipe chains produce pre-formed runner nodes
      const pipeStages = this.pipes.tryGetChainStages(stmt);
      if (pipeStages) {
        flushPart();
        const baseId = nextId();
        const pipeNodes = this.pipes.expand(
          stmt as Assignment,
          pipeStages,
          baseId,
        );
        for (let i = 0; i < pipeNodes.length; i++) {
          this.steps.push(baseId + i);
          result.push(pipeNodes[i]);
          this._sourceMapBuilder.record(this.steps.snapshot(), stmt.loc);
          this.steps.pop();
        }
        continue;
      }

      if (!TYPES_THAT_DONT_TRIGGER_NEW_PART.includes(stmt.type)) {
        flushPart();
      }

      const stepIndex = nextId();
      this.steps.push(stepIndex);
      if (!this.scopes.inSafeFunction && this.names.containsImpureCall(stmt)) {
        if (!currentPart) currentPart = [];
        currentPart.push(ts.assign(ts.self("__retryable"), ts.bool(false)));
      }
      const processed = this.processStatement(stmt);
      if (COMPOUND_RUNNER_KINDS.has(processed.kind)) {
        result.push(processed);
      } else {
        if (!currentPart) currentPart = [];
        currentPart.push(processed);
      }
      if (this._asyncBranchCheckNeeded) {
        branchKeys[nextId()] = this.steps.joined();
        this._asyncBranchCheckNeeded = false;
      }
      this._sourceMapBuilder.record(this.steps.snapshot(), stmt.loc);
      this.steps.pop();
    }

    flushPart();
    return result;
  }

  // ------- Imports and pre/post processing -------

  private generateBuiltins(): string {
    return generateBuiltinHelpers(this.functionsUsed);
  }

  private generateImports(): string {
    const cfg = this.agencyConfig;

    const statelogFields: Record<string, TsNode> = {
      host: ts.str(cfg.log?.host || ""),
      apiKey: cfg.log?.apiKey
        ? ts.str(cfg.log.apiKey)
        : ts.binOp(ts.env("STATELOG_API_KEY"), "||", ts.str("")),
      projectId: ts.str(cfg.log?.projectId || ""),
      debugMode: ts.bool(cfg.log?.debugMode || false),
      observability: ts.bool(cfg.observability || false),
    };
    if (cfg.log?.logFile) {
      statelogFields.logFile = ts.str(cfg.log.logFile);
    }
    if (cfg.log?.requestTimeoutMs !== undefined) {
      statelogFields.requestTimeoutMs = ts.raw(
        String(cfg.log.requestTimeoutMs),
      );
    }
    if (cfg.log?.metadata) {
      const metaFields: Record<string, TsNode> = {};
      if (cfg.log.metadata.tags) {
        metaFields.tags = ts.raw(JSON.stringify(cfg.log.metadata.tags));
      }
      if (cfg.log.metadata.environment) {
        metaFields.environment = ts.str(cfg.log.metadata.environment);
      }
      if (cfg.log.metadata.userId) {
        metaFields.userId = ts.str(cfg.log.metadata.userId);
      }
      if (cfg.log.metadata.agentVersion) {
        metaFields.agentVersion = ts.str(cfg.log.metadata.agentVersion);
      }
      if (cfg.log.metadata.custom) {
        metaFields.custom = ts.raw(JSON.stringify(cfg.log.metadata.custom));
      }
      statelogFields.metadata = ts.obj(metaFields);
    }
    const statelogConfig = ts.obj(statelogFields);

    const smoltalkDefaults = ts.obj({
      openAiApiKey: cfg.client?.openAiApiKey
        ? ts.str(cfg.client.openAiApiKey)
        : ts.binOp(ts.env("OPENAI_API_KEY"), "||", ts.str("")),
      googleApiKey: cfg.client?.googleApiKey
        ? ts.str(cfg.client.googleApiKey)
        : ts.binOp(ts.env("GEMINI_API_KEY"), "||", ts.str("")),
      model: ts.str(cfg.client?.defaultModel || "gpt-4o-mini"),
      logLevel: ts.str(cfg.client?.logLevel || "warn"),
      statelog: ts.obj({
        host: ts.str(cfg.client?.statelog?.host || ""),
        projectId: ts.str(cfg.client?.statelog?.projectId || ""),
        apiKey: ts.binOp(ts.env("STATELOG_SMOLTALK_API_KEY"), "||", ts.str("")),
        traceId: $(ts.id("nanoid")).call().done(),
      }),
    });

    const runtimeCtxArgs: Record<string, TsNode> = {
      statelogConfig,
      smoltalkDefaults,
      dirname: ts.id("__dirname"),
    };
    if (this.agencyConfig.verbose) {
      runtimeCtxArgs.verbose = ts.raw("true");
    }
    // Always render the top-level logLevel; `configDefaults()` guarantees
    // a value, so this never emits a runtime default-fallback path. The
    // RuntimeContext uses this to construct ad-hoc loggers in subsystems
    // (e.g. memory) on demand.
    if (this.agencyConfig.logLevel) {
      runtimeCtxArgs.logLevel = ts.str(this.agencyConfig.logLevel);
    }
    if (this.agencyConfig.checkpoints?.maxRestores !== undefined) {
      runtimeCtxArgs.maxRestores = ts.raw(
        String(this.agencyConfig.checkpoints.maxRestores),
      );
    }

    const traceConfigFields: Record<string, TsNode> = {
      program: ts.str(this.moduleId),
    };
    if (this.agencyConfig.traceDir) {
      traceConfigFields.traceDir = ts.str(this.agencyConfig.traceDir);
    }
    if (this.agencyConfig.traceFile) {
      traceConfigFields.traceFile = ts.str(this.agencyConfig.traceFile);
    }
    runtimeCtxArgs.traceConfig = ts.obj(traceConfigFields);

    if (this.agencyConfig.memory) {
      const mem = this.agencyConfig.memory;
      const memoryFields: Record<string, TsNode> = {
        dir: ts.str(mem.dir),
      };
      if (mem.model) memoryFields.model = ts.str(mem.model);
      if (mem.autoExtract?.interval !== undefined) {
        memoryFields.autoExtract = ts.obj({
          interval: ts.raw(String(mem.autoExtract.interval)),
        });
      }
      if (mem.compaction) {
        const compFields: Record<string, TsNode> = {};
        if (mem.compaction.trigger) {
          compFields.trigger = ts.str(mem.compaction.trigger);
        }
        if (mem.compaction.threshold !== undefined) {
          compFields.threshold = ts.raw(String(mem.compaction.threshold));
        }
        memoryFields.compaction = ts.obj(compFields);
      }
      if (mem.embeddings?.model) {
        memoryFields.embeddings = ts.obj({
          model: ts.str(mem.embeddings.model),
        });
      }
      runtimeCtxArgs.memory = ts.obj(memoryFields);
    }

    const runtimeCtxStatements: TsNode[] = [
      ts.constDecl(
        "__globalCtx",
        ts.new(ts.id("RuntimeContext"), [ts.obj(runtimeCtxArgs)]),
      ),
      ts.constDecl("graph", $(ts.runtime.globalCtx).prop("graph").done()),
    ];

    // If any function has a doc string with interpolation, the tool
    // description is evaluated at module load time and may need to
    // reference module globals. The codegen flips `topLevel: true` on
    // every `TsScopedVar` in the description subtree (via
    // `markTopLevelScopedVars`); the pretty-printer then emits
    // `__globalCtx.globals.get(...)` for those reads. Triggering
    // `__initializeGlobals(__globalCtx)` eagerly populates the values
    // before the descriptions evaluate.
    //
    // Previously this block also emitted `const __ctx = __globalCtx;`
    // as a module-top-level rebind so descriptions could read
    // `__ctx.globals.get(...)`. That rebind is gone: it would now
    // shadow the `__ctx` runtime import (which is a function in the
    // post-ALS migration) and break every accessor call. The
    // topLevel-flagged scopedVars handle the description case directly.
    //
    // Caveat: `__initializeGlobals` is async; for modules with
    // `static` declarations or async global initializers, top-level
    // interpolation may still see uninitialized values. Synchronous
    // literal globals are populated before the function returns.
    if (this.hasDocStringInterpolation()) {
      runtimeCtxStatements.push(
        ts.raw(`__initializeGlobals(__globalCtx);`),
      );
    }

    const runtimeCtx: TsNode = ts.statements(runtimeCtxStatements);

    return renderImports.default({
      runtimeContextCode: printTs(runtimeCtx),
    });
  }

  private preprocess(): TsNode[] {
    const nodes: TsNode[] = [];
    this.compilationUnit.importedNodes.forEach((importNode) => {
      const from = importNode.agencyFile.replace(".agency", ".js");
      const defaultImportName = this.agencyFileToDefaultImportName(
        importNode.agencyFile,
      );
      nodes.push(
        ts.importDecl({
          importKind: "default",
          defaultName: defaultImportName,
          from,
        }),
      );
      const nodeParamNames = importNode.importedNodes.map(
        (name) => `__${name}NodeParams`,
      );
      nodes.push(
        ts.importDecl({ importKind: "named", names: nodeParamNames, from }),
      );
      // Re-exported nodes (synthesized by `resolveReExports`): also emit a
      // JS-level re-export of `__<name>NodeParams` from the source so other
      // files can `import node { ... } from "this-file"`. The default graph
      // is already chained through via `graph.merge(...)` in postprocess.
      if (importNode.reExport && nodeParamNames.length > 0) {
        nodes.push(
          ts.raw(
            `export { ${nodeParamNames.join(", ")} } from ${JSON.stringify(from)}`,
          ),
        );
      }
    });
    return nodes;
  }

  private postprocess(): TsNode[] {
    const result: TsNode[] = [];

    Object.keys(this.adjacentNodes).forEach((nodeName) => {
      const adjacent = this.adjacentNodes[nodeName];
      if (adjacent.length === 0) {
        return;
      }
      result.push(
        $(ts.id("graph"))
          .prop("conditionalEdge")
          .call([
            ts.str(nodeName),
            ts.arr(adjacent.map((a: string) => ts.str(a))),
          ])
          .done(),
      );
    });

    this.compilationUnit.importedNodes.forEach((importNode) => {
      const defaultImportName = this.agencyFileToDefaultImportName(
        importNode.agencyFile,
      );
      result.push(
        $(ts.id("graph"))
          .prop("merge")
          .call([ts.id(defaultImportName)])
          .done(),
      );
    });

    for (const node of this.compilationUnit.graphNodes) {
      const args = node.parameters;
      const fnParams: {
        name: string;
        typeAnnotation?: string;
        defaultValue?: TsNode;
      }[] = [];
      if (args.length > 0) {
        for (const arg of args) {
          const typeHint = arg.typeHint ? formatTypeHintTs(arg.typeHint) : "any";
          fnParams.push({ name: arg.name, typeAnnotation: typeHint });
        }
      }
      fnParams.push({
        name: "{ messages, callbacks }",
        typeAnnotation: "{ messages?: any; callbacks?: any }",
        defaultValue: ts.obj({}),
      });
      const dataObj: Record<string, TsNode> = {};
      for (const arg of args) {
        dataObj[arg.name] = ts.id(arg.name);
      }
      result.push(
        ts.functionDecl(
          node.nodeName,
          fnParams,
          ts.return(
            $(ts.id("runNode"))
              .call([
                ts.obj({
                  ctx: ts.runtime.globalCtx,
                  nodeName: ts.str(node.nodeName),
                  data: ts.obj(dataObj),
                  messages: ts.id("messages"),
                  callbacks: ts.id("callbacks"),
                  initializeGlobals: ts.id("__initializeGlobals"),
                  registerTopLevelCallbacks: ts.id(
                    "__registerTopLevelCallbacks",
                  ),
                  moduleDir: ts.id("__dirname"),
                }),
              ])
              .done(),
          ),
          { async: true, export: true, returnType: "Promise<RunNodeResult<any>>" },
        ),
      );
      result.push(
        ts.export(
          ts.varDecl(
            "const",
            `__${node.nodeName}NodeParams`,
            ts.arr(args.map((arg) => ts.str(arg.name))),
          ),
        ),
      );
    }

    if (this.compilationUnit.graphNodes.map((n) => n.nodeName).includes("main")) {
      result.push(
        ts.if(
          ts.binOp(
            $(ts.id("__process")).prop("argv").index(ts.num(1)).done(),
            "===",
            ts.call(ts.id("fileURLToPath"), [
              $(ts.id("import")).prop("meta").prop("url").done(),
            ]),
          ),
          ts.tryCatch(
            ts.statements([
              ts.varDecl(
                "const",
                "initialState",
                ts.obj({
                  messages: ts.newThreadStore(),
                  data: ts.obj({}),
                }),
              ),
              ts.await(ts.call(ts.id("main"), [ts.id("initialState")])),
            ]),
            ts.statements([
              ts.consoleError(
                ts.template([
                  {
                    text: "\\nAgent crashed: ",
                    expr: $(ts.id("__error")).prop("message").done(),
                  },
                ]),
              ),
              ts.throw("__error"),
            ]),
            "__error: any",
          ),
        ),
      );
    }

    result.push(ts.raw("export default graph"));

    return result;
  }
}
