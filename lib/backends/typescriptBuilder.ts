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
  Scope,
  ScopeType,
  SplatExpression,
  TypeAlias,
  VariableType,
} from "../types.js";

import { formatTypeHint } from "@/cli/util.js";
import {
  BUILTIN_FUNCTIONS,
  BUILTIN_TOOLS,
  BUILTIN_VARIABLES,
  TYPES_THAT_DONT_TRIGGER_NEW_PART,
} from "@/config.js";
import type { SourceLocationOpts } from "@/runtime/state/checkpointStore.js";
import { DebuggerStatement } from "@/types/debuggerStatement.js";
import { Sentinel } from "@/types/sentinel.js";
import { SpecialVar } from "@/types/specialVar.js";
import { expressionToString } from "@/utils/node.js";
import { toCompiledImportPath } from "../importPaths.js";
import * as renderDebugger from "../templates/backends/typescriptGenerator/debugger.js";
import * as renderImports from "../templates/backends/typescriptGenerator/imports.js";
import * as renderInterruptAssignment from "../templates/backends/typescriptGenerator/interruptAssignment.js";
import * as renderInterruptReturn from "../templates/backends/typescriptGenerator/interruptReturn.js";
import * as renderRewindCheckpoint from "../templates/backends/typescriptGenerator/rewindCheckpoint.js";
import * as renderTraceSetup from "../templates/backends/typescriptGenerator/traceSetup.js";
import * as renderBlockSetup from "../templates/backends/typescriptGenerator/blockSetup.js";
import * as renderForkBlockSetup from "../templates/backends/typescriptGenerator/forkBlockSetup.js";
import * as renderResultCheckpointSetup from "../templates/backends/typescriptGenerator/resultCheckpointSetup.js";

import { AgencyConfig } from "@/config.js";
import {
  BinOpArgument,
  BinOpExpression,
  Operator,
  PRECEDENCE,
} from "@/types/binop.js";
import { MessageThread } from "@/types/messageThread.js";
import {
  walkNodesArray,
} from "@/utils/node.js";
import { AccessChainElement, ValueAccess } from "../types/access.js";
import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
} from "../types/dataStructures.js";
import { ForLoop } from "../types/forLoop.js";
import {
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
} from "../types/function.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { HandleBlock } from "../types/handleBlock.js";
import { IfElse } from "../types/ifElse.js";
import {
  ImportNodeStatement,
  ImportStatement,
  ImportToolStatement,
} from "../types/importStatement.js";
import { MatchBlock, MatchBlockCase } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { UsesTool } from "../types/tools.js";
import { WhileLoop } from "../types/whileLoop.js";
import { escape, mergeDeep } from "../utils.js";
import { isResultType } from "./utils.js";
import {
  generateBuiltinHelpers,
  mapFunctionName,
} from "./typescriptGenerator/builtins.js";
import {
  DEFAULT_SCHEMA,
  mapTypeToZodSchema,
} from "./typescriptGenerator/typeToZodSchema.js";

import { $, ts } from "../ir/builders.js";
import { printTs } from "../ir/prettyPrint.js";
import type {
  TsNode,
  TsObjectEntry,
  TsParam,
  TsTemplatePart
} from "../ir/tsIR.js";
import type { ProgramInfo } from "../programInfo.js";
import { getVisibleTypes, scopeKey } from "../programInfo.js";
import { SourceMapBuilder } from "./sourceMap.js";

const DEFAULT_PROMPT_NAME = "__promptVar";

export class TypeScriptBuilder {
  // Output assembly
  private generatedStatements: TsNode[] = [];
  private generatedTypeAliases: TsNode[] = [];

  // Import tracking
  private importStatements: TsNode[] = [];

  // Function tracking
  private functionsUsed: Set<string> = new Set();

  // Scope management
  private currentScope: Scope[] = [{ type: "global" }];

  // Config
  private agencyConfig: AgencyConfig = {};

  // Graph topology tracking
  private adjacentNodes: Record<string, string[]> = {};
  private currentAdjacentNodes: string[] = [];
  private isInsideGraphNode: boolean = false;

  // Threading & control flow
  private loopVars: string[] = [];
  private insideMessageThread: boolean = false;
  private insideHandlerBody: boolean = false;
  private _blockCounter: number = 0;

  /** Stack of loop subKeys for generating break/continue cleanup code.
   * Pushed when entering a stepped loop, popped when leaving. */
  private _loopContextStack: string[] = [];

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
  private _insideResultFunction: boolean = false;

  /** Tracks the current substep nesting path. Empty when at the top level
   * of a stepped body. Non-empty when inside a block (if/else, etc.) that
   * has been broken into substeps. Used to generate unique variable names
   * like __substep_3_1 for nested blocks. */
  private _subStepPath: number[] = [];
  private _sourceMapBuilder: SourceMapBuilder = new SourceMapBuilder();

  private programInfo: ProgramInfo;
  private moduleId: string;

  /**
   * @param config - Agency compiler configuration (model defaults, logging, etc.)
   * @param info - Pre-collected program metadata (function definitions, graph nodes, imports, type hints)
   * @param moduleId - Unique identifier for this module (e.g., "foo.agency"), used to
   *   namespace global variables in the GlobalStore so that different modules' globals
   *   don't collide. Must be consistent between the defining module and any importers.
   */
  constructor(
    config: AgencyConfig | undefined,
    info: ProgramInfo,
    moduleId: string,
  ) {
    this.agencyConfig = mergeDeep(this.configDefaults(), config || {});
    this.programInfo = info;
    this.moduleId = moduleId;
  }

  private configDefaults(): Partial<AgencyConfig> {
    return {
      maxToolCallRounds: 10,
      log: {
        host: "https://agency-lang.com",
      },
      client: {
        logLevel: "warn",
        defaultModel: "gpt-4o-mini",
        statelog: {
          host: "https://agency-lang.com",
          projectId: "smoltalk",
        },
      },
    };
  }

  /** Convert a TsNode to string (for use in template-based methods) */
  private str(node: TsNode): string {
    return printTs(node);
  }

  // ------- Scope management -------

  private startScope(scope: Scope): void {
    this.currentScope.push(scope);
  }

  private endScope(): void {
    this.currentScope.pop();
  }

  private getCurrentScope(): Scope {
    return this.currentScope[this.currentScope.length - 1];
  }

  /**
   * Assign a value to a scoped variable. For global scope, emits a
   * `__ctx.globals.set(moduleId, name, value)` call. For all other scopes,
   * emits a normal `lhs = rhs` assignment.
   */
  private scopedAssign(
    scope: ScopeType,
    varName: string,
    value: TsNode,
    accessChain?: AccessChainElement[],
  ): TsNode {
    if (scope === "global" && (!accessChain || accessChain.length === 0)) {
      return ts.globalSet(this.moduleId, varName, value);
    }
    const lhs = this.buildAssignmentLhs(scope, varName, accessChain);
    return ts.assign(lhs, value);
  }

  // ------- Lookup helpers -------

  private currentScopeKey(): string {
    return scopeKey(this.getCurrentScope());
  }

  /** Returns the name of the current scope (function, node, or block name, or empty string for global). */
  private currentScopeName(): string {
    const scope = this.getCurrentScope();
    if (scope.type === "function") return scope.functionName;
    if (scope.type === "node") return scope.nodeName;
    if (scope.type === "block") return scope.blockName;
    return "";
  }

  /** Returns the template opts for checkpoint creation (moduleId, scopeName, stepPath as JSON-quoted strings). */
  private checkpointOpts(): Record<keyof SourceLocationOpts, string> {
    const path = [...this._subStepPath];
    //path[path.length - 1] = path[path.length - 1] + 1;
    return {
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(this.currentScopeName()),
      stepPath: JSON.stringify(path.join(".")),
    };
  }

  private getVisibleTypeAliases(): Record<string, VariableType> {
    return getVisibleTypes(
      this.programInfo.typeAliases,
      this.currentScopeKey(),
    );
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
            ts.call(ts.prop(ts.runtime.ctx, "forkStack")),
          ),
        },
      ),
      ts.assign(stackBranches, ts.or(stackBranches, ts.obj({}))),
      ts.assign(branchWithBranchKey, ts.obj({ stack: forked })),
    ];
  }

  private isImportedTool(functionName: string): boolean {
    return this.programInfo.importedTools
      .flatMap((node) => node.importedTools)
      .flatMap((n) => n.importedNames)
      .includes(functionName);
  }

  // Runtime functions that need __state (ctx injection) like user-defined agency functions.
  // These are imported from the runtime but need the functionCallConfig passed as the last arg.
  private static RUNTIME_STATEFUL_FUNCTIONS = [
    "checkpoint",
    "getCheckpoint",
    "restore",
  ];

  private isAgencyFunction(
    functionName: string,
    context: "valueAccess" | "functionArg" | "topLevelStatement",
  ): boolean {
    if (context === "valueAccess") {
      return false;
    }
    return (
      !!this.programInfo.functionDefinitions[functionName] ||
      this.isImportedTool(functionName) ||
      TypeScriptBuilder.RUNTIME_STATEFUL_FUNCTIONS.includes(functionName)
    );
  }

  private isGraphNode(functionName: string): boolean {
    return (
      this.programInfo.graphNodes
        .map((n) => n.nodeName)
        .includes(functionName) ||
      this.programInfo.importedNodes
        .map((n) => n.importedNodes)
        .flat()
        .includes(functionName)
    );
  }

  private isImpureImportedFunction(functionName: string): boolean {
    return (
      !!this.programInfo.importedFunctions[functionName] &&
      !this.programInfo.safeFunctions[functionName]
    );
  }

  private containsImpureCall(node: AgencyNode): boolean {
    for (const { node: subNode } of walkNodesArray([node])) {
      if (subNode.type === "functionCall") {
        const name = subNode.functionName;
        if (this.isImpureImportedFunction(name)) return true;
        if (BUILTIN_FUNCTIONS[name]) return true;
      }
    }
    return false;
  }

  private getScopeReturnType(): VariableType | undefined {
    const currentScope = this.getCurrentScope();
    switch (currentScope.type) {
      case "global":
        return undefined;
      case "function": {
        const funcDef =
          this.programInfo.functionDefinitions[currentScope.functionName];
        if (funcDef && funcDef.returnType) {
          return funcDef.returnType;
        }
        return undefined;
      }
      case "node": {
        const graphNode = this.programInfo.graphNodes.find(
          (n) => n.nodeName === currentScope.nodeName,
        );
        if (graphNode && graphNode.returnType) {
          return graphNode.returnType;
        }
        return undefined;
      }
      default:
        throw new Error(`Unknown scope type: ${(currentScope as any).type}`);
    }
  }

  private agencyFileToDefaultImportName(agencyFile: string): string {
    return `__graph_${agencyFile.replace(".agency", "").replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }

  // ------- BinOp precedence helpers -------

  private needsParensLeft(child: BinOpArgument, parentOp: Operator): boolean {
    if (child.type !== "binOpExpression") return false;
    return PRECEDENCE[child.operator] < PRECEDENCE[parentOp];
  }

  private needsParensRight(child: BinOpArgument, parentOp: Operator): boolean {
    if (child.type !== "binOpExpression") return false;
    return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
  }

  // ------- Main entry point -------

  build(program: AgencyProgram): TsNode {
    // Pass 5: Generate code for tools
    const functionDefs: FunctionDefinition[] = [];
    for (const node of program.nodes) {
      if (node.type === "function") {
        functionDefs.push(node);
        this.generatedStatements.push(this.processTool(node));
      }
    }

    // Generate tool registry (always — builtin tools are always available)
    this.generatedStatements.push(this.generateToolRegistry(functionDefs));

    // Collect shared variable names and emit top-level `let` declarations
    const sharedVarNames = new Set<string>();
    for (const node of program.nodes) {
      if (node.type === "assignment" && node.scope === "shared") {
        sharedVarNames.add(node.variableName);
      }
    }
    const sharedDeclarations: TsNode[] = [];
    for (const name of sharedVarNames) {
      sharedDeclarations.push(ts.letDecl(name));
    }

    // Pass 7: Process all nodes and generate code
    // Separate global-scope assignments into __initializeGlobals function.
    const globalInitStatements: TsNode[] = [];
    for (const node of program.nodes) {
      if (node.type === "assignment" && node.scope === "global") {
        const valueNode = this.processNode(node.value);
        globalInitStatements.push(
          ts.globalSet(this.moduleId, node.variableName, valueNode),
        );
      } else {
        const result = this.processNode(node);
        this.generatedStatements.push(result);
      }
    }

    // Assemble output
    const sections: TsNode[] = [];

    sections.push(...this.preprocess());

    if (this.importStatements.length > 0) {
      sections.push(ts.statements(this.importStatements));
    }

    const importsResult = this.generateImports();
    if (importsResult.trim() !== "") {
      sections.push(ts.raw(importsResult));
    }

    const builtinsResult = this.generateBuiltins();
    if (builtinsResult.trim() !== "") {
      sections.push(ts.raw(builtinsResult));
    }

    for (const alias of this.generatedTypeAliases) {
      sections.push(alias);
    }

    // Emit shared variable declarations at module level
    if (sharedDeclarations.length > 0) {
      sections.push(ts.statements(sharedDeclarations));
    }

    // Generate __initializeGlobals function for per-execution global variable initialization
    sections.push(
      ts.functionDecl(
        "__initializeGlobals",
        [{ name: "__ctx" }],
        ts.statements([
          ...globalInitStatements,
          // Mark this module as initialized on the GlobalStore. The flag is
          // serialized with the store, so on interrupt resume the restored
          // GlobalStore already has this flag set and __initializeGlobals
          // won't be called again — avoiding re-evaluation of init expressions
          // and overwriting of restored global values.
          ts.call(
            $(ts.runtime.ctx).prop("globals").prop("markInitialized").done(),
            [ts.str(this.moduleId)],
          ),
        ]),
      ),
    );

    sections.push(ts.statements(this.generatedStatements));

    const postprocessNodes = this.postprocess();
    if (postprocessNodes.length > 0) {
      sections.push(ts.statements(postprocessNodes));
    }

    sections.push(
      ts.raw(
        `export const __sourceMap = ${JSON.stringify(this._sourceMapBuilder.build())};`,
      ),
    );

    return ts.statements(sections);
  }

  // ------- Node dispatch -------

  /** Named args are cosmetic/positional — validate name matches the param at that index. */
  private validateNamedArgs(node: FunctionCall, paramList: FunctionParameter[] | undefined): void {
    if (!paramList) return;
    const lastParam = paramList[paramList.length - 1];
    const hasVariadic = lastParam?.variadic;
    for (let i = 0; i < node.arguments.length; i++) {
      const arg = node.arguments[i];
      if (arg.type !== "namedArgument") continue;
      let expectedName: string;
      if (i < paramList.length) {
        expectedName = paramList[i].name;
      } else if (hasVariadic) {
        expectedName = lastParam.name;
      } else {
        throw new Error(
          `Named argument '${arg.name}' at position ${i + 1} is beyond the parameter list in call to '${node.functionName}'`,
        );
      }
      if (arg.name !== expectedName) {
        throw new Error(
          `Named argument '${arg.name}' does not match parameter '${expectedName}' at position ${i + 1} in call to '${node.functionName}'`,
        );
      }
    }
  }

  /** Process a function call argument, unwrapping NamedArgument and SplatExpression. */
  private processCallArg(arg: Expression | SplatExpression | NamedArgument): TsNode {
    if (arg.type === "namedArgument") {
      return this.processNode(arg.value as AgencyNode);
    }
    if (arg.type === "splat") {
      return ts.spread(this.processNode(arg.value as AgencyNode));
    }
    return this.processNode(arg as AgencyNode);
  }

  /**
   * Adjust call-site arguments to match the function's parameter list:
   * 1. Pad omitted optional args (those with defaults) with null
   * 2. Wrap extra args into an array for variadic params
   */
  private adjustCallArgs(argNodes: TsNode[], parameters: FunctionParameter[] | undefined): TsNode[] {
    if (!parameters || parameters.length === 0) return argNodes;

    const nonVariadicCount = parameters.filter((p) => !p.variadic).length;
    const hasVariadic = parameters[parameters.length - 1]?.variadic;

    // Pad omitted optional args (those with defaults) with null
    let result = [...argNodes];
    for (let i = result.length; i < nonVariadicCount; i++) {
      if (!parameters[i].defaultValue) break;
      result.push(ts.id("null"));
    }

    // Wrap extra args into array for variadic param
    if (hasVariadic) {
      const regularArgs = result.slice(0, nonVariadicCount);
      const variadicArgs = result.slice(nonVariadicCount);
      regularArgs.push(ts.arr(variadicArgs));
      result = regularArgs;
    }

    return result;
  }

  private processNode(node: AgencyNode): TsNode {
    switch (node.type) {
      case "typeAlias":
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
      case "multiLineString":
      case "string":
      case "variableName":
      case "boolean":
        return this.generateLiteral(node);
      case "returnStatement":
        return this.processReturnStatement(node);
      case "agencyArray":
        return this.processAgencyArray(node);
      case "agencyObject":
        return this.processAgencyObject(node);
      case "graphNode":
        return this.processGraphNode(node);
      case "usesTool":
        return this.processUsesTool(node);
      case "importStatement":
        this.importStatements.push(this.processImportStatement(node));
        return ts.empty();
      case "importNodeStatement":
        this.importStatements.push(this.processImportNodeStatement(node));
        return ts.empty();
      case "importToolStatement":
        this.importStatements.push(this.processImportToolStatement(node));
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
      case "specialVar":
        return this.processSpecialVar(node);
      case "newLine":
        return ts.empty();
      case "rawCode":
        return ts.raw(node.value);
      case "messageThread":
        return this.processMessageThread(node);
      case "handleBlock":
        return this.processHandleBlockWithSteps(node);
      case "skill":
        return ts.empty();
      case "binOpExpression":
        return this.processBinOpExpression(node);
      case "keyword":
        return this.processKeyword(node);
      case "sentinel":
        return this.processSentinel(node);
      case "debuggerStatement":
        return this.processDebuggerStatement(node);
      case "placeholder":
        throw new Error("Placeholder '?' can only appear on the right side of a |> pipe operator");
      default:
        throw new Error(`Unhandled Agency node type: ${(node as any).type}`);
    }
  }

  private processKeyword(node: Keyword): TsNode {
    // Inside a handler body or not inside a stepped loop: emit bare keyword
    const loopSubKey =
      this._loopContextStack[this._loopContextStack.length - 1];
    if (this.insideHandlerBody || loopSubKey === undefined) {
      return node.value === "break" ? ts.break() : ts.continue();
    }

    // Inside a runner loop: use runner.breakLoop() / runner.continueLoop()
    // and return from the callback. The runner handles iteration cleanup.
    const method = node.value === "break" ? "breakLoop" : "continueLoop";
    return ts.statements([
      $(ts.id("runner")).prop(method).call().done(),
      ts.raw("return"),
    ]);
  }

  // ------- Type system (side effects only) -------

  private processTypeAlias(node: TypeAlias): TsNode {
    return ts.raw(
      `type ${node.aliasName} = ${formatTypeHint(node.aliasedType)};`,
    );
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
        const escaped = escape(segment.value);
        if (parts.length > 0 && parts[parts.length - 1].expr) {
          // Previous part had an expr; start a new part for this text
          parts.push({ text: escaped });
        } else if (parts.length > 0) {
          // Previous part is text-only, append to it
          parts[parts.length - 1].text += escaped;
        } else {
          parts.push({ text: escaped });
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
    for (const element of node.chain) {
      switch (element.kind) {
        case "property":
          result = ts.prop(result, element.name);
          break;
        case "index":
          result = ts.index(result, this.processNode(element.index));
          break;
        case "methodCall": {
          const callNode = this.generateFunctionCallExpression(
            element.functionCall,
            "valueAccess",
          );
          // The call node is ts.call(ts.id(name), args) — extract callee name and args
          if (
            callNode.kind === "call" &&
            callNode.callee.kind === "identifier"
          ) {
            result = $(result)
              .prop(callNode.callee.name)
              .call(callNode.arguments)
              .done();
          } else {
            // Fallback for complex cases (e.g. await-wrapped)
            result = ts.raw(`${this.str(result)}.${this.str(callNode)}`);
          }
          break;
        }
      }
    }
    return result;
  }

  private processBinOpExpression(node: BinOpExpression): TsNode {
    if (node.operator === "|>") {
      return this.processPipeExpression(node);
    }
    const leftNode = this.processNode(node.left);
    const rightNode = this.processNode(node.right);
    return ts.binOp(leftNode, node.operator, rightNode, {
      parenLeft: this.needsParensLeft(node.left, node.operator),
      parenRight: this.needsParensRight(node.right, node.operator),
    });
  }

  private processPipeExpression(node: BinOpExpression): TsNode {
    const left = this.processNode(node.left);
    return this.buildPipeBind(left, node.right);
  }

  private processIfElseWithSteps(node: IfElse): TsNode {
    const id = this._subStepPath[this._subStepPath.length - 1];

    // Flatten the else-if chain
    const branches: { condition: TsNode; body: TsNode[] }[] = [];
    let elseBranch: TsNode[] | undefined;

    branches.push({
      condition: this.processNode(node.condition),
      body: this.processBodyAsParts(node.thenBody),
    });

    let current: IfElse | undefined =
      node.elseBody?.length === 1 && node.elseBody[0].type === "ifElse"
        ? (node.elseBody[0] as IfElse)
        : undefined;
    let remainingElse = current ? undefined : node.elseBody;

    while (current) {
      branches.push({
        condition: this.processNode(current.condition),
        body: this.processBodyAsParts(current.thenBody),
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
      elseBranch = this.processBodyAsParts(remainingElse);
    }

    return ts.runnerIfElse({ id, branches, elseBranch });
  }

  private processForLoopWithSteps(node: ForLoop): TsNode {
    const id = this._subStepPath[this._subStepPath.length - 1];

    // Register loop variables so they bypass scope resolution
    this.loopVars.push(node.itemVar);
    if (node.indexVar) {
      this.loopVars.push(node.indexVar);
    }

    const subKey = this._subStepPath.join("_");

    this._loopContextStack.push(subKey);
    const bodyNodes = this.processBodyAsParts(node.body);
    this._loopContextStack.pop();

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
      return ts.runnerLoop({ id, items: rangeExpr, itemVar: node.itemVar, body: bodyNodes });
    }

    const iterableNode = this.processNode(node.iterable);

    return ts.runnerLoop({
      id,
      items: iterableNode,
      itemVar: node.itemVar,
      indexVar: node.indexVar,
      body: bodyNodes,
    });
  }

  private processWhileLoopWithSteps(node: WhileLoop): TsNode {
    const id = this._subStepPath[this._subStepPath.length - 1];
    const subKey = this._subStepPath.join("_");
    const condition = this.processNode(node.condition);

    this._loopContextStack.push(subKey);
    const bodyNodes = this.processBodyAsParts(node.body);
    this._loopContextStack.pop();

    return ts.runnerWhileLoop({ id, condition, body: bodyNodes });
  }

  private processMatchBlockWithSteps(node: MatchBlock): TsNode {
    const id = this._subStepPath[this._subStepPath.length - 1];
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
            this.processNode(caseItem.caseValue),
          ),
          body: [this.processNode(caseItem.body)],
        });
      }
    }

    return ts.runnerIfElse({ id, branches, elseBranch });
  }

  private processImportStatement(node: ImportStatement): TsNode {
    const from = toCompiledImportPath(node.modulePath);
    const imports = node.importedNames.map((nameType) => {
      switch (nameType.type) {
        case "namedImport":
          return ts.importDecl({
            importKind: "named",
            names: nameType.importedNames,
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
    return imports.length === 1 ? imports[0] : ts.statements(imports);
  }

  private processImportNodeStatement(_node: ImportNodeStatement): TsNode {
    return ts.empty(); // handled in preprocess
  }

  private processImportToolStatement(node: ImportToolStatement): TsNode {
    const toolNames = node.importedTools.flatMap((n) => n.importedNames);
    const importNames = toolNames.flatMap((toolName) => [
      toolName,
      `__${toolName}Tool`,
      `__${toolName}ToolParams`,
    ]);
    return ts.importDecl({
      importKind: "named",
      names: importNames,
      from: toCompiledImportPath(node.agencyFile),
    });
  }

  // ------- TsRaw wrapper methods (template-heavy) -------

  private processUsesTool(node: UsesTool): TsNode {
    node.toolNames.forEach((toolName) => {
      if (BUILTIN_TOOLS.includes(toolName)) return;
      if (
        !this.programInfo.functionDefinitions[toolName] &&
        !this.isImportedTool(toolName)
      ) {
        throw new Error(
          `Tool '${toolName}' is being used but no function definition found for it. Make sure to define a function for this tool.`,
        );
      }
    });
    return ts.empty();
  }

  private processTool(node: FunctionDefinition): TsNode {
    const { functionName, parameters } = node;
    if (
      this.programInfo.graphNodes.map((n) => n.nodeName).includes(functionName)
    ) {
      throw new Error(
        `There is already a node named '${functionName}'. Functions can't have the same name as an existing node.`,
      );
    }

    const properties: Record<string, string> = {};
    parameters.forEach((param: FunctionParameter) => {
      const typeHint = param.typeHint || {
        type: "primitiveType" as const,
        value: "string",
      };
      let tsType = mapTypeToZodSchema(typeHint, this.getVisibleTypeAliases());
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
    return ts.statements([
      ts.export(
        ts.varDecl(
          "const",
          `__${functionName}Tool`,
          ts.obj({
            name: ts.str(functionName),
            description: ts.raw(
              `\`${node.docString?.value || "No description provided."}\``,
            ),
            schema: $.z()
              .prop("object")
              .call([ts.raw(schemaArg)])
              .done(),
          }),
        ),
      ),
      ts.export(
        ts.varDecl(
          "const",
          `__${functionName}ToolParams`,
          ts.arr(parameters.map((p) => ts.str(p.name))),
        ),
      ),
    ]);
  }

  private buildToolRegistryEntry(
    toolName: string,
    executeName: string,
    isBuiltin: boolean,
  ): TsNode {
    return ts.obj({
      definition: ts.id(`__${toolName}Tool`),
      handler: ts.obj({
        name: ts.str(toolName),
        params: ts.id(`__${toolName}ToolParams`),
        execute: ts.id(executeName),
        isBuiltin: ts.bool(isBuiltin),
      }),
    });
  }

  /**
   * Generate __toolRegistry mapping function names to their tool definitions and handlers.
   * The tool() function is defined in imports.mustache and closes over __toolRegistry.
   */
  private generateToolRegistry(functionDefs: FunctionDefinition[]): TsNode {
    const entries: Record<string, TsNode> = {};

    for (const def of functionDefs) {
      entries[def.functionName] = this.buildToolRegistryEntry(
        def.functionName,
        def.functionName,
        false,
      );
    }

    // Add imported tools (they import __toolNameTool and __toolNameToolParams)
    const importedToolNames = this.programInfo.importedTools
      .flatMap((node) => node.importedTools)
      .flatMap((n) => n.importedNames);
    for (const toolName of importedToolNames) {
      entries[toolName] = this.buildToolRegistryEntry(
        toolName,
        toolName,
        false,
      );
    }

    for (const toolName of BUILTIN_TOOLS) {
      const internalName = BUILTIN_FUNCTIONS[toolName] || toolName;
      entries[toolName] = this.buildToolRegistryEntry(
        toolName,
        internalName,
        true,
      );
    }

    return ts.varDecl("const", "__toolRegistry", ts.obj(entries));
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
    parameters.forEach((p, i) => {
      paramsStr += `  ${p.name} = __overrides[${i}];
  __stack.args[${JSON.stringify(p.name)}] = ${p.name};
`;
    });
    const str = renderResultCheckpointSetup.default({
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(functionName),
      paramsStr
    })

    return ts.raw(str);
  }

  private processFunctionDefinition(node: FunctionDefinition): TsNode {
    this.startScope({ type: "function", functionName: node.functionName });
    this._sourceMapBuilder.enterScope(this.moduleId, node.functionName);
    const { functionName, body, parameters } = node;
    const args = parameters.map((p) => p.name);

    const bodyCode = this.processBodyAsParts(body, {
      isInSafeFunction: !!node.safe,
    });
    this.endScope();

    // Build function params: typed args + __state
    const fnParams: TsParam[] = parameters.map((p) => {
      const baseType = p.typeHint ? formatTypeHint(p.typeHint) : "any";
      if (p.defaultValue) {
        return {
          name: p.name,
          typeAnnotation: `${baseType} | null`,
          defaultValue: ts.id("null"),
        };
      }
      return { name: p.name, typeAnnotation: baseType };
    });
    fnParams.push({
      name: "__state",
      typeAnnotation: "InternalFunctionState | undefined",
      defaultValue: ts.id("undefined"),
    });

    // Build args object for hook data
    const argsObj: Record<string, TsNode> = {};
    for (const arg of args) {
      argsObj[arg] = ts.id(arg);
    }

    // Setup block
    const setupStmts: TsNode[] = [
      ts.constDecl(
        "__setupData",
        $(ts.id("setupFunction"))
          .call([ts.obj({ state: ts.runtime.state })])
          .done(),
      ),

      ts.comment(
        "__state will be undefined if this function is being called as a tool by an llm",
      ),
      ts.setupEnv({
        stack: $(ts.id("__setupData")).prop("stack").done(),
        step: $(ts.id("__setupData")).prop("step").done(),
        self: $(ts.id("__setupData")).prop("self").done(),
        threads: $(ts.id("__setupData")).prop("threads").done(),
        ctx: ts.raw("__state?.ctx || __globalCtx"),
        statelogClient: ts.ctx("statelogClient"),
        graph: ts.ctx("graph"),
      }),

      // Ensure this module's globals are initialized on the current ctx.
      // The isInitialized flag lives on the GlobalStore and is serialized,
      // so on interrupt resume the restored store already has it set.
      ts.if(
        ts.raw(
          `!__ctx.globals.isInitialized(${JSON.stringify(this.moduleId)})`,
        ),
        ts.call(ts.id("__initializeGlobals"), [ts.runtime.ctx]),
      ),

      ts.time("__funcStartTime"),
      ts.callHook("onFunctionStart", {
        functionName: ts.str(functionName),
        args: ts.obj(argsObj),
        isBuiltin: ts.bool(false),
      }),
    ];

    // Param assignments to stack
    for (const param of parameters) {
      const stackTarget = $(ts.stack("args")).index(ts.str(param.name)).done();
      if (param.defaultValue) {
        const defaultNode = this.processNode(param.defaultValue);
        setupStmts.push(
          ts.assign(stackTarget, ts.binOp(ts.id(param.name), "??", defaultNode)),
        );
      } else {
        setupStmts.push(
          ts.assign(stackTarget, ts.id(param.name)),
        );
      }
    }

    // __self.__retryable
    setupStmts.push(
      ts.assign(
        ts.self("__retryable"),
        ts.binOp(ts.self("__retryable"), "??", ts.bool(true)),
      ),
    );

    // Create runner for step execution
    setupStmts.push(ts.raw(`const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: ${JSON.stringify(this.moduleId)}, scopeName: ${JSON.stringify(functionName)} });`));

    // Pinned checkpoint at entry for all functions (enables result.retry and error-to-failure wrapping)
    setupStmts.push(this.buildResultCheckpointSetup(functionName, parameters));

    // Try/catch wrapping the body, with finally to always pop the state stack
    setupStmts.push(
      ts.tryCatch(
        ts.statements([...bodyCode, ts.raw("if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }")]),
        ts.statements([
          ts.if(
            ts.raw("__error instanceof RestoreSignal"),
            ts.statements([ts.throw("__error")]),
          ),
          ts.if(
            ts.raw("__error instanceof ToolCallError"),
            ts.statements([
              ts.raw(
                "__error.retryable = __error.retryable && __self.__retryable",
              ),
              ts.throw("__error"),
            ]),
          ),
          ts.raw(`return failure(__error instanceof Error ? __error.message : String(__error), { checkpoint: __ctx.checkpoints.get(__resultCheckpointId), retryable: __self.__retryable, functionName: ${JSON.stringify(functionName)}, args: __stack.args });`),
        ]),
        "__error",
        // finally block: pop state stack and conditionally fire onFunctionEnd.
        // onFunctionEnd must live here (not after the try/catch) because
        // every code path inside the try block returns, making any code
        // after try/catch/finally unreachable.
        // The __functionCompleted flag ensures onFunctionEnd only fires on
        // normal completion, not when a debug interrupt pauses the function.
        ts.statements([
          ts.raw("if (!__state?.isForked) { __ctx.stateStack.pop() }"),
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
      ),
    );

    return ts.functionDecl(functionName, fnParams, ts.statements(setupStmts), {
      async: true,
      export: !!node.exported,
    });
  }

  private processStatement(node: AgencyNode): TsNode {
    if (node.type === "functionCall") {
      return this.processFunctionCallAsStatement(node);
    }
    return this.processNode(node);
  }

  private buildInterruptReturn(args: FunctionCall["arguments"]): TsNode {
    const interruptArgs = args
      .map((arg) => this.str(this.processCallArg(arg)))
      .join(", ");
    return ts.raw(
      renderInterruptReturn.default({
        interruptArgs,
        nodeContext: this.getCurrentScope().type === "node",
        ...this.checkpointOpts(),
      }),
    );
  }

  private processFunctionCallAsStatement(node: FunctionCall): TsNode {
    if (node.functionName === "interrupt") {
      return this.buildInterruptReturn(node.arguments);
    }

    const callNode = this.processFunctionCall(node);
    const scope = this.getCurrentScope();

    if (
      this.isAgencyFunction(node.functionName, "topLevelStatement") &&
      !this.isGraphNode(node.functionName) &&
      scope.type !== "global"
    ) {
      // Async unassigned calls: register with pending promise store, no interrupt check
      if (node.async) {
        // For agency functions, fork the stack for per-thread isolation
        if (
          this.isAgencyFunction(node.functionName, "topLevelStatement") &&
          !this.isGraphNode(node.functionName)
        ) {
          this._asyncBranchCheckNeeded = true;
          const branchKey = this._subStepPath.join("_");
          let statements = ts.statements(this.forkBranchSetup(branchKey));
          const callWithStack = this.generateFunctionCallExpression(
            node,
            "topLevelStatement",
            { stateStack: ts.id("__forked") },
          );

          statements = ts.statementsPush(
            statements,
            ts.raw(`__ctx.pendingPromises.add(${this.str(callWithStack)})`),
          );
          return statements;
        }
        return ts.raw(`__ctx.pendingPromises.add(${this.str(callNode)})`);
      }

      // Sync calls: check for interrupt result
      const tempVar = "__funcResult";
      const nodeContext = scope.type === "node";
      // In node context, wrap with state for the driver.
      // In function context, halt with the interrupt directly so the caller's
      // isInterrupt check can detect it.
      const haltValue = nodeContext
        ? ts.obj([
          ts.setSpread(ts.runtime.state),
          ts.set("data", ts.id(tempVar)),
        ])
        : ts.id(tempVar);
      return ts.statements([
        ts.constDecl(tempVar, callNode),
        ts.if(
          ts.call(ts.id("isInterrupt"), [ts.id(tempVar)]),
          ts.statements([
            ts.raw("await __ctx.pendingPromises.awaitAll()"),
            $(ts.id("runner")).prop("halt").call([haltValue]).done(),
            ts.return(),
          ]),
        ),
      ]);
    }

    return callNode;
  }

  private processFunctionCall(node: FunctionCall): TsNode {
    if ((node.functionName === "fork" || node.functionName === "race") && node.block) {
      return this.processForkCall(node);
    }

    if (node.functionName === "failure" && this.getCurrentScope().type === "function") {
      // Inside functions, inject checkpoint, function name, and args
      const scope = this.getCurrentScope() as FunctionScope;
      const argNodes: TsNode[] = node.arguments.map((arg) =>
        this.processCallArg(arg),
      );
      return ts.call(ts.id("failure"), [
        ...argNodes,
        ts.raw(`{ checkpoint: __ctx.checkpoints.get(__resultCheckpointId), functionName: ${JSON.stringify(scope.functionName)}, args: __stack.args }`),
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

    if (node.functionName === "llm") {
      // Standalone llm() call (not assigned to variable)
      return this.processLlmCall(
        DEFAULT_PROMPT_NAME,
        this.getScopeReturnType(),
        node,
        "local",
      );
    }

    if (this.isGraphNode(node.functionName)) {
      if (this.getCurrentScope().type === "function") {
        throw new Error(
          `Cannot call graph node '${node.functionName}' from inside function '${(this.getCurrentScope() as any).functionName}'. Node transitions can only be made from within graph nodes.`,
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
    const fnDef = this.programInfo.functionDefinitions[node.functionName];
    const imported = this.programInfo.importedFunctions[node.functionName];
    const paramList = fnDef?.parameters ?? imported?.parameters;

    this.validateNamedArgs(node, paramList);

    const rawArgNodes: TsNode[] = node.arguments.map((rawArg) => {
      const arg = rawArg.type === "namedArgument" ? rawArg.value : rawArg;
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        return this.generateFunctionCallExpression(arg, "functionArg");
      } else {
        return this.processCallArg(arg);
      }
    });

    const nonBlockParams = paramList?.filter(
      (p) => !p.typeHint || p.typeHint.type !== "blockType",
    );
    const argNodes = this.adjustCallArgs(rawArgNodes, nonBlockParams);

    if (node.block) {
      const blockType = paramList
        ?.map((p) => p.typeHint)
        .find((t): t is BlockType => t?.type === "blockType");

      const blockParams: TsParam[] = node.block.params.map((p, i) => ({
        name: p.name,
        typeAnnotation: blockType?.params[i]
          ? formatTypeHint(blockType.params[i].typeAnnotation)
          : "any",
      }));

      // Enter block scope, process body as runner steps
      const blockName = `__block_${this._blockCounter++}`;
      const parentScopeName = this.currentScopeName();
      this.startScope({ type: "block", blockName });
      this._sourceMapBuilder.enterScope(this.moduleId, blockName);
      const bodyParts = this.processBodyAsParts(node.block.body);
      this._sourceMapBuilder.enterScope(this.moduleId, parentScopeName);
      this.endScope();

      // Render body parts to string for the template
      const bodyStr = bodyParts.map((n) => printTs(n, 1)).join("\n");

      const blockSetupCode = renderBlockSetup.default({
        params: node.block.params.map((p) => ({
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
      argNodes.push(blockFn);
    }

    const shouldAwait = !node.async && context !== "valueAccess";

    if (this.isAgencyFunction(node.functionName, context)) {
      // Inside a message thread: pass the caller's ThreadStore so the function
      // shares the thread context. Outside: pass a new ThreadStore for isolation.
      const threadsExpr = this.insideMessageThread
        ? ts.runtime.threads
        : ts.newThreadStore();
      const configObj = ts.functionCallConfig({
        ctx: ts.runtime.ctx,
        threads: threadsExpr,
        interruptData: ts.raw("__state?.interruptData"),
        stateStack: options?.stateStack,
        isForked: node.async,
      });
      const call = ts.call(ts.id(functionName), [...argNodes, configObj]);
      return shouldAwait ? ts.await(call) : call;
    } else if (node.functionName === "system") {
      // __threads.active().push(smoltalk.systemMessage(msg))
      return $(ts.threads.active())
        .prop("push")
        .call([ts.smoltalkSystemMessage(argNodes)])
        .done();
    } else {
      const call = $.id(functionName).call(argNodes).done();
      return shouldAwait ? ts.await(call) : call;
    }
  }

  private processForkCall(node: FunctionCall): TsNode {
    const mode = node.functionName === "fork" ? "all" : "race";
    const block = node.block!;
    const paramName = block.params[0]?.name ?? "_";
    const id = this._subStepPath[this._subStepPath.length - 1];

    const itemsNode = node.arguments.length > 0
      ? this.processCallArg(node.arguments[0])
      : ts.arr([]);

    const blockName = `__block_${this._blockCounter++}`;
    const parentScopeName = this.currentScopeName();
    this.startScope({ type: "block", blockName });
    this._sourceMapBuilder.enterScope(this.moduleId, blockName);
    const bodyParts = this.processBodyAsParts(block.body);
    this._sourceMapBuilder.enterScope(this.moduleId, parentScopeName);
    this.endScope();

    const bodyStr = bodyParts.map((n) => printTs(n, 1)).join("\n");

    const blockSetupCode = renderForkBlockSetup.default({
      paramNameQuoted: JSON.stringify(paramName),
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(blockName),
      body: bodyStr,
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
      .call([ts.num(id), itemsNode, blockFn, ts.str(mode)])
      .await()
      .done();
  }

  private generateNodeCallExpression(node: FunctionCall): TsNode {
    const functionName = mapFunctionName(node.functionName);
    const targetNode = this.programInfo.graphNodes.find(
      (n) => n.nodeName === functionName,
    );
    this.validateNamedArgs(node, targetNode?.parameters);

    const argNodes: TsNode[] = node.arguments.map((rawArg) => {
      const arg = rawArg.type === "namedArgument" ? rawArg.value : rawArg;
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        return this.generateFunctionCallExpression(arg, "functionArg");
      } else {
        return this.processCallArg(arg);
      }
    });

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
      dataNode = $.id("Object").prop("fromEntries").call([entries]).done();
    } else {
      dataNode = ts.obj({});
    }

    const goToArgs = ts.obj({
      messages: ts.stack("messages"),
      ctx: ts.runtime.ctx,
      data: dataNode,
    });

    return ts.statements([
      ts.functionReturn(ts.goToNode(functionName, goToArgs)),
    ]);
  }

  private processGraphNode(node: GraphNodeDefinition): TsNode {
    this.startScope({ type: "node", nodeName: node.nodeName });
    this._sourceMapBuilder.enterScope(this.moduleId, node.nodeName);
    const { nodeName, body, parameters } = node;
    this.adjacentNodes[nodeName] = [];
    this.currentAdjacentNodes = [];
    this.isInsideGraphNode = true;

    for (const stmt of body) {
      if (stmt.type === "functionCall" && this.isGraphNode(stmt.functionName)) {
        throw new Error(
          `Call to graph node '${stmt.functionName}' inside graph node '${nodeName}' was not returned. All calls to graph nodes must be returned, eg (return ${stmt.functionName}(...)).`,
        );
      }
    }

    const bodyCode = this.processBodyAsParts(body);

    this.adjacentNodes[nodeName] = [...this.currentAdjacentNodes];
    this.isInsideGraphNode = false;
    this.endScope();
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
        threads: $(ts.id("__setupData")).prop("threads").done(),
        ctx: $(ts.runtime.state).prop("ctx").done(),
        statelogClient: ts.ctx("statelogClient"),
        graph: ts.ctx("graph"),
      }),

      ts.callHook("onNodeStart", { nodeName: ts.str(nodeName) }),

      // Create runner for step execution (nodeContext enables { messages, data } wrapping for debug halts)
      ts.raw(`const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: ${JSON.stringify(this.moduleId)}, scopeName: ${JSON.stringify(nodeName)} });`),
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

    // Body wrapped in try-catch so node errors return failure instead of crashing
    stmts.push(
      ts.tryCatch(
        ts.statements([
          ...bodyCode,
          ts.raw("if (runner.halted) return runner.haltResult;"),
          ts.callHook("onNodeEnd", {
            nodeName: ts.str(nodeName),
            data: ts.id("undefined"),
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
          ts.return(
            ts.obj({
              messages: ts.runtime.threads,
              data: ts.raw(`failure(__error instanceof Error ? __error.message : String(__error), { functionName: ${JSON.stringify(nodeName)} })`),
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

  private processReturnStatement(node: ReturnStatement): TsNode {
    // Handler bodies use plain returns — no node/function wrapping
    if (this.insideHandlerBody) {
      return ts.return(this.processNode(node.value));
    }

    // Block bodies: halt the block's runner with the raw value
    if (this.getCurrentScope().type === "block") {
      if (
        node.value.type === "functionCall" &&
        node.value.functionName === "interrupt"
      ) {
        return this.buildInterruptReturn(node.value.arguments);
      }
      const valueNode = this.processNode(node.value);
      return ts.runnerHalt(valueNode);
    }

    if (this.isInsideGraphNode) {
      if (
        node.value.type === "functionCall" &&
        node.value.functionName === "interrupt"
      ) {
        return this.buildInterruptReturn(node.value.arguments);
      }
      if (
        node.value.type === "functionCall" &&
        node.value.functionName === "llm"
      ) {
        const llmNode = this.processLlmCall(
          DEFAULT_PROMPT_NAME,
          this.getScopeReturnType(),
          node.value,
          "local",
        );
        return ts.statements([
          llmNode,
          ts.nodeResult(ts.self(DEFAULT_PROMPT_NAME)),
        ]);
      }
      const valueNode = this.processNode(node.value);
      if (
        node.value.type === "functionCall" &&
        this.isGraphNode(node.value.functionName)
      ) {
        return valueNode;
      }
      return ts.nodeResult(valueNode);
    }

    if (
      node.value.type === "functionCall" &&
      node.value.functionName === "interrupt"
    ) {
      return this.buildInterruptReturn(node.value.arguments);
    } else if (
      node.value.type === "functionCall" &&
      node.value.functionName === "llm"
    ) {
      const llmNode = this.processLlmCall(
        DEFAULT_PROMPT_NAME,
        this.getScopeReturnType(),
        node.value,
        "local",
      );
      return ts.statements([
        llmNode,
        ts.functionReturn(ts.self(DEFAULT_PROMPT_NAME)),
      ]);
    }
    const valueNode = this.processNode(node.value);
    return ts.functionReturn(valueNode);
  }

  private processAssignment(node: Assignment): TsNode {
    const { variableName, typeHint, value } = node;

    if (value.type === "functionCall" && value.functionName === "llm") {
      return this.processLlmCall(variableName, typeHint, value, node.scope!);
    } else if (
      value.type === "functionCall" &&
      value.functionName === "interrupt"
    ) {
      const interruptArgs = value.arguments
        .map((arg) => this.str(this.processCallArg(arg)))
        .join(", ");
      const makeAssign = (val: string) =>
        this.str(
          this.scopedAssign(
            node.scope!,
            variableName,
            ts.raw(val),
            node.accessChain,
          ),
        );
      return ts.raw(
        renderInterruptAssignment.default({
          assignResolve: makeAssign(
            "__state.interruptData.interruptResponse.value",
          ),
          assignApprove: makeAssign("true"),
          handlerApprove: makeAssign("__handlerResult.value"),
          interruptArgs,
          nodeContext: this.getCurrentScope().type === "node",
          ...this.checkpointOpts(),
        }),
      );
    } else if (value.type === "functionCall") {
      const varRef = this.buildAssignmentLhs(
        node.scope!,
        variableName,
        node.accessChain,
      );
      const stmts: TsNode[] = [
        this.scopedAssign(
          node.scope!,
          variableName,
          this.processNode(value),
          node.accessChain,
        ),
      ];

      if (value.async) {
        // For agency functions, fork the stack for per-thread isolation
        if (
          this.isAgencyFunction(value.functionName, "topLevelStatement") &&
          !this.isGraphNode(value.functionName)
        ) {
          this._asyncBranchCheckNeeded = true;
          const branchKey = this._subStepPath.join("_");
          stmts.unshift(...this.forkBranchSetup(branchKey));
          stmts[stmts.length - 1] = this.scopedAssign(
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
              `__ctx.pendingPromises.add(${this.str(varRef)}, (val) => { ${this.str(varRef)} = val; })`,
            ),
          ),
        );
      } else if (this.getCurrentScope().type !== "global") {
        // Sync: interrupt check with awaitAll before halt.
        // In function context, halt with the interrupt directly so the caller's
        // isInterrupt check can detect it.
        const haltValue =
          this.getCurrentScope().type === "node"
            ? ts.obj([ts.setSpread(ts.runtime.state), ts.set("data", varRef)])
            : varRef;
        stmts.push(
          ts.if(
            $(ts.id("isInterrupt")).call([varRef]).done(),
            ts.statements([
              ts.raw("await __ctx.pendingPromises.awaitAll()"),
              $(ts.id("runner")).prop("halt").call([haltValue]).done(),
              ts.return(),
            ]),
          ),
        );
      }
      return ts.statements(stmts);
    } else if (value.type === "messageThread") {
      return this.processMessageThread(value, node);
    } else {
      return this.scopedAssign(
        node.scope!,
        variableName,
        this.processNode(value),
        node.accessChain,
      );
    }
  }

  private buildAccessChain(base: TsNode, chain?: AccessChainElement[]): TsNode {
    if (!chain || chain.length === 0) return base;
    let result = base;
    for (const el of chain) {
      switch (el.kind) {
        case "property":
          result = ts.prop(result, el.name);
          break;
        case "index":
          result = ts.index(result, this.processNode(el.index));
          break;
        case "methodCall": {
          const callNode = this.generateFunctionCallExpression(
            el.functionCall,
            "valueAccess",
          );
          if (
            callNode.kind === "call" &&
            callNode.callee.kind === "identifier"
          ) {
            result = $(result)
              .prop(callNode.callee.name)
              .call(callNode.arguments)
              .done();
          } else {
            result = ts.raw(`${this.str(result)}.${this.str(callNode)}`);
          }
          break;
        }
      }
    }
    return result;
  }

  private buildAssignmentLhs(
    scope: ScopeType,
    variableName: string,
    chain?: AccessChainElement[],
  ): TsNode {
    return this.buildAccessChain(
      ts.scopedVar(variableName, scope, this.moduleId),
      chain,
    );
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

    const zodSchema = mapTypeToZodSchema(
      _variableType,
      this.getVisibleTypeAliases(),
    );

    // Extract prompt from first argument, using processNode to get scoped variable references
    const promptArg = node.arguments[0];
    const promptNode = promptArg ? this.processCallArg(promptArg) : ts.raw("``");

    // Extract config from second argument (if present).
    // Known keys (tools) are extracted; the rest passes through as clientConfig.
    const configArg = node.arguments[1];
    let clientConfig: TsNode;
    let configToolNames: string[] = [];

    if (configArg && configArg.type === "agencyObject") {
      // Extract tools from config object
      const toolsEntry = configArg.entries.find(
        (e) =>
          !("type" in e && e.type === "splat") &&
          (e as AgencyObjectKV).key === "tools",
      ) as AgencyObjectKV | undefined;

      if (toolsEntry && toolsEntry.value.type === "agencyArray") {
        // Extract tool names from the array items
        for (const item of toolsEntry.value.items) {
          if (item.type === "variableName") {
            // Bare function reference: llm("...", { tools: [getWeather] })
            configToolNames.push(item.value);
          } else if (
            item.type === "functionCall" &&
            item.functionName === "tool"
          ) {
            // Explicit tool() call: llm("...", { tools: [tool(getWeather)] })
            const toolArg = item.arguments[0];
            if (toolArg && toolArg.type === "variableName") {
              configToolNames.push(toolArg.value);
            }
          }
        }
      }

      // Build clientConfig without known keys
      const knownKeys = ["tools"];
      const remainingEntries = configArg.entries.filter(
        (e) =>
          ("type" in e && e.type === "splat") ||
          !knownKeys.includes((e as AgencyObjectKV).key),
      );
      clientConfig =
        remainingEntries.length > 0
          ? this.processNode({ ...configArg, entries: remainingEntries })
          : ts.obj({});
    } else if (configArg) {
      clientConfig = this.processCallArg(configArg);
    } else {
      clientConfig = ts.obj({});
    }

    // Thread expression
    let threadExpr: TsNode;
    const isInFunction = this.getCurrentScope().type === "function";
    if (this.insideMessageThread || isInFunction) {
      threadExpr = ts.threads.getOrCreateActive();
    } else {
      threadExpr = ts.threads.createAndReturnThread();
    }

    // Merge tools from usesTool statements (preprocessor) and config object
    const usesToolNames = node.tools?.toolNames || [];
    const allToolNames = [...usesToolNames, ...configToolNames];

    // Generate tools as tool() registry lookups merged into clientConfig
    const toolNodes: TsNode[] = allToolNames.map((name) =>
      $(ts.id("tool"))
        .call([ts.str(name)])
        .done(),
    );

    // Merge tools into clientConfig
    let mergedConfig: TsNode;
    if (allToolNames.length > 0) {
      // Spread user config and add tools
      mergedConfig = ts.obj([
        ts.set("tools", ts.arr(toolNodes)),
        ts.setSpread(clientConfig),
      ]);
    } else {
      mergedConfig = clientConfig;
    }

    // Build runPrompt config object
    const runPromptEntries: Record<string, TsNode> = {
      ctx: ts.runtime.ctx,
      prompt: promptNode,
      messages: $(threadExpr).done(),
    };
    if (zodSchema !== DEFAULT_SCHEMA) {
      runPromptEntries.responseFormat = $.z()
        .prop("object")
        .namedArgs({ response: ts.raw(zodSchema) })
        .done();
    }
    runPromptEntries.clientConfig = mergedConfig;
    runPromptEntries.maxToolCallRounds = ts.num(
      this.agencyConfig.maxToolCallRounds || 10,
    );
    runPromptEntries.interruptData = ts.raw("__state?.interruptData");
    runPromptEntries.removedTools = ts.self("__removedTools");

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
            `__ctx.pendingPromises.add(${this.str(varRef)}, (val) => { ${this.str(varRef)} = val; })`,
          ),
        ),
      );
    } else {
      // Sync: await + interrupt check
      stmts.push(ts.assign(varRef, ts.await(runPromptCall)));
      stmts.push(ts.comment("halt if this is an interrupt"));
      const isNodeContext = this.getCurrentScope().type === "node";
      const haltValue = isNodeContext
        ? ts.obj({ messages: ts.runtime.threads, data: varRef })
        : varRef;
      stmts.push(
        ts.if(
          $(ts.id("isInterrupt")).call([varRef]).done(),
          ts.statements([
            ts.raw("await __ctx.pendingPromises.awaitAll()"),
            $(ts.id("runner")).prop("halt").call([haltValue]).done(),
            ts.return(),
          ]),
        ),
      );
    }

    return ts.statements(stmts);
  }

  private processSentinel(node: Sentinel): TsNode {
    if (node.value === "checkpoint") {
      const promptNode = this.processNode(node.data.prompt);
      const varRef = ts.scopedVar(
        node.data.targetVariable,
        node.data.scope,
        this.moduleId,
      );
      return ts.raw(
        renderRewindCheckpoint.default({
          targetVariable: node.data.targetVariable,
          prompt: printTs(promptNode),
          response: printTs(varRef),
          ...this.checkpointOpts(),
        }),
      );
    }
    return ts.empty();
  }

  private processDebuggerStatement(node: DebuggerStatement): TsNode {
    if (!this.agencyConfig?.debugger && !this.agencyConfig?.trace) {
      // Debug/trace mode off: debugger keyword is a no-op
      return ts.empty();
    }

    return ts.runnerDebugger({ id: this._subStepPath[this._subStepPath.length - 1], label: node.label || "" });
  }

  private processSpecialVar(node: SpecialVar): TsNode {
    const value = this.str(this.processNode(node.value));
    switch (node.name) {
      case "model":
        return ts.assign(
          ts.id("__client"),
          $.id("__getClientWithConfig")
            .namedArgs({ model: ts.str(value) })
            .done(),
        );
      case "messages":
        return $(ts.threads.active())
          .prop("setMessages")
          .call([this.processNode(node.value)])
          .done();
      default:
        throw new Error(`Unhandled SpecialVar name: ${node.name}`);
    }
  }

  private processMessageThread(
    node: MessageThread,
    assignTo?: Assignment,
  ): TsNode {
    const id = this._subStepPath[this._subStepPath.length - 1];
    const method =
      node.threadType === "subthread" ? "createSubthread" as const : "create" as const;

    // Body: process each statement with substep tracking
    const prevInsideMessageThread = this.insideMessageThread;
    this.insideMessageThread = true;
    const bodyNodes = this.processBodyAsParts(node.body);
    this.insideMessageThread = prevInsideMessageThread;

    // The Runner's thread() method handles setup (create + pushActive) and
    // cleanup (popActive). If the thread result is assigned, clone messages
    // INSIDE the callback (before popActive runs in the finally block).
    if (assignTo) {
      bodyNodes.push(
        this.scopedAssign(
          assignTo.scope!,
          assignTo.variableName,
          $(ts.threads.active()).prop("cloneMessages").call().done(),
          assignTo.accessChain,
        ),
      );
    }

    return ts.runnerThread({ id, method, body: bodyNodes });
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
              node.itemVar,
              ts.index(ts.id(iterableVar), ts.id(node.indexVar)),
            ),
            ...node.body.map((s) => this.processNode(s)),
          ]),
        ),
      ]);
    }
    return ts.forOf(
      node.itemVar,
      this.processNode(node.iterable),
      processBody(node.body),
    );
  }

  private processHandleBlockWithSteps(node: HandleBlock): TsNode {
    const id = this._subStepPath[this._subStepPath.length - 1];
    const subKey = this._subStepPath.join("_");
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
        ? formatTypeHint(node.handler.param.typeHint)
        : "any";
      handler =
        ts.arrowFn(
          [{ name: node.handler.param.name, typeAnnotation: paramType }],
          ts.statements(handlerBody),
          { async: true },
        );
    } else {
      const fnName = node.handler.functionName;
      if (fnName === "approve" || fnName === "reject" || fnName === "propagate") {
        // Built-in handler: wrap the built-in factory function directly
        const args = fnName === "propagate" ? [] : [ts.id("__data")];
        handler =
          ts.arrowFn(
            [{ name: "__data", typeAnnotation: "any" }],
            ts.call(ts.id(fnName), args),
            { async: true },
          );
      } else {
        // Function ref: wrap in arrow that calls the named function
        handler =
          ts.arrowFn(
            [{ name: "__data", typeAnnotation: "any" }],
            ts.await(
              ts.call(ts.id(node.handler.functionName), [
                ts.id("__data"),
                ts.functionCallConfig({
                  ctx: ts.runtime.ctx,
                  threads: ts.newThreadStore(),
                  interruptData: ts.id("undefined"),
                }),
              ]),
            ),
            { async: true },
          );
      }
    }

    // Body: process each statement with substep tracking
    const bodyNodes = this.processBodyAsParts(node.body);

    return ts.runnerHandle({ id, handler, body: bodyNodes });
  }

  /** In debugger mode, insert debuggerStatement nodes before each
   *  step-triggering statement so that debugStep() is called at every
   *  substep boundary, not just top-level steps. */
  private insertDebugSteps(body: AgencyNode[]): AgencyNode[] {
    if (!this.agencyConfig?.debugger && !this.agencyConfig?.trace) return body;
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

  // ── Pipe chain splitting ──

  private _pipeCounter = 0;

  /**
   * Walk a left-recursive |> tree and return [initial, stage1, stage2, ...].
   * Returns null if the expression is not a pipe assignment.
   */
  private getPipeChainStages(node: AgencyNode): Expression[] | null {
    if (node.type !== "assignment") return null;
    const expr = node.value;
    if (expr.type !== "binOpExpression" || expr.operator !== "|>") return null;

    const stages: Expression[] = [];
    let current: Expression = expr;
    while (current.type === "binOpExpression" && (current as BinOpExpression).operator === "|>") {
      stages.push((current as BinOpExpression).right);
      current = (current as BinOpExpression).left;
    }
    stages.push(current);
    return stages.reverse();
  }

  /** Build: await __pipeBind(leftIR, async (__pipeArg) => stage(__pipeArg)) */
  private buildPipeBind(leftIR: TsNode, stage: Expression): TsNode {
    return ts.await(ts.call(ts.raw("__pipeBind"), [
      leftIR,
      this.buildPipeLambda(stage),
    ]));
  }

  /**
   * Expand a pipe chain assignment into multiple IR parts, one per stage.
   * Each part becomes its own runner step so interrupts don't replay earlier stages.
   */
  private expandPipeChain(stmt: Assignment, stages: Expression[], baseId: number): TsNode[] {
    const tempName = `__pipe_${this._pipeCounter++}`;
    const tempVar = ts.scopedVar(tempName, "local");
    const targetVar = this.buildAssignmentLhs(stmt.scope!, stmt.variableName, stmt.accessChain);
    const nodes: TsNode[] = [];

    nodes.push(ts.runnerStep({ id: baseId, body: [ts.assign(tempVar, this.processNode(stages[0]))] }));

    for (let i = 1; i < stages.length - 1; i++) {
      nodes.push(ts.runnerPipe({ id: baseId + i, target: tempVar, input: tempVar, fn: this.buildPipeLambda(stages[i]) }));
    }

    const lastIdx = stages.length - 1;
    nodes.push(ts.runnerPipe({ id: baseId + lastIdx, target: targetVar, input: tempVar, fn: this.buildPipeLambda(stages[lastIdx]) }));

    return nodes;
  }

  private buildPipeLambda(stage: Expression): TsNode {
    const pipeArg = ts.raw("__pipeArg");

    if (stage.type === "valueAccess" || stage.type === "variableName") {
      const funcName = stage.type === "variableName" ? stage.value : "";
      const callee = this.processNode(stage);
      const args = [pipeArg, ...this.buildPipeStateArgs(funcName)];
      return ts.arrowFn([{ name: "__pipeArg" }], ts.call(callee, args), { async: true });
    }

    if (stage.type === "functionCall") {
      const placeholderCount = stage.arguments.filter((a) => a.type === "placeholder").length;
      if (placeholderCount !== 1) {
        throw new Error(
          `Function call on right side of |> must contain exactly one ? placeholder, got ${placeholderCount}`,
        );
      }
      const args = stage.arguments.map((a) =>
        a.type === "placeholder" ? pipeArg : this.processNode(a as AgencyNode)
      );
      const callee = ts.raw(mapFunctionName(stage.functionName));
      return ts.arrowFn(
        [{ name: "__pipeArg" }],
        ts.call(callee, [...args, ...this.buildPipeStateArgs(stage.functionName)]),
        { async: true },
      );
    }

    throw new Error(`Invalid pipe stage type: ${stage.type}`);
  }

  private buildPipeStateArgs(funcName: string): TsNode[] {
    if (!this.isAgencyFunction(funcName, "topLevelStatement")) return [];
    const threadsExpr = this.insideMessageThread
      ? ts.runtime.threads
      : ts.newThreadStore();
    return [ts.functionCallConfig({
      ctx: ts.runtime.ctx,
      threads: threadsExpr,
      interruptData: ts.raw("__state?.interruptData"),
    })];
  }

  // ── Body processing ──

  private processBodyAsParts(
    body: AgencyNode[],
    opts: { isInSafeFunction?: boolean } = {},
  ): TsNode[] {
    const result: TsNode[] = [];
    const branchKeys: Record<number, string> = {};

    // Track the current "part" being built (for non-pipe statements)
    let currentPart: TsNode[] | null = null;

    const flushPart = () => {
      if (currentPart) {
        const id = result.length;
        if (branchKeys[id]) {
          result.push(ts.runnerBranchStep({ id, branchKey: branchKeys[id], body: currentPart }));
        } else {
          result.push(ts.runnerStep({ id, body: currentPart }));
        }
        currentPart = null;
      }
    };

    for (const stmt of body) {
      // Pipe chains produce pre-formed runner nodes
      const pipeStages = this.getPipeChainStages(stmt);
      if (pipeStages) {
        flushPart();
        const baseId = result.length;
        const pipeNodes = this.expandPipeChain(stmt as Assignment, pipeStages, baseId);
        for (let i = 0; i < pipeNodes.length; i++) {
          this._subStepPath.push(baseId + i);
          result.push(pipeNodes[i]);
          this._sourceMapBuilder.record([...this._subStepPath], stmt.loc);
          this._subStepPath.pop();
        }
        continue;
      }

      if (!TYPES_THAT_DONT_TRIGGER_NEW_PART.includes(stmt.type)) {
        flushPart();
        currentPart = [];
      }

      const stepIndex = result.length;
      this._subStepPath.push(stepIndex);
      if (!opts.isInSafeFunction && this.containsImpureCall(stmt)) {
        if (!currentPart) currentPart = [];
        currentPart.push(ts.assign(ts.self("__retryable"), ts.bool(false)));
      }
      const processed = this.processStatement(stmt);
      if (!currentPart) currentPart = [];
      currentPart.push(processed);
      if (this._asyncBranchCheckNeeded) {
        branchKeys[result.length] = this._subStepPath.join("_");
        this._asyncBranchCheckNeeded = false;
      }
      this._sourceMapBuilder.record([...this._subStepPath], stmt.loc);
      this._subStepPath.pop();
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

    const statelogConfig = ts.obj({
      host: ts.str(cfg.log?.host || ""),
      apiKey: cfg.log?.apiKey
        ? ts.str(cfg.log.apiKey)
        : ts.binOp(ts.env("STATELOG_API_KEY"), "||", ts.str("")),
      projectId: ts.str(cfg.log?.projectId || ""),
      debugMode: ts.bool(cfg.log?.debugMode || false),
    });

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
    if (this.agencyConfig.checkpoints?.maxRestores !== undefined) {
      runtimeCtxArgs.maxRestores = ts.raw(
        String(this.agencyConfig.checkpoints.maxRestores),
      );
    }

    let runtimeCtx: TsNode = ts.statements([
      ts.constDecl(
        "__globalCtx",
        ts.new(ts.id("RuntimeContext"), [ts.obj(runtimeCtxArgs)]),
      ),
      ts.constDecl("graph", $(ts.runtime.globalCtx).prop("graph").done()),
    ]);

    if (this.agencyConfig.trace) {
      const traceFile = this.agencyConfig.traceFile
        || this.moduleId.replace(/\.agency$/, ".trace");
      runtimeCtx = ts.statements([
        runtimeCtx,
        ts.raw(renderTraceSetup.default({
          traceFile: JSON.stringify(traceFile),
          programId: JSON.stringify(this.moduleId),
        })),
      ]);
    }

    return renderImports.default({
      runtimeContextCode: printTs(runtimeCtx),
    });
  }

  private preprocess(): TsNode[] {
    const nodes: TsNode[] = [];
    this.programInfo.importedNodes.forEach((importNode) => {
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

    this.programInfo.importedNodes.forEach((importNode) => {
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

    for (const node of this.programInfo.graphNodes) {
      const args = node.parameters;
      const fnParams: {
        name: string;
        typeAnnotation?: string;
        defaultValue?: TsNode;
      }[] = [];
      if (args.length > 0) {
        for (const arg of args) {
          const typeHint = arg.typeHint ? formatTypeHint(arg.typeHint) : "any";
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
                }),
              ])
              .done(),
          ),
          { async: true, export: true },
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

    if (this.programInfo.graphNodes.map((n) => n.nodeName).includes("main")) {
      result.push(
        ts.if(
          ts.binOp(
            $(ts.id("process")).prop("argv").index(ts.num(1)).done(),
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
