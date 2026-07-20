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
import { MatchYield } from "../types/matchYield.js";
import { matchValName, isMatchValName } from "../matchVal.js";
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
  hasAliasValidate,
} from "./typescriptGenerator/validationDescriptor.js";
import { tagArgToTs } from "./typescriptGenerator/tagArgToTs.js";
import { resolveTypeDeep, safeResolveType } from "../typeChecker/assignability.js";
import { isAnyType, isFunctionTyped, paramAcceptsFailure } from "../typeChecker/utils.js";
import { rejectValueParamCycle } from "./valueParamCycle.js";

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
import { functionContainsDestructiveBlock } from "./functionContainsDestructiveBlock.js";
import { DestructiveTracking } from "./typescriptBuilder/destructiveTracking.js";
import {
  FinalizeCodegen,
  type CompiledScopeFinalize,
} from "./typescriptBuilder/finalizeCodegen.js";
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
  private tracking: DestructiveTracking;
  private pipes: PipeChainEmitter;
  private assigns: AssignmentEmitter;
  private finalize: FinalizeCodegen;

  // Config
  private agencyConfig: AgencyConfig = {};

  // Graph topology tracking
  private adjacentNodes: Record<string, string[]> = {};
  private currentAdjacentNodes: string[] = [];
  private isInsideGraphNode: boolean = false;

  // Threading & control flow
  private loopVars: string[] = [];
  private insideHandlerBody: boolean = false;
  // Handler bodies emit all their statements into a single arrow-function
  // scope (unlike node/function bodies, where each statement is wrapped in
  // its own substep block). A fixed `__funcResult` temp name therefore
  // collides when a handler body has multiple statement-level interrupt
  // checks. This counter gives each one a unique name.
  private handlerFuncResultCounter: number = 0;
  private insideGlobalInit: boolean = false;
  // Gives each plain-mode (handler) for-loop unique names for its normalization
  // temps, so nested loops in the same block don't collide.
  private plainForLoopCounter: number = 0;
  // Set while emitting the body of a plain-mode (handler) match EXPRESSION,
  // whose arms are wrapped in an async IIFE. Inside it, a `matchYield` compiles
  // to a real `return <value>` (exiting the IIFE) instead of the stepped
  // `runner.exitMatch`, so the handler never touches the `_matchExit` flag.
  //
  // INVARIANT: this must be true ONLY where a `return` lands directly in the
  // IIFE. Today that holds because (a) `matchYield` nodes exist only inside
  // expression-match regions, every one of which routes through
  // `processMatchExpressionPlain` in a handler, and (b) the builder never
  // switches OUT of plain mode within the IIFE — it does not reset
  // `insideHandlerBody` at block-argument / nested-frame boundaries, so nothing
  // stepped compiles inside a handler. At every yield site this flag therefore
  // currently equals `insideHandlerBody`. If a future change starts compiling
  // stepped constructs inside a handler (e.g. resetting `insideHandlerBody` per
  // frame), reset THIS flag at those same boundaries too — otherwise a stepped
  // match nested in a plain arm would emit a bare `return` inside a step
  // callback (value discarded, `_matchExit` never set: a silent wrong answer).
  private insidePlainMatchExpr: boolean = false;

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
   * Optional per-module init plan + cross-module alias resolver produced
   * by `compileClosure`. When present, drives:
   *   - the order of local static/global assignments (topsort-ordered
   *     rather than source-ordered), and
   *   - the per-phase `await __awaitStaticInit(...)` /
   *     `__awaitGlobalsInit(...)` prelude emitted in this module's
   *     init functions, and
   *   - the PR-1 trap message: `__readStatic` is called with the
   *     SOURCE moduleId of an imported binding, not the placeholder
   *     "<unknown module>" used before.
   *
   * When absent (callers that haven't migrated to compileClosure, or
   * single-file unit tests), codegen falls back to source order and
   * omits the cross-module awaits — the lazy per-function
   * `isInitialized` guards plus the runtime trap remain the safety net.
   */
  private initPlan?: {
    registryModuleId: string;
    staticLocalOrder: string[];
    staticAwaitModules: { localImport: string; sourceModuleId: string }[];
    globalLocalOrder: string[];
    globalAwaitModules: { localImport: string; sourceModuleId: string }[];
    resolveImportedName: (
      localName: string,
    ) => { sourceModuleId: string; sourceName: string } | null;
  };

  /**
   * @param config - Agency compiler configuration (model defaults, logging, etc.)
   * @param info - Pre-collected program metadata (function definitions, graph nodes, imports, type hints)
   * @param moduleId - Unique identifier for this module (e.g., "foo.agency"), used to
   *   namespace global variables in the GlobalStore so that different modules' globals
   *   don't collide. Must be consistent between the defining module and any importers.
   * @param outputFile - Absolute path where the generated code will be written.
   *   Used to compute relative import paths for stdlib. If not provided, falls
   *   back to resolving moduleId against cwd.
   * @param initPlan - Optional per-module init plan + resolver from
   *   `compileClosure`. See the field docstring above.
   */
  constructor(
    config: AgencyConfig | undefined,
    info: CompilationUnit,
    moduleId: string,
    outputFile?: string,
    initPlan?: TypeScriptBuilder["initPlan"],
  ) {
    this.agencyConfig = mergeDeep(this.configDefaults(), config || {});
    this.compilationUnit = info;
    this.scopes = new ScopeManager(info);
    this.names = new NameClassifier(info);
    this.tracking = new DestructiveTracking(this.names, info);
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
      resolveBlockFrameVar: (blockDepth: number) =>
        this.scopes.blockFrameVar(blockDepth),
    });
    this.finalize = new FinalizeCodegen(this.scopes, moduleId, (body, stepBase) =>
      this.processBodyAsParts(body, stepBase),
    );
    this.moduleId = moduleId;
    this.outputFile = outputFile;
    this.initPlan = initPlan;
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
      typechecker: {
        enabled: true,
        strict: true,
        undefinedFunctions: "warn",
        undefinedVariables: "warn",
        strictMemberAccess: "error",
        matchExhaustiveness: "error",
        definiteReturns: "error",
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
    if (parentOp === "**")
      return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
    return PRECEDENCE[child.operator] < PRECEDENCE[parentOp];
  }

  private needsParensRight(child: BinOpArgument, parentOp: Operator): boolean {
    if (child.type !== "binOpExpression") return false;
    return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
  }

  // ------- Main entry point -------

  build(program: AgencyProgram): TsNode {
    // Plain top-level aliases in source order — the basis for the derived
    // pending-alias computation (see pendingAliasesFor). Captured once;
    // partitionProgram keeps top-level declarations in source order, so
    // source offsets are a faithful oracle for const-initialization order.
    this.aliasEmissionOrder = program.nodes
      .filter(
        (n): n is TypeAlias =>
          n.type === "typeAlias" && !n.typeParams && !n.valueParams,
      )
      .map((n) => ({ name: n.aliasName, start: n.loc?.start ?? 0 }));

    // Generate tool registry (empty — AgencyFunction.create() populates it)
    this.generatedStatements.push(this.generateToolRegistry());

    // Sort program nodes into static-init / global-init / top-level buckets.
    // When an InitPlan is available, partition emits local assignments in
    // topsort order instead of source order; otherwise falls back to
    // source order (legacy path).
    const partition = partitionProgram(program, {
      processNode: (n) => this.processNode(n),
      processNodeInGlobalInit: (n) => this.processNodeInGlobalInit(n),
      buildHandlerArrow: (h) => this.buildHandlerArrow(h),
      isTopLevelDeclaration: (n) => this.names.isTopLevelDeclaration(n),
      moduleId: this.moduleId,
      staticOrder: this.initPlan?.staticLocalOrder,
      globalOrder: this.initPlan?.globalLocalOrder,
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
      staticAwaitModules: this.initPlan?.staticAwaitModules,
      globalAwaitModules: this.initPlan?.globalAwaitModules,
      registryModuleId: this.initPlan?.registryModuleId,
      staticLocalOrder: this.initPlan?.staticLocalOrder,
      globalLocalOrder: this.initPlan?.globalLocalOrder,
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
      // `fork`/`race` carrying a block is a CALL, not a function
      // reference, and its lowering lives in processForkCall (reached
      // via processNode -> processFunctionCall). The "functionArg"
      // path below treats a functionCall argument as a reference and
      // emits `__call(fork, ...)`, where `fork` is an undefined
      // identifier - the ReferenceError this guard prevents. The
      // presence of a block is the same discriminator
      // processFunctionCall keys on, so a bare `map(xs, double)`
      // reference is unaffected.
      if (
        arg.type === "functionCall" &&
        (arg.functionName === "fork" || arg.functionName === "race") &&
        arg.block
      ) {
        return this.processCallArg(arg);
      }
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
      case "markDestructiveRan":
        // Synthetic flip from an inlined `destructive { }` region. Inlined into
        // the function body, so `__self` is the function activation.
        return this.tracking.markDestructiveRan();
      case "typeAlias":
        if (this.hoistedTypeAliasNodes.has(node)) return ts.empty();
        return this.processTypeAlias(node);
      case "effectDeclaration":
        // Compile-time only: declarations erase like type aliases.
        return ts.empty();
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
          ? this.processPlainBranching(node)
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
      case "matchYield":
        return this.processMatchYield(node);
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
          ? this.processPlainBranching(node)
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
    const loopSubKey = this.steps.currentLoopKey();
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
        (a) => a.type === "function" || a.type === "graphNode",
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
    if (node.valueParams) {
      rejectValueParamCycle(node, this.scopes.visibleTypeAliasesFull());
    }
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
    // Value-parameterized aliases have no single schema — every use-site
    // depends on the value args. For a VALIDATED one we emit a descriptor
    // FACTORY here, in the alias's own module, so the validators it
    // references stay in scope (exactly like a bare alias's
    // `__agency_descriptor`). Use sites call `AliasName(args)` (see
    // validationDescriptor.ts). A NON-validated value-param alias has no
    // validators to leak, so it keeps emitting nothing and its schema is
    // inlined at the use site.
    if (node.valueParams && node.valueParams.length > 0) {
      const vpAliasesFull = this.scopes.visibleTypeAliasesFull();
      const vpAliasedWithTags: VariableType = node.tags
        ? {
            ...node.aliasedType,
            tags: [...(node.aliasedType.tags ?? []), ...node.tags],
          }
        : node.aliasedType;
      if (!hasAnyValidateTag(vpAliasedWithTags, vpAliasesFull)) {
        return ts.empty();
      }
      // Build the descriptor from the UNRESOLVED body. Unlike the bare-alias
      // path we must NOT `resolveTypeDeep` here: the body legitimately
      // contains this alias's own value-param identifiers (and, for a
      // forwarding alias, a reference to another value-param alias). Deep
      // resolution eagerly substitutes those, which both (a) trips
      // `applyValueArgs`'s unsubstituted-param guard when a forwarded name
      // collides with the inner param name, and (b) inlines the inner
      // alias's validators into THIS factory — re-introducing the
      // cross-module leak this feature exists to remove. Leaving the body
      // intact lets `buildValidationDescriptor` emit a nested factory CALL
      // for any value-param reference (validators resolve in their own
      // module); the schema strings still substitute identifiers locally.
      // Value-param factories HOIST but their bodies execute when called —
      // possibly from a load-time descriptor initializer ANYWHERE in the
      // module, so no source position bounds which aliases are safe. Treat
      // every module alias as pending: z.lazy is always safe and only
      // costs indirection.
      const vpDescriptor = buildValidationDescriptor(
        vpAliasedWithTags,
        this.scopes.visibleTypeAliases(),
        vpAliasesFull,
        this.pendingAliasesFor(undefined),
      );
      // Bake value-param DEFAULTS into the factory signature so an omitted
      // use-site arg (e.g. `Age()!` or bare `Age!`) resolves the same default
      // the old inline path got via `applyValueArgs` (which fills
      // `bindings[p.name] = p.default`). Without this, `function Age(low)`
      // called as `Age()` leaves `low` undefined and
      // `min.partial({ n: undefined })` silently mis-validates.
      const vpFnParams: TsParam[] = node.valueParams.map((p) =>
        p.default !== undefined
          ? { name: p.name, defaultValue: ts.raw(tagArgToTs(p.default)) }
          : { name: p.name },
      );
      return ts.functionDecl(
        node.aliasName,
        vpFnParams,
        ts.statements([ts.return(vpDescriptor)]),
        { export: node.exported },
      );
    }
    const exportPrefix = node.exported ? "export " : "";
    // Thread alias-level @validate / @jsonSchema tags onto the body type so
    // appendMeta (in typeToZodSchema) attaches the `.meta(...)` chain to the
    // top-level alias schema. Without this, alias-level annotations would
    // never reach the codegen since only use-site `VariableType.tags` are
    // consulted; alias-level tags live on the `TypeAlias` node itself.
    const aliasedWithTags: VariableType = node.tags
      ? {
          ...node.aliasedType,
          tags: [...(node.aliasedType.tags ?? []), ...node.tags],
        }
      : node.aliasedType;
    // `type Loop = Loop` (directly or via `type A = B` + `type B = A`) has
    // no base case: its lazy schema would recurse at first parse, and its
    // validation descriptors would chain ref -> ref forever. TS rejects the
    // shape too. Resolve the alias CHAIN with safeResolveType — its
    // in-progress guard leaves genuinely circular chains as a nominal ref,
    // while a legitimate alias-of-alias (`type Point = Coords`) resolves
    // through to the referenced body. An unknown alias also stays nominal
    // but has no registry entry: fall through to the regular
    // undefined-alias diagnostic instead of a misleading circularity error.
    if (node.aliasedType.type === "typeAliasVariable") {
      const aliasesFull = this.scopes.visibleTypeAliasesFull();
      const chainEnd = safeResolveType(node.aliasedType, aliasesFull);
      if (
        chainEnd.type === "typeAliasVariable" &&
        aliasesFull[chainEnd.aliasName]
      ) {
        throw new Error(
          `Type alias '${node.aliasName}' circularly references itself with no structure. Give it an object, array, or union shape.`,
        );
      }
    }
    const zodSchema = this.zodSchemaFor(
      aliasedWithTags,
      this.pendingAliasesFor(node.loc?.start),
    );
    const stmts: TsNode[] = [
      ts.raw(`${exportPrefix}const ${node.aliasName} = ${zodSchema};`),
      ts.raw(
        `${exportPrefix}type ${node.aliasName} = z.infer<typeof ${node.aliasName}>;`,
      ),
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
        this.pendingAliasesFor(node.loc?.start),
      );
      // `(Foo as any).__agency_descriptor = ...` — keeps the runtime metadata
      // co-located with the schema and avoids exporting/importing a second
      // symbol. Cast to `any` because Zod's typings don't know about us.
      stmts.push(
        ts.assign(
          ts.prop(ts.raw(`(${node.aliasName} as any)`), "__agency_descriptor"),
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
  private zodSchemaFor(t: VariableType, pendingAliases?: Set<string>): string {
    const aliasesFull = this.scopes.visibleTypeAliasesFull();
    const resolved = resolveTypeDeep(t, aliasesFull);
    return mapTypeToValidationSchema(
      resolved,
      this.scopes.visibleTypeAliases(),
      aliasesFull,
      pendingAliases,
    );
  }

  /** See build() — plain top-level aliases in source order. */
  private aliasEmissionOrder: { name: string; start: number }[] = [];

  /**
   * Aliases whose schema const is NOT yet initialized when module-load
   * code originating at source offset `start` runs: every plain top-level
   * alias declared at-or-after that offset. A PURE derivation from the
   * program captured in build() — no mutable emitted-set to keep in sync.
   * Generic/value-param aliases never emit consts (inlined / hoisted
   * factory functions) and function-body aliases initialize at call time,
   * so neither is listed. `start` undefined treats ALL listed aliases as
   * pending — z.lazy is always safe; over-inclusion only costs
   * indirection.
   */
  private pendingAliasesFor(start: number | undefined): Set<string> {
    if (start === undefined) {
      return new Set(this.aliasEmissionOrder.map((a) => a.name));
    }
    return new Set(
      this.aliasEmissionOrder
        .filter((a) => a.start >= start)
        .map((a) => a.name),
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
      const zodSchema = mapTypeToValidationSchema(
        resolved,
        aliases,
        aliasesFull,
      );
      return ts.validateType(value, ts.raw(zodSchema));
    }
    const descriptor = buildValidationDescriptor(
      resolved,
      aliases,
      aliasesFull,
    );
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
        // A builtin name (e.g. `color`) is only the *fallback* meaning of the
        // identifier. A real binding — a parameter, local, etc. — with a
        // resolved scope shadows it, exactly like in any lexically-scoped
        // language. Without this guard a parameter named `color` compiles to a
        // bare JS identifier instead of `__stack.args.color`, so its default
        // value (and any value restored on resume) is silently lost: the body
        // reads the undefaulted local while the default lands in the stack
        // slot. See issue #453.
        const isBuiltinVar =
          BUILTIN_VARIABLES.includes(literal.value) && importedOrUnknownScope;
        const isLoopVar = this.loopVars.includes(literal.value);
        if (importedOrUnknownScope || isBuiltinVar || isLoopVar) {
          // Agency imports may resolve to a `static const` in the source
          // module, whose value is `__UNINIT_STATIC` until its initializer
          // has run. Wrap reads in `__readStatic` so an early access
          // throws a clear error instead of silently propagating the
          // sentinel (which would surface as a confusing JS engine error
          // like "Cannot convert a Symbol value to a string"). For
          // non-static agency imports (functions, nodes) the wrap is a
          // no-op because the binding never equals the sentinel. JS
          // imports, builtins, and loop vars are not wrapped — they're
          // never statics. Compiler-emitted boilerplate (e.g.
          // `__registerTool(name)`) builds its source with `ts.raw`, not
          // through this case, so it is unaffected.
          //
          // `scope === "imported"` is mutually exclusive with builtin
          // and loop-var names at the source level, so we only need to
          // check the import side.
          if (
            literal.scope === "imported" &&
            this.names.isAgencyImport(literal.value)
          ) {
            // Thread the SOURCE module path through to the trap message
            // when we know it (always, when compileClosure built our
            // InitPlan). Without the plan, the empty string falls back
            // to the runtime trap's "<unknown module>" placeholder —
            // less helpful but never silently wrong.
            const sourceModuleId =
              this.initPlan?.resolveImportedName(literal.value)
                ?.sourceModuleId ?? "";
            return ts.call(ts.id("__readStatic"), [
              ts.id(literal.value),
              ts.str(literal.value),
              ts.str(sourceModuleId),
            ]);
          }
          // Synthetic match-expression result temps (`__matchval_<id>`) are
          // written by `runner.exitMatch(id, value)` into
          // `runner.frame.locals.__matchval_<id>` (i.e. `__stack.locals`), but
          // pattern lowering emits the *read* as a plain `variableName` with
          // no declaration, so scope resolution leaves it unresolved and it
          // would otherwise compile to a bare, undeclared JS identifier.
          // Resolve it to the same frame-local accessor `exitMatch` writes to
          // so the consumer (`const x = match(...)` / `return match(...)`)
          // sees the value. Applies ONLY here, in the unresolved-scope branch:
          // a USER variable that happens to be named `__matchval_<n>` arrives
          // with a resolved scope (local/block/blockArgs/...) or as a loop
          // var / builtin / agency import, and must resolve through the
          // normal paths untouched.
          if (!isBuiltinVar && !isLoopVar && isMatchValName(literal.value)) {
            // A `match` expression with no matching arm (and no `_`) never
            // writes `__matchval_<id>`, so the read is `undefined`. Normalize
            // to Agency's single nothing-value, `null`. This one read site is
            // the chokepoint for every match-result path (stepped no-arm and
            // the plain-mode IIFE that returns `undefined`). See #409.
            return ts.call(ts.id("__nn"), [
              ts.scopedVar(literal.value, "local", this.moduleId),
            ]);
          }
          return ts.id(literal.value);
        }
        const blockFrameVar =
          literal.scope === "block" || literal.scope === "blockArgs"
            ? this.scopes.blockFrameVar(literal.blockDepth ?? 0)
            : undefined;
        return ts.scopedVar(
          literal.value,
          literal.scope!,
          this.moduleId,
          blockFrameVar,
        );
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

  private processValueAccess(node: ValueAccess, asLValue = false): TsNode {
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
          result = ts.prop(result, element.name, {
            optional: element.optional,
          });
          break;
        case "index":
          result = ts.index(result, this.processNode(element.index), {
            optional: element.optional,
          });
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
          const sliceProp = ts.prop(result, "slice", {
            optional: element.optional,
          });
          result = ts.call(sliceProp, args);
          break;
        }
        case "methodCall": {
          const fnCall = element.functionCall;
          const descriptor = this.buildCallDescriptor(fnCall);
          const callArgs: TsNode[] = [
            result,
            ts.str(fnCall.functionName),
            descriptor,
          ];
          if (element.optional) callArgs.push(ts.bool(true));
          result = this.awaitChainCall(
            ts.call(ts.id("__callMethod"), callArgs),
            element === node.chain[node.chain.length - 1],
          );
          break;
        }
        case "call": {
          const descriptor = this.buildCallDescriptor(element);
          const callArgs: TsNode[] = [result, descriptor];
          if (element.optional) callArgs.push(ts.bool(true));
          result = this.awaitChainCall(
            ts.call(ts.id("__call"), callArgs),
            element === node.chain[node.chain.length - 1],
          );
          break;
        }
      }
    }
    // Normalize the observable value of a *terminal* index read (`obj[key]`,
    // `arr[i]`) to `null` when the key is missing / index is out of bounds.
    // Wrap only the completed chain, and only when its last element is an
    // index: wrapping each `case "index"` element individually would insert
    // `__nn` *between* an optional index and a following access, capturing JS
    // optional-chain short-circuit and turning `a?.[b].c` (null `a` → whole-
    // chain `undefined`) into `null.c` → a thrown TypeError. Intermediate
    // missing reads still throw exactly as before (the terminal `__nn` runs
    // last), and the emitted shape is a single `__nn(...)`, never nested.
    //
    // `asLValue` skips the wrap when this access is emitted as an
    // assignment/update *target* (`x[i]++`, `x[i] += v`) — `__nn(x[i]) = ...`
    // is not a valid assignment target. Those targets stay raw lvalues.
    //
    // An *optional* terminal index (`arr?.[i]`) is left raw: optional chaining
    // is deliberately deferred (see docs/dev/null-and-undefined.md), so `?.[]`
    // stays consistent with `?.` property access — both yield `undefined` on a
    // null base rather than `null`. Only a plain `[i]` — issue #409's actual
    // target — is normalized.
    // See docs/dev/null-and-undefined.md and issue #409.
    const lastElement = node.chain[node.chain.length - 1];
    if (!asLValue && lastElement?.kind === "index" && !lastElement.optional) {
      return ts.call(ts.id("__nn"), [result]);
    }
    return result;
  }

  /** Emit an assignment/update *target*. A `valueAccess` target must stay a
   *  raw lvalue (never `__nn`-wrapped); anything else goes through the normal
   *  value path. Used by `++`/`--` and compound-assignment (`+=` etc.). */
  private processAssignTarget(node: Expression): TsNode {
    return node.type === "valueAccess"
      ? this.processValueAccess(node, true)
      : this.processNode(node);
  }

  private awaitChainCall(callExpr: TsNode, isLast: boolean): TsNode {
    return isLast
      ? ts.await(callExpr)
      : ts.raw(`(${this.str(ts.await(callExpr))})`);
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
      return ts.postfix(this.processAssignTarget(node.left), node.operator);
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
    // For a compound assignment (`x[i] += v`, `??=`, ...) the left operand is
    // also the assignment target, so it must stay a raw lvalue — never wrapped
    // in `__nn`. For every other binary operator the left is a plain value read
    // and follows the normal (terminal-index-normalizing) path.
    const leftNode =
      COMPOUND_ASSIGN_TO_BINARY[node.operator] !== undefined
        ? this.processAssignTarget(node.left)
        : this.processNode(node.left);
    const rightNode = this.processNode(node.right);
    // All equality operators use unified nullish equality via the `__eq`
    // runtime helper (null and undefined compare equal). There is no strict
    // escape hatch: `===`/`!==` are stylistic aliases that compile identically
    // to `==`/`!=`. See docs/dev/null-and-undefined.md.
    if (
      node.operator === "==" ||
      node.operator === "===" ||
      node.operator === "!=" ||
      node.operator === "!=="
    ) {
      const eq = ts.call(ts.id("__eq"), [leftNode, rightNode]);
      const negated = node.operator === "!=" || node.operator === "!==";
      return negated ? ts.not(eq) : eq;
    }
    return ts.binOp(leftNode, node.operator, rightNode, {
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
    if (
      node.call.type === "functionCall" &&
      node.call.functionName === "throw"
    ) {
      throw new Error(
        "Cannot use 'try' with 'throw' — throw always raises an error.",
      );
    }
    const callNode = this.processNode(node.call as AgencyNode);
    const args: TsNode[] = [ts.arrowFn([], callNode, { async: true })];
    const scope = this.scopes.current();
    if (scope.type === "function") {
      const opts: Record<string, TsNode> = {
        // Inside the function body's withAlsFrame wrap — strict
        // accessor so a missing frame throws cleanly instead of a
        // generic "Cannot read 'getResultCheckpoint' of undefined".
        checkpoint: ts.raw("getRuntimeContext().ctx.getResultCheckpoint()"),
        functionName: ts.str((scope as FunctionScope).functionName),
        args: ts.raw("__stack.args"),
      };
      // Thrown-path stamping: if the try'd callee is destructive and THROWS
      // (a JS extern that raises rather than returning a failure), the
      // failure __tryCall constructs must carry destructiveRan. A callee
      // that RETURNS a failure is passed through unchanged and stamped by
      // the caller-side outcome flip instead.
      if (
        node.call.type === "functionCall" &&
        this.compilationUnit.destructiveFunctions[node.call.functionName]
      ) {
        opts.destructiveRan = ts.bool(true);
      }
      args.push(ts.obj(opts));
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

    return ts.runnerIfElse({
      id,
      branches,
      elseBranch,
      matchId: node.matchExprId,
    });
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

    // MatchBlock.cases may also carry comment/newLine entries; keep only real
    // arms (type-narrowing filter, not a cast).
    const filteredCases = node.cases.filter(
      (c): c is MatchBlockCase => c.type === "matchBlockCase",
    );

    const branches: { condition: TsNode; body: TsNode[] }[] = [];
    let elseBranch: TsNode[] | undefined;
    let nextStartId = 0;

    for (const caseItem of filteredCases) {
      const body = this.processBodyAsParts(caseItem.body, nextStartId);
      nextStartId += body.length;
      if (caseItem.caseValue === "_") {
        elseBranch = body;
      } else {
        branches.push({
          condition: ts.binOp(
            expression,
            "===",
            this.processNode(caseItem.caseValue as AgencyNode),
          ),
          body,
        });
      }
    }

    return ts.runnerIfElse({
      id,
      branches,
      elseBranch,
      matchId: node.matchExprId,
    });
  }

  /** Lowered `return` inside a match arm used as an expression. Same
   *  halt+return shape as `processReturnStatement`, but the value is stored as
   *  the match result via `runner.exitMatch` and control unwinds to the owning
   *  ifElse rather than the enclosing function. Never produced by the parser —
   *  only by pattern lowering (Task 6). */
  /** A graph-node call is a control-flow transition, not a value, so it cannot
   *  be the result of a match/if arm. `processMatchYield` catches the common
   *  case where the arm value is yielded directly; but a single-expression arm
   *  whose value may interrupt is hoisted to a temp binding first (#430), which
   *  hides the call from that check — so `_processAssignmentInner` re-runs this
   *  guard on the marked binding. Shared here to keep one error message. */
  private assertMatchArmValueNotGraphNode(
    value: Expression | MessageThread | undefined,
  ): void {
    if (
      value?.type === "functionCall" &&
      this.names.isGraphNode(value.functionName)
    ) {
      throw new Error(
        "a match arm cannot return a graph node transition; a node call is " +
          "control flow, not a value — use if/else statements for node dispatch",
      );
    }
  }

  private processMatchYield(node: MatchYield): TsNode {
    // A graph-node call compiles to a goto/halt transition statement (see
    // generateNodeCallExpression), which is control flow — it cannot serve as
    // the value argument of `runner.exitMatch(id, <value>)`. Reject it with a
    // clear compile error rather than emitting invalid TypeScript.
    this.assertMatchArmValueNotGraphNode(node.value);
    const value = node.value
      ? this.processNode(node.value)
      : ts.id("null");
    // Plain-mode (handler) match expressions wrap their arms in an async IIFE
    // (see processMatchExpressionPlain): a yield is a real `return` out of that
    // IIFE, not the stepped `runner.exitMatch` unwind — so the handler never
    // sets the `_matchExit` flag that it has no `runner.ifElse` to clear.
    if (this.insidePlainMatchExpr) {
      return ts.return(value);
    }
    return ts.runnerExitMatch({ matchId: node.matchId, value });
  }

  /**
   * Plain-mode (handler body) routing for the two lowered shapes of a branching
   * construct: a match expression (literal arms → `matchBlock`, pattern arms →
   * `ifElse`, both carrying `matchExprId`) becomes a self-contained IIFE; a plain
   * statement match / if compiles as ordinary JS. Single source of truth so the
   * `matchBlock` and `ifElse` dispatch cases can't drift apart — a mismatch would
   * silently emit a statement match whose consumer reads an unassigned
   * `__matchval_N` as `undefined`.
   */
  private processPlainBranching(node: MatchBlock | IfElse): TsNode {
    return node.matchExprId !== undefined
      ? this.processMatchExpressionPlain(node)
      : this.processBlockPlain(node);
  }

  /**
   * Compile an expression-position `match` inside a handler body (plain mode).
   *
   * Stepped code unwinds a match arm's value via `runner.exitMatch` + the owning
   * `runner.ifElse` clearing `_matchExit`. A handler body compiles to plain JS
   * with no owning `runner.ifElse`, so that protocol would leak the flag and
   * silently skip the rest of the enclosing node. Instead we emit the arm
   * dispatch as an async IIFE whose arms `return` their value, and store the
   * result in the `__matchval_<id>` frame local the consumer reads:
   *
   *   __stack.locals.__matchval_<id> = await (async () => { <if-chain> })();
   *
   * `node` is either the pass-through `matchBlock` (literal arms) or the lowered
   * `ifElse` chain (pattern arms) — both carry `matchExprId`. `processBlockPlain`
   * builds the plain if/else for either; `insidePlainMatchExpr` makes the arms'
   * `matchYield` nodes emit real returns out of the IIFE.
   */
  private processMatchExpressionPlain(node: MatchBlock | IfElse): TsNode {
    const matchId = node.matchExprId!;
    const prev = this.insidePlainMatchExpr;
    this.insidePlainMatchExpr = true;
    let ifChain: TsNode;
    try {
      ifChain = this.processBlockPlain(node);
    } finally {
      // Restore in a finally so an emission error inside an arm can't leak the
      // flag and turn a later sibling `matchYield` into a bare `return`.
      this.insidePlainMatchExpr = prev;
    }
    return ts.assign(
      ts.scopedVar(matchValName(matchId), "local", this.moduleId),
      ts.await(ts.iife({ async: true, body: [ifChain] })),
    );
  }

  private processImportStatement(node: ImportStatement): TsNode {
    const from = toCompiledImportPath(
      node.modulePath,
      this.outputFile ?? path.resolve(this.moduleId),
    );
    const aliasesFull = this.scopes.visibleTypeAliasesFull();
    // Non-validated value-only-parameterized aliases (e.g. `type
    // OneOf(choices) = string` with only `@jsonSchema`) emit nothing at their
    // declaration site (see processTypeAlias) because every use-site inlines a
    // fresh schema. Importing such a name from the compiled target module
    // would fail with "does not provide an export" and registering it as a
    // tool would reference an undefined local — so filter them out.
    //
    // A VALIDATED value-param alias now compiles to (and exports) a descriptor
    // factory, so it IS importable; only the non-validated ones are filtered.
    const isInlinedAlias = (name: string): boolean => {
      const entry = aliasesFull[name];
      if (!entry?.valueParams || entry.valueParams.length === 0) return false;
      if (entry.typeParams && entry.typeParams.length > 0) return false;
      return !hasAliasValidate(entry, aliasesFull);
    };
    const imports = node.importedNames.map((nameType) => {
      switch (nameType.type) {
        case "namedImport": {
          const keptNames = nameType.importedNames.filter(
            (name) => !isInlinedAlias(name),
          );
          if (keptNames.length === 0) return ts.empty();
          return ts.importDecl({
            importKind: "named",
            names: keptNames.map((name) => {
              const alias = nameType.aliases[name];
              return alias ? { name, alias } : name;
            }),
            from,
          });
        }
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
    const importNode =
      imports.length === 1 ? imports[0] : ts.statements(imports);

    // Auto-register any AgencyFunction instances imported from .agency files.
    if (node.isAgencyImport) {
      for (const nameType of node.importedNames) {
        switch (nameType.type) {
          case "namedImport":
            for (const name of nameType.importedNames) {
              if (isInlinedAlias(name)) continue;
              const vpEntry = aliasesFull[name];
              // A value-param alias imports as a descriptor factory, not an
              // AgencyFunction — never register it as an LLM tool.
              if (vpEntry?.valueParams && vpEntry.valueParams.length > 0) {
                continue;
              }
              const localName = nameType.aliases[name] ?? name;
              this.toolRegistrations.push(
                ts.raw(`__registerTool(${localName});`),
              );
            }
            break;
          case "namespaceImport": {
            const ns = nameType.importedNames;
            this.toolRegistrations.push(
              ts.raw(
                `for (const [__k, __v] of Object.entries(${ns})) { __registerTool(__v, __k); }`,
              ),
            );
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
  private processBlockArgument(
    node: Pick<FunctionCall, "block"> & { functionName?: string },
  ): TsNode {
    const block = node.block!;
    const fnDef = node.functionName
      ? this.compilationUnit.functionDefinitions[node.functionName]
      : undefined;
    const imported = node.functionName
      ? this.compilationUnit.importedFunctions[node.functionName]
      : undefined;
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
    // The stamped yield (annotated guards, #580) rides along; the other
    // two block push sites (processBlockAsExpression, the fork
    // lowering) never carry a guard's block argument and stay bare.
    this.scopes.push({
      type: "block",
      blockName,
      declaredYieldType: block.declaredYieldType,
    });
    this._sourceMapBuilder.enterScope(this.moduleId, blockName);
    const compiledFinalize = this.finalize.compileScope({
      body: block.body,
      scopeName: blockName,
      errorVar: "__blockError",
      compileBodyRest: (rest) => this.processBodyAsParts(rest),
    });
    this._sourceMapBuilder.enterScope(this.moduleId, parentScopeName);
    this.scopes.pop();

    const bodyStr = compiledFinalize.bodyCode
      .map((n) => printTs(n, 1))
      .join("\n");

    const blockSetupCode = renderBlockSetup.default({
      params: block.params.map((p) => ({
        paramName: p.name,
        paramNameQuoted: JSON.stringify(p.name),
      })),
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(blockName),
      frameVar: `__bframe_${blockName}`,
      body: bodyStr,
      finalizeDecl: compiledFinalize.declText,
      abortReturn: compiledFinalize.abortReturn,
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
    const compiledFinalize = this.finalize.compileScope({
      body: block.body,
      scopeName: blockName,
      errorVar: "__blockError",
      compileBodyRest: (rest) => this.processBodyAsParts(rest),
    });
    this._sourceMapBuilder.enterScope(this.moduleId, parentScopeName);
    this.scopes.pop();

    const bodyStr = compiledFinalize.bodyCode
      .map((n) => printTs(n, 1))
      .join("\n");

    const blockSetupCode = renderBlockSetup.default({
      params: block.params.map((p) => ({
        paramName: p.name,
        paramNameQuoted: JSON.stringify(p.name),
      })),
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(blockName),
      frameVar: `__bframe_${blockName}`,
      body: bodyStr,
      finalizeDecl: compiledFinalize.declText,
      abortReturn: compiledFinalize.abortReturn,
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
   * Classify a parameter's contribution to a tool's JSON schema.
   *
   * Single source of truth for "what does this param contribute?" — consumed
   * by `buildToolDefinition` (and only by it). Three outcomes:
   *
   *   - `drop`   : function-typed, function-union, or variadic-of-function.
   *                Omitted from the schema entirely. The required-vs-optional
   *                distinction is enforced separately by the tool-binding
   *                validator (lib/typeChecker/toolBlockBinding.ts).
   *   - `scalar` : a regular field — type derived from the declared hint
   *                (`string` is the historical default for untyped params).
   *                Optional params get `.nullable().describe("Default: ...")`
   *                appended so the LLM understands the value can be omitted.
   *   - `array`  : a variadic param whose element type is non-function. The
   *                emitted schema is `z.array(<element>)` so the LLM supplies
   *                the whole spread as a single array via the named-array
   *                calling convention (`foo(rest: [1,2,3])`).
   */
  private paramSchemaContribution(
    param: FunctionParameter,
    pendingAliases: Set<string>,
  ):
    | { kind: "drop" }
    | { kind: "scalar"; zod: string }
    | { kind: "array"; zod: string } {
    if (isFunctionTyped(param)) return { kind: "drop" };

    if (param.variadic) {
      // For `...xs: T[]`, the typeHint is the array type already; for the
      // untyped fallback `...xs`, fall back to `string[]` to match the
      // historical default for untyped non-variadic params below.
      const elementHint =
        param.typeHint?.type === "arrayType"
          ? param.typeHint.elementType
          : (param.typeHint ?? {
              type: "primitiveType" as const,
              value: "string",
            });
      const elementZod = this.zodSchemaFor(elementHint, pendingAliases);
      return { kind: "array", zod: `z.array(${elementZod})` };
    }

    const typeHint = param.typeHint || {
      type: "primitiveType" as const,
      value: "string",
    };
    let zod = this.zodSchemaFor(typeHint, pendingAliases);
    if (param.defaultValue) {
      const defaultStr = expressionToString(param.defaultValue);
      // A widened optional param (`x?: T` → `T | null`) is already nullable;
      // only add `.nullable()` for params whose type is not already nullable
      // (e.g. an explicit default `x: T = 5`), so the LLM may omit them.
      const alreadyNullable =
        typeHint.type === "unionType" &&
        typeHint.types.some(
          (t) => t.type === "primitiveType" && t.value === "null",
        );
      if (!alreadyNullable) zod += ".nullable()";
      zod += `.describe(${JSON.stringify("Default: " + defaultStr)})`;
    }
    return { kind: "scalar", zod };
  }

  /**
   * Build a tool definition TsNode for an Agency function.
   * Returns ts.id("null") if the function has no parameters (no schema needed for tools).
   *
   * Every "should this param appear in the schema?" decision is funneled
   * through `paramSchemaContribution` — the single classifier that knows
   * which params are dropped (function-typed, function-union, variadic of
   * function), which become scalar, and which become array (variadic).
   * No ad-hoc filter or inline predicate is allowed in this function; the
   * spec's discipline rule (§4.6 rule #3) is enforced by code review.
   */
  private buildToolDefinition(node: FunctionDefinition): TsNode {
    const { functionName, parameters } = node;
    if (
      this.compilationUnit.graphNodes
        .map((n) => n.nodeName)
        .includes(functionName)
    ) {
      throw new Error(
        `There is already a node named '${functionName}'. Functions can't have the same name as an existing node.`,
      );
    }

    // Tool definitions initialize at module load (the __AgencyFunction
    // const), so alias refs in param schemas need the same pending
    // treatment alias consts get — a def declared BEFORE a type it
    // references used to TDZ-crash (probe-confirmed).
    const pendingAliases = this.pendingAliasesFor(node.loc?.start);
    const contributions = parameters.map((p) => ({
      param: p,
      contribution: this.paramSchemaContribution(p, pendingAliases),
    }));

    // Declaration order is preserved by iterating `parameters` directly;
    // `properties` is an in-order map of name → zod expression source.
    const properties: Record<string, string> = {};
    for (const { param, contribution } of contributions) {
      if (contribution.kind === "drop") continue;
      properties[param.name] = contribution.zod;
    }

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
          ? // Flip `topLevel` on every TsScopedVar so the pretty-printer
            // reads through `__globalCtx` instead of the strict ALS
            // accessor — this subtree is eagerly evaluated at module
            // load when no ALS frame is installed.
            markTopLevelScopedVars(
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
      if (fn.docString?.segments.some((s) => s.type === "interpolation")) {
        return true;
      }
    }
    for (const node of this.compilationUnit.graphNodes) {
      if (node.docString?.segments.some((s) => s.type === "interpolation")) {
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
      stmts.push(
        ts.raw(
          renderBuiltinToolRegistration.default({
            toolName,
            toolNameQuoted: JSON.stringify(toolName),
            moduleIdQuoted: JSON.stringify(this.moduleId),
            internalName,
          }),
        ),
      );
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
    // moduleId/scopeName used to be threaded into the result-entry
    // `createPinned` call. That call is now skipped (see template); the
    // template only consumes `paramsStr` for the arg-override block.
    void functionName;
    const str = renderResultCheckpointSetup.default({
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
    inDestructiveFunction?: boolean;
    /** The def's compiled finalize (FinalizeCodegen.compileScope). The
     *  closure declaration goes in the setup so the catch (and the
     *  post-call guards inside the body) can call it; the abort return
     *  goes in the catch template. */
    finalize: CompiledScopeFinalize;
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
      ts.constDecl("__setupData", $(ts.id("setupFunction")).call([]).done()),

      ts.setupEnv({
        stack: $(ts.id("__setupData")).prop("stack").done(),
        step: $(ts.id("__setupData")).prop("step").done(),
        self: $(ts.id("__setupData")).prop("self").done(),
        ctx: ts.raw("getRuntimeContext().ctx"),
      }),

      // Ensure this module's globals are initialized on the
      // current per-scope view. Runs BEFORE this function's own
      // `withAlsFrame` wrap, but the caller's ALS frame is still
      // active (every entry to a generated function body comes from
      // a Runner step body, runNode's top-level frame, or a fork
      // branch frame — all of which seed `globals`). Reading via
      // `__globals()!` means a branch checks its own clone — whose
      // `initializedModules` set was snapshotted at fork time — so
      // already-initialized modules skip init without touching the
      // canonical store.
      ts.if(
        ts.raw(`!__globals()!.isInitialized(${JSON.stringify(this.moduleId)})`),
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

    // __self.__destructiveRan init — see DestructiveTracking.init(). Read the
    // flag from opts (threaded from processFunctionDefinition): by the time this
    // runs the scope-manager flag has already been restored, so reading it here
    // would always see false.
    setupStmts.push(this.tracking.init(!!opts.inDestructiveFunction));

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
          ts.if(ts.not(ts.prop(vrId, "success")), ts.return(vrId)),
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
    const onFunctionStartHook: TsNode[] = skipHooks
      ? []
      : [
          ts.runnerHookStep({
            id: 0,
            body: [
              ts.callHook("onFunctionStart", {
                functionName: ts.str(functionName),
                args: ts.obj(argsObj),
                moduleId: ts.str(this.moduleId),
              }),
            ],
          }),
        ];
    if (opts.finalize.decl !== undefined) {
      setupStmts.push(opts.finalize.decl);
    }
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
            body: [...onFunctionStartHook, ...bodyCode],
          }),
          // if (runner.halted) { if (isFailure(runner.haltResult)) { <stamp>; }
          //   return runner.haltResult; }
          // The stamp expression comes from DestructiveTracking; the halt
          // check / return around it is general function-exit control flow.
          ts.if(
            ts.prop(ts.id("runner"), "halted"),
            ts.statements([
              ts.if(
                ts.call(ts.id("isFailure"), [
                  ts.prop(ts.id("runner"), "haltResult"),
                ]),
                ts.statements([this.tracking.exitStamp()]),
              ),
              ts.return(ts.prop(ts.id("runner"), "haltResult")),
            ]),
          ),
        ]),
        ts.raw(
          renderFunctionCatchFailure.default({
            functionName: JSON.stringify(functionName),
            abortReturn: opts.finalize.abortReturn,
          }),
        ),
        "__error",
        // finally block: pop state stack and conditionally fire onFunctionEnd.
        // The optional chain handles the rare case where the finally
        // runs outside any ALS frame (e.g. a function invoked as a tool
        // without an outer agencyStore.run wrap).
        ts.statements([
          ts.raw("__stateStack()?.pop()"),
          ...(skipHooks
            ? []
            : [
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

    const prevDestructive = this.scopes.inDestructiveFunction;
    this.scopes.inDestructiveFunction = !!node.markers?.destructive;
    // Hoist body-local type aliases to the function's outer scope so
    // every runner.step closure can reference the generated zod schemas.
    const hoistedAliases = this.hoistBodyTypeAliases(node.body);
    const compiledFinalize = this.finalize.compileScope({
      body: node.body,
      scopeName: functionName,
      errorVar: "__error",
      // Body steps occupy substep ids 1..N — id 0 is reserved for the
      // onFunctionStart hook (wrapped in `runner.hook` for substep-counter
      // idempotency on resume).
      compileBodyRest: (rest) => this.processBodyAsParts(rest, 1),
    });
    this.scopes.inDestructiveFunction = prevDestructive;
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
    const setupStmts = this.buildFunctionBody({
      functionName,
      parameters,
      bodyCode: compiledFinalize.bodyCode,
      skipHooks: false,
      hoistedAliases,
      inDestructiveFunction: !!node.markers?.destructive,
      finalize: compiledFinalize,
    });

    const funcDecl = ts.functionDecl(
      implName,
      fnParams,
      ts.statements(setupStmts),
      {
        async: true,
      },
    );

    // Build AgencyFunction.create() params metadata
    // Include all params (including block-typed) so .partial() can bind them by name.
    // Block-typed (and any function-typed) params are separately excluded
    // from the tool schema (buildToolDefinition); the `isFunctionTyped`
    // flag is forwarded so the runtime backstop (validateForLLM) can
    // re-check tool arrays it cannot see statically.
    const paramNodes = parameters.map((p) =>
      ts.obj({
        name: ts.str(p.name),
        hasDefault: ts.bool(!!p.defaultValue),
        defaultValue: ts.id("undefined"),
        variadic: ts.bool(!!p.variadic),
        isFunctionTyped: ts.bool(isFunctionTyped(p)),
        acceptsResult: ts.bool(paramAcceptsFailure(p)),
      }),
    );

    // Build tool definition (Zod schema)
    const toolDef = this.buildToolDefinition(node);

    const createProps: Record<string, TsNode> = {
      name: ts.str(functionName),
      module: ts.str(this.moduleId),
      fn: ts.id(implName),
      params: ts.arr(paramNodes),
      toolDefinition: toolDef,
      exported: ts.bool(!!node.exported),
    };
    // Carry the retry-safety markers so the tool loop and MCP adapter can
    // read them off the registered AgencyFunction. Emitted only when set.
    // "Destructive" for metadata purposes is DERIVED: the raw `destructive def`
    // marker OR the presence of a `destructive { }` region in the body. (The
    // entry flip / `inDestructiveFunction` still key on the raw marker alone —
    // see `:2266` — so a contains-region-only function does not commit at
    // entry.)
    const isDestructive =
      !!node.markers?.destructive ||
      functionContainsDestructiveBlock(node.body);
    if (isDestructive || node.markers?.idempotent) {
      const markerProps: Record<string, TsNode> = {};
      if (isDestructive) markerProps.destructive = ts.bool(true);
      if (node.markers?.idempotent) markerProps.idempotent = ts.bool(true);
      createProps.markers = ts.obj(markerProps);
    }
    const createCall = $.id("__AgencyFunction")
      .prop("create")
      .call([ts.obj(createProps), ts.id("__toolRegistry")])
      .done();

    const constDecl = ts.varDecl("const", functionName, createCall);
    // JS-export the callable wrapper unconditionally so cross-file imports
    // (including `import test`) link even when the function is not Agency-
    // `export`ed. Agency-level visibility is enforced at import resolution
    // (assertImportable) and in the docs generator; the `exported` metadata
    // on AgencyFunction.create above still records the true visibility.
    const exportedConst = ts.export(constDecl);

    return ts.statements([funcDecl, exportedConst]);
  }

  private processStatement(node: AgencyNode): TsNode {
    if (node.type === "functionCall") {
      return this.processFunctionCallAsStatement(node);
    }
    return this.processNode(node);
  }

  private interruptTemplateArgs(
    effect: string,
    message: string,
    data: string,
    origin: string,
  ) {
    return {
      effect: JSON.stringify(effect),
      message,
      data,
      origin: JSON.stringify(origin),
    };
  }

  private buildInterruptReturnStructured(
    effect: string,
    messageExpr: string,
    dataExpr: string,
  ): TsNode {
    const origin = moduleIdToOrigin(this.moduleId);
    const opts = this.checkpointOpts();
    return ts.raw(
      renderInterruptReturn.default({
        ...this.interruptTemplateArgs(effect, messageExpr, dataExpr, origin),
        nodeContext: this.scopes.current().type === "node",
        interruptIdKey: `__interruptId_${this.steps.joined("_")}`,
        ...opts,
      }),
    );
  }

  private extractInterruptFields(node: InterruptStatement): {
    effect: string;
    messageExpr: string;
    dataExpr: string;
  } {
    return {
      effect: node.effect,
      messageExpr:
        node.arguments && node.arguments.length > 0
          ? this.str(this.processCallArg(node.arguments[0]))
          : '""',
      dataExpr:
        node.arguments && node.arguments.length > 1
          ? this.str(this.processCallArg(node.arguments[1]))
          : "{}",
    };
  }

  private isInterruptExpression(node: AgencyNode): boolean {
    return node.type === "interruptStatement";
  }

  private processInterruptStatement(node: InterruptStatement): TsNode {
    const { effect, messageExpr, dataExpr } = this.extractInterruptFields(node);
    return this.buildInterruptReturnStructured(effect, messageExpr, dataExpr);
  }

  private processFunctionCallAsStatement(node: FunctionCall): TsNode {
    if (node.functionName === "_emit") {
      return this.processFunctionCall(node);
    }

    // `throw(...)` lowers to a `throw new Error(...)` *statement*, not
    // an expression. Skip the interrupt-result wrapper below — it
    // would try to assign the throw to `const __funcResult = ...`,
    // which esbuild rejects (`Unexpected "throw"`).
    if (node.functionName === "throw") {
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

      // Sync calls: bind the result to a temp and emit the shared interrupt
      // guard (assignmentInterruptGuard owns the handler-body-throw vs
      // halt dispatch and the node-vs-function halt shape). Handler-body
      // statements share one scope, so those get a unique temp name.
      const tempVar = this.insideHandlerBody
        ? `__funcResult_${this.handlerFuncResultCounter++}`
        : "__funcResult";
      const guard = this.assignmentInterruptGuard(ts.id(tempVar), {
        bindOnAborted: false,
      });
      return ts.statements([
        ts.constDecl(tempVar, callNode),
        ...(guard ? [guard] : []),
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
    return this.emitRuntimeDispatchCall(
      node,
      functionName,
      shouldAwait,
      options,
    );
  }

  private emitRuntimeDispatchCall(
    node: FunctionCall,
    functionName: string,
    shouldAwait: boolean,
    options?: { stateStack?: TsNode },
  ): TsNode {
    const descriptor = this.buildCallDescriptor(node);

    const calleeBlockFrameVar =
      node.scope === "block" || node.scope === "blockArgs"
        ? this.scopes.blockFrameVar(node.blockDepth ?? 0)
        : undefined;
    const callee = node.scope
      ? ts.scopedVar(
          functionName,
          node.scope,
          this.moduleId,
          calleeBlockFrameVar,
        )
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
  private buildCallDescriptor(
    node: Pick<FunctionCall, "arguments" | "block">,
  ): TsNode {
    const args = node.arguments;
    const hasNamedArgs = args.some((a) => a.type === "namedArgument");

    // A trailing block must always bind to the function's last
    // (block-typed) parameter, not be positionally appended after
    // omitted optional args. Emit a "named" descriptor so the
    // runtime's blockArg binding (resolveNamed) kicks in — otherwise
    // `f() as { ... }` would push the block at index 0 and bind it
    // to the first parameter.
    if (hasNamedArgs || node.block) {
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

    // No named args and no block on this call (the branch above handled
    // those), so every argument is positional. processResolvedArgs is the
    // one place that decides reference-vs-call for functionCall arguments;
    // this loop used to be a hand-copy of it and drifted (the fork/race
    // guard landed in one and not the other). The filter is a checked
    // narrowing of the branch invariant, not a cast - if a namedArgument
    // ever reached here it would be dropped by the predicate instead of
    // silently miscompiled as a positional value.
    const positionalArgs = args.filter(
      (arg): arg is Expression | SplatExpression =>
        arg.type !== "namedArgument",
    );
    const argNodes = this.processResolvedArgs(positionalArgs);

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

    // Pull off the `shared: true` named argument if present. Defaults
    // to false (each branch isolates its globals + active-thread
    // pointer). When the user writes `fork(items, shared: true)` or
    // `race(items, shared: true)` they opt back into pointer-sharing
    // — used for cooperative-worker patterns where branches really do
    // want to mutate the same global state. Any other named arg is a
    // user error and gets reported.
    let sharedNode: TsNode = ts.bool(false);
    const positionalArgs: typeof node.arguments = [];
    for (const arg of node.arguments) {
      if (arg.type === "namedArgument") {
        if (arg.name !== "shared") {
          throw new Error(
            `${node.functionName}(): unknown named argument '${arg.name}'. Only 'shared: true' is supported.`,
          );
        }
        sharedNode = this.processCallArg(arg);
      } else {
        positionalArgs.push(arg);
      }
    }

    const itemsNode =
      positionalArgs.length > 0
        ? this.processCallArg(positionalArgs[0])
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
      frameVar: `__bframe_${blockName}`,
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
        // Trailing `shared` boolean — defaults to false (isolated).
        // Forwarded as `RunBatchOpts.shareGlobals = shared`. Threads
        // stay branch-local regardless (concurrent push/pop on a
        // shared activeStack would corrupt the conversation).
        sharedNode,
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
      if (
        stmt.type === "functionCall" &&
        this.names.isGraphNode(stmt.functionName)
      ) {
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
          // All aborts — cancellations (Esc / abort) AND guard trips — are a
          // single AgencyAbort carrying an AbortCause and must propagate
          // untouched rather than be logged + converted to a Failure here.
          // One rung replaces the old GuardExceededError + isAbortError
          // ladder. Mirrors the function catch template.
          ts.if(
            ts.raw("__error instanceof AgencyAbort"),
            ts.statements([ts.throw("__error")]),
          ),
          // Surface the underlying exception via logger + statelog
          // before converting to a Failure. Mirrors the function catch
          // template; see the recordAlwaysScoped bug in
          // https://ampcode.com/threads/T-019e7a3a-edfa-74d6-917a-255c31bf8491.
          ts.raw(
            `{
              const __errMsg = __error instanceof Error ? __error.message : String(__error);
              const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
              const __log = __createLogger(__ctx.logLevel);
              __log.error(\`Node ${nodeName} crashed: \${__errMsg}\`);
              if (__errStack) __log.error(__errStack);
              __ctx.statelogClient?.error?.({
                errorType: "runtimeError",
                message: __errMsg,
                functionName: ${JSON.stringify(nodeName)},
              });
            }`,
          ),
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
      throw new Error(`goto can only be used inside a node body`);
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
      if (this.scopes.current().type === "block")
        return ts.runnerHalt(ts.id("undefined"));
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
      if (this.isFinalizeInterceptedReturn(node.value)) {
        return this.finalize.interceptedReturn(valueNode, (v) =>
          ts.runnerHalt(v),
        );
      }
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
          ts.nodeResult(
            this.maybeWrapReturnValidation(ts.self(DEFAULT_PROMPT_NAME)),
          ),
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
        ts.functionReturn(
          this.maybeWrapReturnValidation(ts.self(DEFAULT_PROMPT_NAME)),
        ),
      ]);
    }
    const valueNode = this.processNode(node.value);
    if (this.isFinalizeInterceptedReturn(node.value)) {
      return this.finalize.interceptedReturn(valueNode, (v) =>
        ts.functionReturn(this.maybeWrapReturnValidation(v)),
      );
    }
    return ts.functionReturn(this.maybeWrapReturnValidation(valueNode));
  }

  /** In a finalize-bearing scope, a direct-call return must stop at the
   *  finalize instead of passing an aborted result through (pass-through
   *  would silently skip the finalize). AG6036 guarantees a direct call
   *  is the only call-bearing return shape that reaches codegen here;
   *  `return llm(...)` hoists through its own path and cannot produce an
   *  AbortedResult. */
  private isFinalizeInterceptedReturn(value: AgencyNode): boolean {
    if (!this.finalize.isActive()) return false;
    return value.type === "functionCall" && value.functionName !== "llm";
  }

  private processAssignment(node: Assignment): TsNode {
    const result = this._processAssignmentInner(node);
    // If the type annotation has !, wrap the assigned value in __validateType
    // (or __validateChainRecursive if the type carries @validate tags).
    if (node.validated && node.typeHint) {
      const blockFrameVar =
        node.scope === "block" || node.scope === "blockArgs"
          ? this.scopes.blockFrameVar(node.blockDepth ?? 0)
          : undefined;
      const varRef = ts.scopedVar(
        node.variableName,
        node.scope!,
        this.moduleId,
        blockFrameVar,
      );
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

  /** True when an assignment RHS can evaluate to a bubbled Interrupt[]
   * without any halt check of its own: a tryExpression anywhere in a binOp
   * tree. `__tryCall` and `__catchResult` both forward a non-Result value
   * unchanged, and `||`/`??` pass a (truthy, non-null) array through — so
   * `try f()`, `try f() catch v`, and `try f() || x` all deliver the raw
   * batch to the assignment. Plain functionCall RHS is handled by its own
   * richer branch (async fork setup etc.), not this predicate. */
  private rhsMayBubbleInterrupts(value: AgencyNode): boolean {
    if (value.type === "tryExpression") return true;
    if (value.type === "binOpExpression") {
      return (
        this.rhsMayBubbleInterrupts(value.left as AgencyNode) ||
        this.rhsMayBubbleInterrupts(value.right as AgencyNode)
      );
    }
    return false;
  }

  /** The propagation guards emitted after a sync assignment whose RHS is
   * a call (or a `try` expression that may deliver a callee's raw
   * result). Two markers can come back instead of a normal value, and
   * both must stop this scope:
   *
   * - an Interrupt[] — the callee paused; halt so the batch propagates
   *   (awaitAll first), or throw inside a handler body, where interrupts
   *   are not allowed.
   * - an AbortedResult — the callee was aborted; this scope stops too and
   *   returns ITS OWN saved draft via carryThrough (the callee's partial
   *   is dropped: salvage is opt-in per level). Nodes and handler bodies
   *   rebuild the exception instead, so everything above compiled code
   *   (the graph engine, the CLI entry) sees aborts exactly as before.
   *
   * Returns null only at global scope for the interrupt half; the aborted
   * check still applies there (an abort during module init should crash
   * init, not become data in a global). */
  private assignmentInterruptGuard(
    varRef: TsNode,
    opts?: { bindOnAborted?: boolean },
  ): TsNode | null {
    const abortedGuard = this.assignmentAbortedGuard(varRef, {
      bindOnAborted: opts?.bindOnAborted !== false,
    });
    if (this.scopes.current().type === "global") return abortedGuard;
    if (this.insideHandlerBody) {
      return ts.statements([
        ts.if(
          this.interruptCheckRaw(this.str(varRef)),
          ts.throw(
            `new Error("Cannot throw an interrupt inside a handler body")`,
          ),
        ),
        abortedGuard,
      ]);
    }
    // Sync: interrupt check with awaitAll before halt.
    // In function context, halt with the interrupt array directly so
    // the caller's hasInterrupts check can detect it.
    const haltValue =
      this.scopes.current().type === "node"
        ? ts.obj([ts.setSpread(ts.runtime.state), ts.set("data", varRef)])
        : varRef;
    return ts.statements([
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
      abortedGuard,
    ]);
  }

  /** The aborted-result half of the post-call guard. Function and block
   * scopes halt with their own AbortedResult (carryThrough applies the
   * salvage rule); handler bodies and every other scope rebuild the
   * exception — handlers run outside the runner-step machinery (there is
   * no runner to halt), and nothing above compiled code consumes aborted
   * values.
   *
   * In a finalize-bearing scope, the stop runs the finalize — and when
   * the guarded value is a real local (`bindOnAborted`), the callee's
   * partial is first bound into it via partialValueOrNull(), so the
   * finalize reads it like any other local. Bare-call temps have nothing
   * to bind. */
  private assignmentAbortedGuard(
    varRef: TsNode,
    opts?: { bindOnAborted?: boolean },
  ): TsNode {
    const scopeType = this.scopes.current().type;
    const expr = this.str(varRef);
    if (
      !this.insideHandlerBody &&
      (scopeType === "function" || scopeType === "block")
    ) {
      const frameVar = scopeType === "block" ? "__bstack" : "__stack";
      const scopeName = JSON.stringify(this.scopes.currentName());
      if (this.finalize.isActive()) {
        const bind =
          opts?.bindOnAborted === true
            ? [ts.raw(`${expr} = __abortedCallee.partialValueOrNull()`)]
            : [];
        return ts.if(
          ts.raw(`isAborted(${expr})`),
          ts.statements([
            ts.raw(`const __abortedCallee = ${expr}`),
            ...bind,
            ...this.finalize.stopScope("__abortedCallee"),
          ]),
        );
      }
      return ts.if(
        ts.raw(`isAborted(${expr})`),
        ts.statements([
          ts.raw(
            `runner.halt(${expr}.carryThrough(${frameVar}, ${scopeName}))`,
          ),
          ts.return(),
        ]),
      );
    }
    return ts.if(
      ts.raw(`isAborted(${expr})`),
      ts.raw(`throw ${expr}.toError()`),
    );
  }

  private _processAssignmentInner(node: Assignment): TsNode {
    const { variableName, typeHint, value } = node;

    // A single-expression match/if arm whose value may interrupt is lowered to
    // this temp binding so the call sits at statement position (#430). The node
    // call is now hidden from `processMatchYield`'s guard, so re-apply it here.
    if (node.matchArmValueTemp) {
      this.assertMatchArmValueNotGraphNode(value);
    }

    if (value.type === "functionCall" && value.functionName === "llm") {
      return this.processLlmCall(variableName, typeHint, value, node.scope!);
    } else if (this.isInterruptExpression(value)) {
      const { effect, messageExpr, dataExpr } = this.extractInterruptFields(
        value as InterruptStatement,
      );
      const origin = moduleIdToOrigin(this.moduleId);
      const makeAssign = (val: string) =>
        this.str(
          this.assigns.scopedAssign(
            node.scope!,
            variableName,
            ts.raw(val),
            node.accessChain,
            node.blockDepth ?? 0,
          ),
        );
      const opts = this.checkpointOpts();
      return ts.raw(
        renderInterruptAssignment.default({
          assignResolve: makeAssign("__response.value"),
          assignApprove: makeAssign("true"),
          handlerApprove: makeAssign("__handlerResult.value"),
          ...this.interruptTemplateArgs(effect, messageExpr, dataExpr, origin),
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
        node.blockDepth ?? 0,
      );
      const stmts: TsNode[] = [
        this.assigns.scopedAssign(
          node.scope!,
          variableName,
          this.processNode(value),
          node.accessChain,
          node.blockDepth ?? 0,
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
            node.blockDepth ?? 0,
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
      } else {
        const guard = this.assignmentInterruptGuard(varRef);
        if (guard) stmts.push(guard);
      }
      return ts.statements(stmts);
    } else if (this.rhsMayBubbleInterrupts(value)) {
      // `try` catches FAILURES, not interrupts — an Interrupt[] bubbling out
      // of the callee passes through __tryCall (and __catchResult, and `||`)
      // untouched and must halt this scope exactly like a plain
      // function-call assignment. Without this guard the raw interrupt
      // array is assigned to the variable (isSuccess and isFailure both
      // false) and the paused state is stranded. The predicate walks binOp
      // trees so `try f() catch v` and `try f() || x` are covered, not just
      // a bare top-level tryExpression.
      const varRef = this.assigns.lhs(
        node.scope!,
        variableName,
        node.accessChain,
        node.blockDepth ?? 0,
      );
      const stmts: TsNode[] = [
        this.assigns.scopedAssign(
          node.scope!,
          variableName,
          this.processNode(value),
          node.accessChain,
          node.blockDepth ?? 0,
        ),
      ];
      const guard = this.assignmentInterruptGuard(varRef);
      if (guard) stmts.push(guard);
      return ts.statements(stmts);
    } else if (value.type === "messageThread") {
      return this.processMessageThread(value, node);
    } else {
      return this.assigns.scopedAssign(
        node.scope!,
        variableName,
        this.processNode(value),
        node.accessChain,
        node.blockDepth ?? 0,
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

    // Everything after the prompt becomes the clientConfig, passed straight
    // through to runPrompt. Tools (AgencyFunction instances, MCP tools) live
    // in config.tools and are handled entirely by runPrompt at runtime.
    const argsAfterPrompt = node.arguments.slice(1);
    const hasNamedOptions = argsAfterPrompt.some(
      (a) => a.type === "namedArgument",
    );
    let clientConfig: TsNode;
    if (!hasNamedOptions) {
      // Back-compat: a lone positional options object (or nothing) passes
      // through unchanged, keeping generated output byte-identical.
      const configArg = argsAfterPrompt[0];
      clientConfig = configArg ? this.processCallArg(configArg) : ts.obj({});
    } else {
      // Named option args (`llm(prompt, model: "x", tools: [t])`) fold into a
      // single object; a positional options object, if also present, is
      // spread in first so named args win on conflict.
      const configEntries: TsObjectEntry[] = [];
      for (const arg of argsAfterPrompt) {
        if (arg.type === "namedArgument") {
          const keyCode = arg.name.replace(/"/g, '\\"');
          configEntries.push(
            ts.set(`"${keyCode}"`, this.processNode(arg.value)),
          );
        } else if (arg.type === "splat") {
          // `processCallArg` already lowers a splat to a spread node; spread
          // the underlying expression once to avoid emitting `......expr`.
          configEntries.push(ts.setSpread(this.processNode(arg.value)));
        } else {
          configEntries.push(ts.setSpread(this.processCallArg(arg)));
        }
      }
      clientConfig = ts.obj(configEntries);
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
    // Partials ergonomics (spec Part 2): thread the enclosing def's
    // declared return type so a saveDraft tool in this call's tools
    // array gets an honest value schema. Emitted only when the call has
    // arguments beyond the prompt — a bare llm("...") can never carry
    // tools, and skipping it keeps those call sites byte-identical.
    // An `any` return is skipped at the TYPE level (isAnyType), so the
    // runtime falls back to the string schema.
    if (argsAfterPrompt.length > 0) {
      const declaredReturn = this.scopes.enclosingDeclaredReturnType();
      if (declaredReturn !== undefined && !isAnyType(declaredReturn)) {
        runPromptEntries.draftSchema = ts.raw(this.zodSchemaFor(declaredReturn));
      }
    }
    runPromptEntries.maxToolCallRounds = ts.num(
      this.agencyConfig.maxToolCallRounds || 10,
    );
    runPromptEntries.removedTools = ts.self("__removedTools");
    // Decision 8: hand runPrompt this function's own locals object so a
    // destructive tool executed inside the call marks OUR `__destructiveRan`,
    // which our exit stamp reads. By-reference, exactly like `removedTools`.
    runPromptEntries.destructiveSink = ts.runtime.self;
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
            ts.throw(
              `new Error("Cannot throw an interrupt inside a handler body")`,
            ),
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

  // TODO(follow-up): `thread {}` should desugar into a call to a stdlib
  // `__internal_thread(opts, block)` function so future named args don't
  // require parser+IR+codegen+runtime edits in five files. See
  // `docs/superpowers/specs/2026-05-30-thread-as-agency-function.md`.
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
          assignTo.blockDepth ?? 0,
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
      // Match compiles to if/else chain. Cases may also carry comment/newLine
      // entries; keep only real arms (type-narrowing filter, not a cast).
      const expression = this.processNode(node.expression);
      const filteredCases = node.cases.filter(
        (c): c is MatchBlockCase => c.type === "matchBlockCase",
      );
      let result: TsNode | undefined;
      let elseBody: TsNode | undefined;
      for (const caseItem of filteredCases) {
        if (caseItem.caseValue === "_") {
          elseBody = processBody(caseItem.body);
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
        body: processBody(c.body),
      }));
      return ts.if(
        ts.binOp(
          expression,
          "===",
          this.processNode(nonDefault[0].caseValue as AgencyNode),
        ),
        processBody(nonDefault[0].body),
        { elseIfs, elseBody },
      );
    }
    return this.processPlainForLoop(node);
  }

  /**
   * Emit a plain-JS for-loop (used inside handler bodies) that iterates arrays
   * by (element, index) and records/plain objects by (key, value) — the same
   * array-vs-record normalization `Runner.loop` applies in stepped mode. The
   * old emission looped `i < iterable.length` over `iterable[i]`, which over a
   * record iterated zero times (`.length` is undefined) and made `for (k in
   * record)` a `for...of` over a non-iterable object (a TypeError). All three
   * for-loop implementations (this, `Runner.loop`, the type checker) now agree.
   *
   *   const __src = <iterable>;
   *   const __isArr = Array.isArray(__src);
   *   const __keys = __isArr ? __src
   *     : (__src != null && typeof __src === "object" ? Object.keys(__src) : []);
   *   for (let __i = 0; __i < __keys.length; __i++) {
   *     const <item>   = __keys[__i];                        // element | key
   *     const <second> = __isArr ? __i : __src[__keys[__i]]; // index   | value
   *     ...body
   *   }
   */
  private processPlainForLoop(node: ForLoop): TsNode {
    const n = this.plainForLoopCounter++;
    const src = `__forsrc_${n}`;
    const isArr = `__forisarr_${n}`;
    const keys = `__forkeys_${n}`;
    const i = `__fori_${n}`;

    const loopBody: TsNode[] = [
      ts.constDecl(node.itemVar as string, ts.index(ts.id(keys), ts.id(i))),
    ];
    if (node.indexVar) {
      loopBody.push(
        ts.constDecl(
          node.indexVar,
          ts.raw(`${isArr} ? ${i} : ${src}[${keys}[${i}]]`),
        ),
      );
    }
    for (const s of node.body) loopBody.push(this.processNode(s));

    return ts.statements([
      ts.constDecl(src, this.processNode(node.iterable)),
      ts.constDecl(isArr, ts.raw(`Array.isArray(${src})`)),
      ts.constDecl(
        keys,
        ts.raw(
          `${isArr} ? ${src} : (${src} != null && typeof ${src} === "object" ? Object.keys(${src}) : [])`,
        ),
      ),
      ts.forC(
        ts.letDecl(i, ts.num(0)),
        ts.binOp(ts.id(i), "<", ts.prop(ts.id(keys), "length")),
        ts.postfix(ts.id(i), "++"),
        ts.statements(loopBody),
      ),
    ]);
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
    const params =
      destructured.length > 0 ? `{ ${destructured}, ...__r }` : `{ ...__r }`;
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

  private buildHandlerArrow(
    handlerName: string,
    handlerScope?: ScopeType,
    handlerBlockDepth?: number,
  ): TsNode {
    if (this.names.isDirectCallFunction(handlerName)) {
      // Built-in handler (approve/reject/propagate): call with no args
      return ts.arrowFn(
        [{ name: "__data", typeAnnotation: "any" }],
        ts.call(ts.id(handlerName), []),
        { async: true },
      );
    }

    const args = [ts.id("__data")];

    // User-defined function handler: use __call. Resolve the callee
    // through scopedVar when scope info is available so locals
    // (`__stack.locals.NAME`), globals, statics, etc. are dereferenced
    // correctly instead of being emitted as bare JS identifiers.
    const descriptor = ts.obj({
      type: ts.str("positional"),
      args: ts.arr(args),
    });
    const configObj = this.buildStateConfig();
    const handlerBlockFrameVar =
      handlerScope === "block" || handlerScope === "blockArgs"
        ? this.scopes.blockFrameVar(handlerBlockDepth ?? 0)
        : undefined;
    const callee = handlerScope
      ? ts.scopedVar(
          handlerName,
          handlerScope,
          this.moduleId,
          handlerBlockFrameVar,
        )
      : ts.id(handlerName);
    const callArgs: TsNode[] = [callee, descriptor];
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
      handler = this.buildHandlerArrow(
        node.handler.functionName,
        node.handler.scope,
        node.handler.blockDepth,
      );
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

  private processBodyAsParts(body: AgencyNode[], startId = 0): TsNode[] {
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
      // Destructive-execution tracking: the pre-flip runs before the
      // statement, the post-flip after. See DestructiveTracking.statementFlips.
      const { pre, post } = this.tracking.statementFlips(
        stmt,
        this.scopes.inDestructiveFunction,
      );
      if (pre) {
        if (!currentPart) currentPart = [];
        currentPart.push(pre);
      }
      const processed = this.processStatement(stmt);
      if (COMPOUND_RUNNER_KINDS.has(processed.kind)) {
        result.push(processed);
      } else {
        if (!currentPart) currentPart = [];
        currentPart.push(processed);
      }
      if (post) {
        if (!currentPart) currentPart = [];
        currentPart.push(post);
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

  /** Build the baked `smoltalkDefaults` object: nested per-provider `apiKey`
   *  and `baseUrl` maps (each key/URL falling back to its conventional env
   *  var), plus model/logLevel/statelog and an optional default provider.
   *  `ollama` is intentionally omitted from `apiKey` — it uses OLLAMA_HOST. */
  private buildSmoltalkDefaults(cfg: AgencyConfig): TsNode {
    // Base URLs: litellm/openai-compat take an env fallback (they require an
    // explicit URL); openRouter/deepInfra have baked defaults in smoltalk, so
    // only emit them when overridden in agency.json.
    const baseUrlFields: Record<string, TsNode> = {
      liteLlm: cfg.client?.baseUrl?.liteLlm
        ? ts.str(cfg.client.baseUrl.liteLlm)
        : ts.binOp(ts.env("LITELLM_BASE_URL"), "||", ts.str("")),
      openAiCompat: cfg.client?.baseUrl?.openAiCompat
        ? ts.str(cfg.client.baseUrl.openAiCompat)
        : ts.binOp(ts.env("OPENAI_COMPAT_BASE_URL"), "||", ts.str("")),
    };
    if (cfg.client?.baseUrl?.openRouter) {
      baseUrlFields.openRouter = ts.str(cfg.client.baseUrl.openRouter);
    }
    if (cfg.client?.baseUrl?.deepInfra) {
      baseUrlFields.deepInfra = ts.str(cfg.client.baseUrl.deepInfra);
    }

    const smoltalkFields: Record<string, TsNode> = {
      // API keys are nested under `apiKey`, each falling back to its
      // conventional env var. `ollama` is intentionally omitted — it uses
      // OLLAMA_HOST (not an API key).
      apiKey: ts.obj({
        openAi: cfg.client?.apiKey?.openAi
          ? ts.str(cfg.client.apiKey.openAi)
          : ts.binOp(ts.env("OPENAI_API_KEY"), "||", ts.str("")),
        google: cfg.client?.apiKey?.google
          ? ts.str(cfg.client.apiKey.google)
          : ts.binOp(ts.env("GEMINI_API_KEY"), "||", ts.str("")),
        anthropic: cfg.client?.apiKey?.anthropic
          ? ts.str(cfg.client.apiKey.anthropic)
          : ts.binOp(ts.env("ANTHROPIC_API_KEY"), "||", ts.str("")),
        openRouter: cfg.client?.apiKey?.openRouter
          ? ts.str(cfg.client.apiKey.openRouter)
          : ts.binOp(ts.env("OPENROUTER_API_KEY"), "||", ts.str("")),
        deepInfra: cfg.client?.apiKey?.deepInfra
          ? ts.str(cfg.client.apiKey.deepInfra)
          : ts.binOp(ts.env("DEEPINFRA_API_KEY"), "||", ts.str("")),
        liteLlm: cfg.client?.apiKey?.liteLlm
          ? ts.str(cfg.client.apiKey.liteLlm)
          : ts.binOp(ts.env("LITELLM_API_KEY"), "||", ts.str("")),
        openAiCompat: cfg.client?.apiKey?.openAiCompat
          ? ts.str(cfg.client.apiKey.openAiCompat)
          : ts.binOp(ts.env("OPENAI_COMPAT_API_KEY"), "||", ts.str("")),
      }),
      baseUrl: ts.obj(baseUrlFields),
      model: ts.str(cfg.client?.defaultModel || "gpt-4o-mini"),
      logLevel: ts.str(cfg.client?.logLevel || "warn"),
      statelog: ts.obj({
        host: ts.str(cfg.client?.statelog?.host || ""),
        projectId: ts.str(cfg.client?.statelog?.projectId || ""),
        apiKey: ts.binOp(ts.env("STATELOG_SMOLTALK_API_KEY"), "||", ts.str("")),
        traceId: $(ts.id("nanoid")).call().done(),
      }),
    };
    // Emit a default provider only when configured — otherwise leave it unset
    // so smoltalk's normal model→provider registry lookup still applies.
    if (cfg.client?.defaultProvider) {
      smoltalkFields.provider = ts.str(cfg.client.defaultProvider);
    }
    return ts.obj(smoltalkFields);
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

    const smoltalkDefaults = this.buildSmoltalkDefaults(cfg);

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
    if (this.agencyConfig.maxCallDepth !== undefined) {
      runtimeCtxArgs.maxCallDepth = ts.raw(
        String(this.agencyConfig.maxCallDepth),
      );
    }
    if (this.agencyConfig.failurePropagation !== undefined) {
      runtimeCtxArgs.failurePropagation = ts.str(
        this.agencyConfig.failurePropagation,
      );
    }
    if (cfg.client?.maxToolResultChars !== undefined) {
      runtimeCtxArgs.maxToolResultChars = ts.raw(
        String(cfg.client.maxToolResultChars),
      );
    }
    if (cfg.client?.providerModules && cfg.client.providerModules.length > 0) {
      runtimeCtxArgs.providerModules = ts.arr(
        cfg.client.providerModules.map((p) => ts.str(p)),
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
      runtimeCtxStatements.push(ts.raw(`__initializeGlobals(__globalCtx);`));
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
          const typeHint = arg.typeHint
            ? formatTypeHintTs(arg.typeHint)
            : "any";
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
                  moduleDir: ts.id("__dirname"),
                }),
              ])
              .done(),
          ),
          {
            async: true,
            export: true,
            returnType: "Promise<RunNodeResult<any>>",
          },
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

    if (
      this.compilationUnit.graphNodes.map((n) => n.nodeName).includes("main")
    ) {
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
              ts.varDecl(
                "const",
                "__result",
                ts.await(ts.call(ts.id("main"), [ts.id("initialState")])),
              ),
              // Running `main` directly from the CLI: interrupts that no
              // handler settled have surfaced to the user. resolveCliInterrupts
              // is that user endpoint — under a run policy it decides each one
              // (prompting with --interactive, rejecting otherwise) and resumes
              // via respondToInterrupts; without a policy it reports the
              // unhandled interrupt and exits non-zero. Skipped when imported
              // from TS (guard above is false), where the caller handles
              // interrupts itself.
              ts.await(
                ts.call(ts.id("resolveCliInterrupts"), [
                  ts.id("__result"),
                  ts.id("respondToInterrupts"),
                ]),
              ),
            ]),
            ts.statements([
              // A root budget trip (--max-cost/--max-time) exits 3 with a
              // user-facing overrun message and never returns; every other
              // error falls through to the crash path below. User guard()
              // trips never reach here — _runGuarded converts them to
              // Results at their boundary.
              ts.call(ts.id("reportBudgetExceededAndExit"), [ts.id("__error")]),
              ts.consoleError(
                ts.template([
                  {
                    // Real newline char: template part text is raw runtime
                    // characters; the printer escapes, not the caller.
                    text: "\nAgent crashed: ",
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
