import {
  AgencyComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  AwaitPending,
  InterpolationSegment,
  Literal,
  PromptSegment,
  Scope,
  ScopeType,
  TypeAlias,
  TypeHint,
  TypeHintMap,
  VariableType,
} from "../types.js";

import { formatTypeHint } from "@/cli/util.js";
import {
  BUILTIN_FUNCTIONS,
  BUILTIN_TOOLS,
  BUILTIN_VARIABLES,
  TYPES_THAT_DONT_TRIGGER_NEW_PART,
} from "@/config.js";
import { SpecialVar } from "@/types/specialVar.js";
import { TimeBlock } from "@/types/timeBlock.js";
import * as renderImports from "../templates/backends/typescriptGenerator/imports.js";
import * as renderInterruptAssignment from "../templates/backends/typescriptGenerator/interruptAssignment.js";
import * as renderInterruptReturn from "../templates/backends/typescriptGenerator/interruptReturn.js";

import { AgencyConfig } from "@/config.js";
import {
  BinOpArgument,
  BinOpExpression,
  Operator,
  PRECEDENCE,
} from "@/types/binop.js";
import { MessageThread } from "@/types/messageThread.js";
import { Skill } from "@/types/skill.js";
import {
  expressionToString,
  getBaseVarName,
  walkNodesArray,
} from "@/utils/node.js";
import path from "path";
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
import { escape, mergeDeep, uniq } from "../utils.js";
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
import { auditNode, makeAuditCall } from "../ir/audit.js";
import type {
  TsElseIf,
  TsNode,
  TsObjectEntry,
  TsParam,
  TsStepBlock,
} from "../ir/tsIR.js";
import type { ProgramInfo } from "../programInfo.js";
import { getVisibleTypes, lookupType, scopeKey } from "../programInfo.js";

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
  private parallelThreadVars: Record<string, string> = {};
  private loopVars: string[] = [];
  private insideMessageThread: boolean = false;
  private _asyncBranchCheckNeeded: boolean = false;
  private _currentStepIndex: number = 0;


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

  private getTypeHint(varName: string): VariableType | undefined {
    return lookupType(
      this.programInfo.typeHints,
      this.currentScopeKey(),
      varName,
    );
  }

  private getVisibleTypeAliases(): Record<string, VariableType> {
    return getVisibleTypes(
      this.programInfo.typeAliases,
      this.currentScopeKey(),
    );
  }

  private getVisibleTypeHints(): TypeHintMap {
    return getVisibleTypes(this.programInfo.typeHints, this.currentScopeKey());
  }

  private isImportedTool(functionName: string): boolean {
    return this.programInfo.importedTools
      .map((node) => node.importedTools)
      .flat()
      .includes(functionName);
  }

  // Runtime functions that need __state (ctx injection) like user-defined agency functions.
  // These are imported from the runtime but need the functionCallConfig passed as the last arg.
  private static RUNTIME_STATEFUL_FUNCTIONS = ["checkpoint", "getCheckpoint", "restore"];

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

    return ts.statements(sections);
  }

  // ------- Node dispatch -------

  private processNode(node: AgencyNode): TsNode {
    switch (node.type) {
      case "typeHint":
        return this.processTypeHint(node);
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
        return this.processMatchBlock(node);
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
        return this.processForLoop(node);
      case "whileLoop":
        return this.processWhileLoop(node);
      case "ifElse":
        return this.processIfElse(node);
      case "specialVar":
        return this.processSpecialVar(node);
      case "timeBlock":
        return this.processTimeBlock(node, `__defaultTimeblockName`);
      case "newLine":
        return ts.empty();
      case "rawCode":
        return ts.raw(node.value);
      case "awaitPending":
        return this.processAwaitPending(node);
      case "messageThread":
        return this.processMessageThread(node);
      case "skill":
        return ts.empty();
      case "binOpExpression":
        return this.processBinOpExpression(node);
      case "keyword":
        return node.value === "break" ? ts.break() : ts.continue();
      default:
        throw new Error(`Unhandled Agency node type: ${(node as any).type}`);
    }
  }

  // ------- Type system (side effects only) -------

  private processTypeAlias(node: TypeAlias): TsNode {
    return ts.raw(
      `type ${node.aliasName} = ${formatTypeHint(node.aliasedType)};`,
    );
  }

  private processTypeHint(_node: TypeHint): TsNode {
    return ts.empty();
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
    }
  }

  private generateStringLiteralNode(segments: PromptSegment[]): TsNode {
    const parts: import("../ir/tsIR.js").TsTemplatePart[] = [];

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
    const leftNode = this.processNode(node.left);
    const rightNode = this.processNode(node.right);
    return ts.binOp(leftNode, node.operator, rightNode, {
      parenLeft: this.needsParensLeft(node.left, node.operator),
      parenRight: this.needsParensRight(node.right, node.operator),
    });
  }

  private processIfElse(node: IfElse): TsNode {
    const condition = this.processNode(node.condition);
    const body = ts.statements(
      node.thenBody.map((stmt) => this.processStatement(stmt)),
    );

    const elseIfs: TsElseIf[] = [];
    let elseBody: TsNode | undefined;

    // Flatten the else-if chain into elseIfs[], leaving only the final else as elseBody
    let current: IfElse | undefined =
      node.elseBody?.length === 1 && node.elseBody[0].type === "ifElse"
        ? (node.elseBody[0] as IfElse)
        : undefined;
    let remainingElse = current ? undefined : node.elseBody;

    while (current) {
      elseIfs.push({
        condition: this.processNode(current.condition),
        body: ts.statements(
          current.thenBody.map((stmt) => this.processStatement(stmt)),
        ),
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
      elseBody = ts.statements(
        remainingElse.map((stmt) => this.processStatement(stmt)),
      );
    }

    return ts.if(
      condition,
      body,
      elseIfs.length > 0 || elseBody ? { elseIfs, elseBody } : undefined,
    );
  }

  private processForLoop(node: ForLoop): TsNode {
    // Register loop variables so they bypass scope resolution
    this.loopVars.push(node.itemVar);
    if (node.indexVar) {
      this.loopVars.push(node.indexVar);
    }

    const bodyStmts = node.body.map((stmt) => this.processStatement(stmt));
    const body = ts.statements(bodyStmts);

    // Unregister loop variables
    this.loopVars = this.loopVars.filter(
      (v) => v !== node.itemVar && v !== node.indexVar,
    );

    // Range form: for (i in range(start, end))
    if (
      node.iterable.type === "functionCall" &&
      node.iterable.functionName === "range"
    ) {
      const args = node.iterable.arguments;
      const startNode =
        args.length >= 2 ? this.processNode(args[0]) : ts.num(0);
      const endNode =
        args.length >= 2
          ? this.processNode(args[1])
          : this.processNode(args[0]);
      return ts.forC(
        ts.letDecl(node.itemVar, startNode),
        ts.binOp(ts.id(node.itemVar), "<", endNode),
        ts.postfix(ts.id(node.itemVar), "++"),
        body,
      );
    }

    const iterableNode = this.processNode(node.iterable);

    // Indexed form: for (item, index in collection)
    if (node.indexVar) {
      const indexedBody = ts.statements([
        ts.varDecl(
          "const",
          node.itemVar,
          ts.index(iterableNode, ts.id(node.indexVar)),
        ),
        ...bodyStmts,
      ]);
      return ts.forC(
        ts.letDecl(node.indexVar, ts.num(0)),
        ts.binOp(ts.id(node.indexVar), "<", ts.prop(iterableNode, "length")),
        ts.postfix(ts.id(node.indexVar), "++"),
        indexedBody,
      );
    }

    // Basic form: for (item in collection)
    return ts.forOf(node.itemVar, iterableNode, body);
  }

  private processWhileLoop(node: WhileLoop): TsNode {
    return ts.while(
      this.processNode(node.condition),
      ts.statements(node.body.map((stmt) => this.processStatement(stmt))),
    );
  }

  private processMatchBlock(node: MatchBlock): TsNode {
    const cases = node.cases
      .filter((c) => c.type !== "comment")
      .map((c) => {
        const caseItem = c as MatchBlockCase;
        const test =
          caseItem.caseValue === "_"
            ? undefined
            : this.processNode(caseItem.caseValue);
        const body = ts.statements([
          this.processNode(caseItem.body),
          ts.break(),
        ]);
        return { test, body };
      });
    return ts.switch(this.processNode(node.expression), cases);
  }

  private processImportStatement(node: ImportStatement): TsNode {
    const from = node.modulePath.replace(/\.agency$/, ".js");
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
    const importNames = node.importedTools
      .map((toolName) => [
        toolName,
        `__${toolName}Tool`,
        `__${toolName}ToolParams`,
      ])
      .flat();
    return ts.importDecl({
      importKind: "named",
      names: importNames,
      from: node.agencyFile.replace(/\.agency$/, ".js"),
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
      const tsType = mapTypeToZodSchema(typeHint, this.getVisibleTypeAliases());
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
    const importedToolNames = this.programInfo.importedTools.flatMap(
      (node) => node.importedTools,
    );
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

  private processFunctionDefinition(node: FunctionDefinition): TsNode {
    this.startScope({ type: "function", functionName: node.functionName });
    const { functionName, body, parameters } = node;
    const args = parameters.map((p) => p.name);

    const bodyCode = this.processBodyAsParts(body, {
      isInSafeFunction: !!node.safe,
    });
    this.endScope();

    // Build function params: typed args + __state
    const fnParams: TsParam[] = parameters.map((p) => ({
      name: p.name,
      typeAnnotation: p.typeHint ? formatTypeHint(p.typeHint) : "any",
    }));
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
      $(ts.runtime.ctx)
        .prop("audit")
        .call([
          ts.obj({
            type: ts.str("functionCall"),
            functionName: ts.str(functionName),
            args: ts.obj(argsObj),
            result: ts.id("undefined"),
          }),
        ])
        .await()
        .done(),
    ];

    // Param assignments to stack
    for (const arg of args) {
      setupStmts.push(
        ts.assign($(ts.stack("args")).index(ts.str(arg)).done(), ts.id(arg)),
      );
    }

    // __self.__retryable
    setupStmts.push(
      ts.assign(
        ts.self("__retryable"),
        ts.binOp(ts.self("__retryable"), "??", ts.bool(true)),
      ),
    );

    // Scope marker for awaitScope — used by interrupt templates to await
    // only the promises created in this function's scope
    setupStmts.push(
      ts.constDecl("__scopeMarker", ts.raw("__ctx.pendingPromises.scopeMarker()")),
    );

    // Try/catch wrapping the body, with finally to always pop the state stack
    setupStmts.push(
      ts.tryCatch(
        ts.statements(bodyCode),
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
          ts.throw(
            "new ToolCallError(__error, { retryable: __self.__retryable })",
          ),
        ]),
        "__error",
        ts.raw("if (!__state?.isForked && !__stack.hasChildInterrupts && !__stack.interrupted) { __setupData.stateStack.pop() }"),
      ),
    );

    // onFunctionEnd hook
    setupStmts.push(
      ts.callHook("onFunctionEnd", {
        functionName: ts.str(functionName),
        timeTaken: $(ts.id("performance"))
          .prop("now")
          .call()
          .minus(ts.id("__funcStartTime"))
          .done(),
      }),
    );

    return ts.functionDecl(functionName, fnParams, ts.statements(setupStmts), {
      async: true,
      export: true,
    });
  }

  private processStatement(node: AgencyNode): TsNode {
    if (node.type === "functionCall") {
      return this.processFunctionCallAsStatement(node);
    }
    return this.processNode(node);
  }

  private processFunctionCallAsStatement(node: FunctionCall): TsNode {
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
        if (this.isAgencyFunction(node.functionName, "topLevelStatement") && !this.isGraphNode(node.functionName)) {
          const callWithStack = this.generateFunctionCallExpression(node, "topLevelStatement", { stateStack: ts.raw("__forked") });
          this._asyncBranchCheckNeeded = true;
          const branchKey = this._currentStepIndex;
          return ts.statements([
            ts.raw(`let __forked`),
            ts.raw(`if (__stack.branches && __stack.branches[${branchKey}]) {\n  __forked = __stack.branches[${branchKey}].stack;\n  __forked.deserializeMode();\n} else {\n  __forked = __ctx.forkStack();\n}`),
            ts.raw(`__stack.branches = __stack.branches || {}`),
            ts.raw(`__stack.branches[${branchKey}] = { stack: __forked }`),
            ts.raw(`__ctx.pendingPromises.add(${this.str(callWithStack)})`),
          ]);
        }
        return ts.raw(
          `__ctx.pendingPromises.add(${this.str(callNode)})`,
        );
      }

      // Sync calls: check for interrupt result
      const tempVar = "__funcResult";
      const nodeContext = scope.type === "node";
      const returnBody = nodeContext
        ? ts.obj([
            ts.setSpread(ts.runtime.state),
            ts.set("data", ts.id(tempVar)),
          ])
        : ts.obj({ data: ts.id(tempVar) });
      return ts.statements([
        ts.constDecl(tempVar, callNode),
        ts.if(
          ts.call(ts.id("isInterrupt"), [ts.id(tempVar)]),
          ts.statements([
            ts.return(returnBody),
          ]),
        ),
      ]);
    }

    return callNode;
  }

  private processFunctionCall(node: FunctionCall): TsNode {
    if (node.functionName === "throw") {
      // throw("message") → throw new Error("message")
      const argNodes: TsNode[] = node.arguments.map((arg) =>
        this.processNode(arg),
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
      // Emit functionCall audit for built-in functions.
      // User-defined functions get their audit at function entry in processFunctionDefinition.
      // We don't log arg values here to avoid re-evaluating side-effecting expressions.
      const auditCall = makeAuditCall("functionCall", {
        functionName: ts.str(node.functionName),
        args: ts.obj({}),
        result: ts.id("undefined"),
      });
      return ts.statements([auditCall, ts.await(callNode)]);
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
    const argNodes: TsNode[] = node.arguments.map((arg) => {
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        return this.generateFunctionCallExpression(arg, "functionArg");
      } else {
        return this.processNode(arg);
      }
    });
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

  private generateNodeCallExpression(node: FunctionCall): TsNode {
    const functionName = mapFunctionName(node.functionName);
    const argNodes: TsNode[] = node.arguments.map((arg) => {
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        return this.generateFunctionCallExpression(arg, "functionArg");
      } else {
        return this.processNode(arg);
      }
    });

    const targetNode = this.programInfo.graphNodes.find(
      (n) => n.nodeName === functionName,
    );
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

      ts.constDecl("__scopeMarker", ts.raw("__ctx.pendingPromises.scopeMarker()")),

      ts.callHook("onNodeStart", { nodeName: ts.str(nodeName) }),
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

    // Body
    stmts.push(...bodyCode);

    // onNodeEnd hook + return
    stmts.push(
      ts.callHook("onNodeEnd", {
        nodeName: ts.str(nodeName),
        data: ts.id("undefined"),
      }),
    );
    stmts.push(
      ts.return(
        ts.obj({
          messages: ts.runtime.threads,
          data: ts.id("undefined"),
        }),
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
    if (this.isInsideGraphNode) {
      if (
        node.value.type === "functionCall" &&
        node.value.functionName === "interrupt"
      ) {
        const interruptArgs = node.value.arguments
          .map((arg) => this.str(this.processNode(arg)))
          .join(", ");
        return ts.raw(
          renderInterruptReturn.default({
            interruptArgs,
            nodeContext: true,
          }),
        );
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
      const interruptArgs = node.value.arguments
        .map((arg) => this.str(this.processNode(arg)))
        .join(", ");
      return ts.raw(
        renderInterruptReturn.default({
          interruptArgs,
          nodeContext: this.getCurrentScope().type === "node",
        }),
      );
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
        .map((arg) => this.str(this.processNode(arg)))
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
            "__ir.value",
          ),
          assignApprove: makeAssign("true"),
          assignReject: makeAssign("false"),
          interruptArgs,
          nodeContext: this.getCurrentScope().type === "node",
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
        if (this.isAgencyFunction(value.functionName, "topLevelStatement") && !this.isGraphNode(value.functionName)) {
          this._asyncBranchCheckNeeded = true;
          const branchKey = this._currentStepIndex;
          stmts.unshift(
            ts.raw(`let __forked`),
            ts.raw(`if (__stack.branches && __stack.branches[${branchKey}]) {\n  __forked = __stack.branches[${branchKey}].stack;\n  __forked.deserializeMode();\n} else {\n  __forked = __ctx.forkStack();\n}`),
            ts.raw(`__stack.branches = __stack.branches || {}`),
            ts.raw(`__stack.branches[${branchKey}] = { stack: __forked }`),
          );
          stmts[stmts.length - 1] = this.scopedAssign(
            node.scope!,
            variableName,
            this.generateFunctionCallExpression(value, "topLevelStatement", { stateStack: ts.raw("__forked") }),
            node.accessChain,
          );
        }

        // Async: register with pending promise store, store the key, skip interrupt check
        const pendingKeyVar = `__pendingKey_${variableName}`;
        stmts.push(
          ts.assign(
            ts.self(pendingKeyVar),
            ts.raw(`__ctx.pendingPromises.add(${this.str(varRef)}, (val) => { ${this.str(varRef)} = val; })`),
          ),
        );
      } else if (this.getCurrentScope().type !== "global") {
        // Sync: interrupt check — return immediately, runNode's awaitAll handles the rest
        const returnObj =
          this.getCurrentScope().type === "node"
            ? ts.obj([ts.setSpread(ts.runtime.state), ts.set("data", varRef)])
            : ts.obj({ data: varRef });
        stmts.push(
          ts.if(
            $(ts.id("isInterrupt")).call([varRef]).done(),
            ts.return(returnObj),
          ),
        );
      }
      return ts.statements(stmts);
    } else if (value.type === "timeBlock") {
      return this.processTimeBlock(value, variableName);
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
    const _variableType = variableType ||
      this.getTypeHint(variableName) || {
        type: "primitiveType" as const,
        value: "string",
      };

    const zodSchema = mapTypeToZodSchema(
      _variableType,
      this.getVisibleTypeAliases(),
    );

    // Extract prompt from first argument, using processNode to get scoped variable references
    const promptArg = node.arguments[0];
    const promptNode = promptArg ? this.processNode(promptArg) : ts.raw("``");

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
      clientConfig = this.processNode(configArg);
    } else {
      clientConfig = ts.obj({});
    }

    // Thread expression
    let threadExpr: TsNode;
    const isInFunction = this.getCurrentScope().type === "function";
    if (this.parallelThreadVars[variableName]) {
      threadExpr = ts.threads.get(ts.id(this.parallelThreadVars[variableName]));
    } else if (this.insideMessageThread || isInFunction) {
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
    runPromptEntries.interruptData = ts.raw("__self.__interruptId ? __ctx.getInterruptData(__self.__interruptId) : __state?.interruptData");
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
          ts.raw(`__ctx.pendingPromises.add(${this.str(varRef)}, (val) => { ${this.str(varRef)} = val; })`),
        ),
      );
    } else {
      // Sync: await + interrupt check
      stmts.push(ts.assign(varRef, ts.await(runPromptCall)));
      stmts.push(ts.comment("return early from node if this is an interrupt"));
      const isNodeContext = this.getCurrentScope().type === "node";
      const returnExpr = isNodeContext
        ? ts.nodeReturn({
            messages: ts.runtime.threads,
            data: varRef,
          })
        : ts.return(varRef);
      stmts.push(
        ts.if(
          $(ts.id("isInterrupt")).call([varRef]).done(),
          ts.statements([
            ts.raw(`__self.__interruptId = ${this.str(varRef)}.interrupt_id`),
            returnExpr,
          ]),
        ),
      );
    }

    return ts.statements(stmts);
  }

  private buildPromptString({
    segments,
    typeHints,
    skills,
  }: {
    segments: PromptSegment[];
    typeHints: TypeHintMap;
    skills: Skill[];
  }): string {
    const promptParts: string[] = [];

    for (const segment of segments) {
      if (segment.type === "text") {
        const escaped = escape(segment.value);
        promptParts.push(escaped);
      } else {
        const exprStr = expressionToString(segment.expression);
        const baseVarName = getBaseVarName(segment);
        const varType = typeHints[baseVarName];

        if (varType && varType.type === "arrayType") {
          promptParts.push(`\${JSON.stringify(${exprStr})}`);
        } else {
          promptParts.push(`\${${exprStr}}`);
        }
      }
    }

    if (skills.length > 0) {
      const skillsArr = skills.map((skill) => {
        const skillName = path.basename(
          skill.filepath,
          path.extname(skill.filepath),
        );
        if (skill.description) {
          return `- ${skillName} (filepath: ${skill.filepath}): ${skill.description}`;
        } else {
          return `- ${skillName} (filepath: ${skill.filepath})`;
        }
      });

      promptParts.push(
        `\nYou can also read a skill file to augment your capabilities for a specific task using the "readSkill" tool. This allows you to access specialized knowledge and instructions that are relevant to particular scenarios.\n\n\nAvailable skills:\n${skillsArr.join("\n")}`,
      );
    }

    return "`" + promptParts.join("") + "`";
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

  private processTimeBlock(node: TimeBlock, timingVarName: string): TsNode {
    const bodyNodes = node.body.map((stmt) => this.processNode(stmt));
    const stmts: TsNode[] = [
      ts.time(`${timingVarName}_startTime`),
      ...bodyNodes,
      ts.time(`${timingVarName}_endTime`),
      ts.letDecl(
        timingVarName,
        $(ts.id(`${timingVarName}_endTime`))
          .minus(ts.id(`${timingVarName}_startTime`))
          .done(),
        "number",
      ),
    ];
    if (node.printTime) {
      stmts.push(ts.str("Time taken:"), ts.id(timingVarName), ts.str("ms"));
    }
    return ts.statements(stmts);
  }

  private processAwaitPending(node: AwaitPending): TsNode {
    const stmts: TsNode[] = [];

    // 1. Generate the awaitPending call — returns true if any resolved to an interrupt
    const keyArray = node.variables.map((v) => `__self.__pendingKey_${v.name}`).join(", ");
    stmts.push(ts.raw(`const __hasInterrupts = await __ctx.pendingPromises.awaitPending([${keyArray}])`));

    // 2. If there are interrupts, stop executing this function body.
    //    Set hasChildInterrupts so the finally block won't pop the frame.
    //    The interrupts stay in the flat PendingPromiseStore for awaitAll() to collect.
    const scope = this.getCurrentScope();
    const returnValue =
      scope.type === "node"
        ? ts.obj([ts.setSpread(ts.runtime.state), ts.set("data", ts.raw("undefined"))])
        : ts.raw("undefined");
    stmts.push(
      ts.if(
        ts.id("__hasInterrupts"),
        ts.statements([
          ts.raw("__stack.hasChildInterrupts = true"),
          ts.return(returnValue),
        ]),
      ),
    );

    return ts.statements(stmts);
  }

  private processMessageThread(
    node: MessageThread,
    assignTo?: Assignment,
  ): TsNode {
    if (node.threadType === "parallel") {
      return this.processParallelThread(node, assignTo);
    }

    const prevInsideMessageThread = this.insideMessageThread;
    this.insideMessageThread = true;
    const bodyNodes = node.body.map((stmt) => this.processNode(stmt));
    this.insideMessageThread = prevInsideMessageThread;
    const createMethod =
      node.threadType === "subthread" ? "createSubthread" : "create";
    const stmts: TsNode[] = [
      ts.varDecl(
        "const",
        "__tid",
        $(ts.runtime.threads).prop(createMethod).call().done(),
      ),
      $(ts.runtime.threads)
        .prop("pushActive")
        .call([ts.id("__tid")])
        .done(),
      ...bodyNodes,
    ];
    if (assignTo) {
      stmts.push(
        this.scopedAssign(
          assignTo.scope!,
          assignTo.variableName,
          $(ts.threads.active()).prop("cloneMessages").call().done(),
          assignTo.accessChain,
        ),
      );
    }
    stmts.push($(ts.runtime.threads).prop("popActive").call().done());
    return ts.raw(`{\n${this.str(ts.statements(stmts))}\n}`);
  }

  private processParallelThread(
    node: MessageThread,
    assignTo?: Assignment,
  ): TsNode {
    const stmts: TsNode[] = [];

    const assignmentVarNames: [string, ScopeType][] = [];
    for (const stmt of node.body) {
      if (
        stmt.type === "assignment" &&
        stmt.value.type === "functionCall" &&
        stmt.value.functionName === "llm"
      ) {
        assignmentVarNames.push([stmt.variableName, stmt.scope!]);
      }
    }

    for (const [name] of assignmentVarNames) {
      const threadVarName = `__ptid_${name}`;
      stmts.push(ts.constDecl(threadVarName, ts.threads.create()));
      this.parallelThreadVars[name] = threadVarName;
    }

    for (const stmt of node.body) {
      stmts.push(this.processNode(stmt));
    }

    const scopedVarNodes = assignmentVarNames.map(([name, scope]) =>
      ts.scopedVar(name, scope, this.moduleId),
    );

    stmts.push(
      ts.assign(
        ts.arr(scopedVarNodes),
        $.id("Promise")
          .prop("all")
          .call([ts.arr(scopedVarNodes)])
          .await()
          .done(),
      ),
    );

    if (assignTo) {
      const entries: TsObjectEntry[] = assignmentVarNames.map(([name]) => ({
        spread: false,
        key: name,
        value: ts.call(
          ts.prop(
            ts.threads.get(ts.id(this.parallelThreadVars[name])),
            "cloneMessages",
          ),
        ),
      }));
      stmts.push(
        this.scopedAssign(
          assignTo.scope!,
          assignTo.variableName,
          ts.obj(entries),
          assignTo.accessChain,
        ),
      );
    }

    for (const [name] of assignmentVarNames) {
      delete this.parallelThreadVars[name];
    }

    // Bare block for scoping the const declarations
    return ts.raw(`{\n${stmts.map((s) => this.str(s)).join("\n")}\n}`);
  }

  private processBodyAsParts(
    body: AgencyNode[],
    opts: { isInSafeFunction?: boolean } = {},
  ): TsStepBlock[] {
    const parts: TsNode[][] = [[]];
    const branchCheckParts = new Set<number>();
    for (const stmt of body) {
      if (!TYPES_THAT_DONT_TRIGGER_NEW_PART.includes(stmt.type)) {
        parts.push([]);
      }
      const currentPartIndex = parts.length - 1;
      this._currentStepIndex = currentPartIndex;
      if (!opts.isInSafeFunction && this.containsImpureCall(stmt)) {
        parts[parts.length - 1].push(
          ts.assign(ts.self("__retryable"), ts.bool(false)),
        );
      }
      const processed = this.processStatement(stmt);
      const audit = auditNode(processed);
      if (audit && audit.behavior === "replace") {
        parts[parts.length - 1].push(audit.node);
      } else {
        parts[parts.length - 1].push(processed);
        if (audit) {
          parts[parts.length - 1].push(audit.node);
        }
      }
      if (this._asyncBranchCheckNeeded) {
        branchCheckParts.add(currentPartIndex);
        this._asyncBranchCheckNeeded = false;
      }
    }
    return parts.map((part, i) => ts.stepBlock(i, ts.statements(part), branchCheckParts.has(i)));
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

    if (this.agencyConfig.audit?.logFile) {
      const logFile = this.agencyConfig.audit.logFile;
      runtimeCtx = ts.statements([
        runtimeCtx,
        ts.raw(`import { appendFileSync } from "fs";`),
        ts.raw(`const __auditLogFile = ${JSON.stringify(logFile)};`),
        ts.raw(
          `const __defaultonAuditLog = (entry) => { appendFileSync(__auditLogFile, JSON.stringify(entry) + "\\n"); };`,
        ),
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
                  callbacks: this.agencyConfig.audit?.logFile
                    ? ts.raw(
                        "{ onAuditLog: __defaultonAuditLog, ...callbacks }",
                      )
                    : ts.id("callbacks"),
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
