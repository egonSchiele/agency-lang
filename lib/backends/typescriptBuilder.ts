import {
  AgencyComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  InterpolationSegment,
  Literal,
  PromptLiteral,
  PromptSegment,
  Scope,
  ScopeType,
  TypeAlias,
  TypeHint,
  TypeHintMap,
  VariableType,
} from "../types.js";

import {
  BUILTIN_FUNCTIONS,
  BUILTIN_TOOLS,
  BUILTIN_VARIABLES,
  TYPES_THAT_DONT_TRIGGER_NEW_PART,
} from "@/config.js";
import { SpecialVar } from "@/types/specialVar.js";
import { TimeBlock } from "@/types/timeBlock.js";
import { formatTypeHint } from "@/cli/util.js";
import * as renderSpecialVar from "../templates/backends/typescriptGenerator/specialVar.js";
import * as renderTime from "../templates/backends/typescriptGenerator/builtinFunctions/time.js";
import * as renderConditionalEdge from "../templates/backends/typescriptGenerator/conditionalEdge.js";
import * as renderFunctionDefinition from "../templates/backends/typescriptGenerator/functionDefinition.js";
import * as renderFunctionCallAssignment from "../templates/backends/typescriptGenerator/functionCallAssignment.js";
import * as renderInterruptAssignment from "../templates/backends/typescriptGenerator/interruptAssignment.js";
import * as renderInterruptReturn from "../templates/backends/typescriptGenerator/interruptReturn.js";
import * as renderGraphNode from "../templates/backends/typescriptGenerator/graphNode.js";
import * as renderImports from "../templates/backends/typescriptGenerator/imports.js";
import * as renderMessageThread from "../templates/backends/typescriptGenerator/messageThread.js";
import * as promptFunction from "../templates/backends/typescriptGenerator/promptFunction.js";
import * as renderRunNodeFunction from "../templates/backends/typescriptGenerator/runNodeFunction.js";
import * as renderStartNode from "../templates/backends/typescriptGenerator/startNode.js";
import * as renderTool from "../templates/backends/typescriptGenerator/tool.js";
import * as renderSkillPrompt from "@/templates/prompts/skill.js";

import { AccessChainElement, ValueAccess } from "../types/access.js";
import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
} from "../types/dataStructures.js";
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
import { ForLoop } from "../types/forLoop.js";
import { WhileLoop } from "../types/whileLoop.js";
import { escape, uniq, mergeDeep } from "../utils.js";
import {
  generateBuiltinHelpers,
  mapFunctionName,
} from "./typescriptGenerator/builtins.js";
import {
  DEFAULT_SCHEMA,
  mapTypeToZodSchema,
} from "./typescriptGenerator/typeToZodSchema.js";
import { AgencyConfig } from "@/config.js";
import { MessageThread } from "@/types/messageThread.js";
import { Skill } from "@/types/skill.js";
import path, { parse } from "path";
import {
  BinOpArgument,
  BinOpExpression,
  Operator,
  PRECEDENCE,
} from "@/types/binop.js";
import { expressionToString, getBaseVarName } from "@/utils/node.js";

import type { TsNode, TsObjectEntry, TsElseIf } from "../ir/tsIR.js";
import { ts, $ } from "../ir/builders.js";
import { printTs } from "../ir/prettyPrint.js";

const DEFAULT_PROMPT_NAME = "__promptVar";

export class TypeScriptBuilder {
  // Type system tracking
  private typeHints: TypeHintMap = {};
  private typeAliases: Record<string, VariableType> = {};
  private graphNodes: GraphNodeDefinition[] = [];

  // Output assembly
  private generatedStatements: TsNode[] = [];
  private generatedTypeAliases: TsNode[] = [];

  // Import tracking
  private importStatements: TsNode[] = [];
  private importedNodes: ImportNodeStatement[] = [];
  private importedTools: ImportToolStatement[] = [];

  // Function tracking
  private functionDefinitions: Record<string, FunctionDefinition> = {};
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

  // Function tracking for safe functions
  private safeFunctions: Record<string, boolean> = {};
  private importedFunctions: Record<string, boolean> = {};

  constructor(config?: AgencyConfig) {
    this.agencyConfig = mergeDeep(this.configDefaults(), config || {});
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

  private scopetoString(scope: ScopeType, varName?: string): string {
    if (varName && BUILTIN_VARIABLES.includes(varName)) {
      return "";
    }
    if (varName && this.loopVars.includes(varName)) {
      return "";
    }
    switch (scope) {
      case "global":
        return "__globalCtx.stateStack.globals";
      case "function":
      case "node":
        return "__stack.locals";
      case "args":
        return "__stack.args";
      case "imported":
        return "";
      default:
        throw new Error(`Unknown scope type: ${scope} for varName: ${varName}`);
    }
  }

  // ------- Lookup helpers -------

  private isImportedTool(functionName: string): boolean {
    return this.importedTools
      .map((node) => node.importedTools)
      .flat()
      .includes(functionName);
  }

  private isAgencyFunction(
    functionName: string,
    context: "valueAccess" | "functionArg" | "topLevelStatement",
  ): boolean {
    if (context === "valueAccess") {
      return false;
    }
    return (
      !!this.functionDefinitions[functionName] ||
      this.isImportedTool(functionName)
    );
  }

  private isGraphNode(functionName: string): boolean {
    return (
      this.graphNodes.map((n) => n.nodeName).includes(functionName) ||
      this.importedNodes
        .map((n) => n.importedNodes)
        .flat()
        .includes(functionName)
    );
  }

  private collectFunctionSignature(node: FunctionDefinition): void {
    this.functionDefinitions[node.functionName] = node;
  }

  private isImpureImportedFunction(functionName: string): boolean {
    return (
      !!this.importedFunctions[functionName] &&
      !this.safeFunctions[functionName]
    );
  }

  private containsImpureCall(node: AgencyNode): boolean {
    if (node.type === "functionCall") {
      if (this.isImpureImportedFunction(node.functionName)) {
        return true;
      }
    }
    if (node.type === "assignment" && node.value) {
      if (this.containsImpureCall(node.value as AgencyNode)) {
        return true;
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
        const funcDef = this.functionDefinitions[currentScope.functionName];
        if (funcDef && funcDef.returnType) {
          return funcDef.returnType;
        }
        return undefined;
      }
      case "node": {
        const graphNode = this.graphNodes.find(
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
    // Pass 1: Collect all type aliases
    for (const node of program.nodes) {
      if (node.type === "typeAlias") {
        this.processTypeAlias(node);
      }
    }

    // Pass 2: Collect all type hints
    for (const node of program.nodes) {
      if (node.type === "typeHint") {
        this.processTypeHint(node);
      }
    }

    // Pass 3: Collect all node names
    for (const node of program.nodes) {
      if (node.type === "graphNode") {
        this.processGraphNodeName(node);
      }
    }

    // Pass 4: Collect all node and tool imports
    for (const node of program.nodes) {
      if (node.type === "importNodeStatement") {
        this.importedNodes.push(node);
      } else if (node.type === "importToolStatement") {
        this.importedTools.push(node);
      }
    }

    // Pass 5: Generate code for tools
    for (const node of program.nodes) {
      if (node.type === "function") {
        this.generatedStatements.push(this.processTool(node));
        this.collectFunctionSignature(node);
      }
    }

    // Pass 7: Process all nodes and generate code
    for (const node of program.nodes) {
      const result = this.processNode(node);
      this.generatedStatements.push(result);
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

    sections.push(ts.statements(this.generatedStatements));

    const postprocessResult = this.postprocess();
    if (postprocessResult.trim() !== "") {
      sections.push(ts.raw(postprocessResult));
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
      case "prompt":
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
    this.typeAliases[node.aliasName] = node.aliasedType;
    return ts.empty();
  }

  private processTypeHint(node: TypeHint): TsNode {
    if (node.variableType.type === "typeAliasVariable") {
      if (!(node.variableType.aliasName in this.typeAliases)) {
        throw new Error(
          `Type alias '${node.variableType.aliasName}' not defined for variable '${node.variableName}'.`,
        );
      }
    }
    this.typeHints[node.variableName] = node.variableType;
    return ts.empty();
  }

  private processGraphNodeName(node: GraphNodeDefinition): void {
    this.graphNodes.push(node);
  }

  // ------- Proper IR node methods -------

  private processComment(node: AgencyComment): TsNode {
    return ts.comment(node.content);
  }

  private processAgencyObject(node: AgencyObject): TsNode {
    const entries = node.entries.map((entry): TsObjectEntry => {
      if ("type" in entry && entry.type === "splat") {
        return { spread: true, expr: this.processNode(entry.value) };
      }
      const kv = entry as AgencyObjectKV;
      const keyCode = kv.key.replace(/"/g, '\\"');
      return {
        spread: false,
        key: `"${keyCode}"`,
        value: this.processNode(kv.value),
      };
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
        return ts.scopedVar(literal.value, literal.scope!);
      }
      case "prompt":
        return ts.raw(
          this.processPromptLiteral(
            DEFAULT_PROMPT_NAME,
            this.getScopeReturnType(),
            literal,
          ),
        );
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
          if (callNode.kind === "call" && callNode.callee.kind === "identifier") {
            result = $(result).prop(callNode.callee.name).call(callNode.arguments).done();
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
    const body = ts.statements(node.thenBody.map((stmt) => this.processStatement(stmt)));

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
        body: ts.statements(current.thenBody.map((stmt) => this.processStatement(stmt))),
      });
      if (current.elseBody?.length === 1 && current.elseBody[0].type === "ifElse") {
        current = current.elseBody[0] as IfElse;
      } else {
        remainingElse = current.elseBody;
        current = undefined;
      }
    }

    if (remainingElse && remainingElse.length > 0) {
      elseBody = ts.statements(remainingElse.map((stmt) => this.processStatement(stmt)));
    }

    return ts.if(condition, body, elseIfs.length > 0 || elseBody ? { elseIfs, elseBody } : undefined);
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
      const startNode = args.length >= 2 ? this.processNode(args[0]) : ts.num(0);
      const endNode = args.length >= 2 ? this.processNode(args[1]) : this.processNode(args[0]);
      return ts.forC(
        ts.varDecl("let", node.itemVar, startNode),
        ts.binOp(ts.id(node.itemVar), "<", endNode),
        ts.postfix(ts.id(node.itemVar), "++"),
        body,
      );
    }

    const iterableNode = this.processNode(node.iterable);

    // Indexed form: for (item, index in collection)
    if (node.indexVar) {
      const indexedBody = ts.statements([
        ts.varDecl("const", node.itemVar, ts.index(iterableNode, ts.id(node.indexVar))),
        ...bodyStmts,
      ]);
      return ts.forC(
        ts.varDecl("let", node.indexVar, ts.num(0)),
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
        const test = caseItem.caseValue === "_" ? undefined : this.processNode(caseItem.caseValue);
        const body = ts.statements([this.processNode(caseItem.body), ts.break()]);
        return { test, body };
      });
    return ts.switch(this.processNode(node.expression), cases);
  }

  private processImportStatement(node: ImportStatement): TsNode {
    // Track safe and imported functions
    for (const nameType of node.importedNames) {
      if (nameType.type === "namedImport") {
        for (const name of nameType.importedNames) {
          this.importedFunctions[name] = true;
        }
        if (nameType.safeNames) {
          for (const safeName of nameType.safeNames) {
            this.safeFunctions[safeName] = true;
          }
        }
      }
    }

    const from = node.modulePath.replace(/\.agency$/, ".js");
    const imports = node.importedNames.map((nameType) => {
      switch (nameType.type) {
        case "namedImport":
          return ts.importDecl({ importKind: "named", names: nameType.importedNames, from });
        case "namespaceImport":
          return ts.importDecl({ importKind: "namespace", namespaceName: nameType.importedNames, from });
        case "defaultImport":
          return ts.importDecl({ importKind: "default", defaultName: nameType.importedNames, from });
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
        !this.functionDefinitions[toolName] &&
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
    if (this.graphNodes.map((n) => n.nodeName).includes(functionName)) {
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
      const tsType = mapTypeToZodSchema(typeHint, this.typeAliases);
      properties[param.name] = tsType;
    });
    let schema = "";
    for (const [key, value] of Object.entries(properties)) {
      schema += `"${key.replace(/"/g, '\\"')}": ${value}, `;
    }

    return ts.raw(
      renderTool.default({
        name: functionName,
        description: node.docString?.value || "No description provided.",
        schema: Object.keys(properties).length > 0 ? `{${schema}}` : "{}",
        parameters: JSON.stringify(parameters.map((p) => p.name)),
      }),
    );
  }

  private processFunctionDefinition(node: FunctionDefinition): TsNode {
    this.startScope({ type: "function", functionName: node.functionName });
    const { functionName, body, parameters } = node;
    const args = parameters.map((p) => p.name);
    const typedArgs = parameters.map((p) => {
      if (p.typeHint) {
        return `${p.name}: ${formatTypeHint(p.typeHint)}`;
      }
      return `${p.name}: any`;
    });

    const bodyCode = this.processBodyAsParts(body);

    this.endScope();
    const paramList = typedArgs.length > 0 ? typedArgs.join(", ") + ", " : "";
    const paramAssignments = args
      .map((arg) => `__stack.args["${arg}"] = ${arg};`)
      .join("\n    ");
    const argsObject = args.length > 0 ? `{ ${args.join(", ")} }` : "{}";
    return ts.raw(
      renderFunctionDefinition.default({
        functionName,
        paramList,
        paramAssignments,
        argsObject,
        functionBody: bodyCode.map(n => this.str(n)).join("\n"),
      }),
    );
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
      const tempVar = "__funcResult";
      const nodeContext = scope.type === "node";
      const returnBody = nodeContext
        ? ts.return(ts.obj([
            { spread: true, expr: ts.runtime.state },
            { spread: false, key: "data", value: ts.id(tempVar) },
          ]))
        : ts.return(ts.obj({ data: ts.id(tempVar) }));
      return ts.statements([
        ts.varDecl("const", tempVar, callNode),
        ts.if(ts.call(ts.id("isInterrupt"), [ts.id(tempVar)]), returnBody),
      ]);
    }

    return callNode;
  }

  private processFunctionCall(node: FunctionCall): TsNode {
    if (this.isGraphNode(node.functionName)) {
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
      const configObj = ts.obj({
        ctx: ts.runtime.ctx,
        threads: node.async ? ts.new(ts.id("ThreadStore")) : ts.runtime.threads,
        interruptData: ts.raw("__state?.interruptData"),
      });
      const call = ts.call(ts.id(functionName), [...argNodes, configObj]);
      return shouldAwait ? ts.await(call) : call;
    } else if (node.functionName === "system") {
      // __threads.active().push(smoltalk.systemMessage(msg))
      return $(ts.threads.active()).prop("push").call([
        $.id("smoltalk").prop("systemMessage").call(argNodes).done(),
      ]).done();
    } else {
      const call = ts.call(ts.id(functionName), argNodes);
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

    const targetNode = this.graphNodes.find((n) => n.nodeName === functionName);
    let dataNode: TsNode;
    if (targetNode && targetNode.parameters.length > 0) {
      const entries: Record<string, TsNode> = {};
      targetNode.parameters.forEach((p, i) => { entries[p.name] = argNodes[i]; });
      dataNode = ts.obj(entries);
    } else if (argNodes.length > 0) {
      dataNode = ts.call(
        ts.prop(ts.id("Object"), "fromEntries"),
        [ts.call(
          ts.prop(ts.id(`__${functionName}NodeParams`), "map"),
          [ts.raw(`(k, i) => [k, [${argNodes.map(n => this.str(n)).join(", ")}][i]]`)],
        )],
      );
    } else {
      dataNode = ts.obj({});
    }

    const goToArgs = ts.obj({
      messages: ts.prop(ts.runtime.stack, "messages"),
      ctx: ts.runtime.ctx,
      data: dataNode,
    });

    return ts.statements([
      ts.functionReturn(ts.call(ts.id("goToNode"), [ts.str(functionName), goToArgs])),
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
    const paramAssignments = parameters
      .map((p) => `__stack.args["${p.name}"] = __state.data.${p.name};`)
      .join("\n      ");

    return ts.raw(
      renderGraphNode.default({
        name: nodeName,
        body: bodyCode.map(n => this.str(n)).join("\n"),
        hasParam: parameters.length > 0,
        paramAssignments,
      }),
    );
  }

  private processReturnStatement(node: ReturnStatement): TsNode {
    if (this.isInsideGraphNode) {
      const valueNode = this.processNode(node.value);
      if (node.value.type === "functionCall" && this.isGraphNode(node.value.functionName)) {
        return valueNode;
      }
      return ts.nodeResult(valueNode);
    }

    const valueNode = this.processNode(node.value);
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
    } else if (node.value.type === "prompt") {
      return ts.statements([
        valueNode,
        ts.functionReturn(ts.prop(ts.runtime.self, DEFAULT_PROMPT_NAME)),
      ]);
    }
    return ts.functionReturn(valueNode);
  }

  private processAssignment(node: Assignment): TsNode {
    const { variableName, typeHint, value } = node;
    const scopeVar = this.scopetoString(node.scope!, variableName);
    const chainStr = this.renderAccessChain(node.accessChain);

    if (value.type === "prompt") {
      return ts.raw(this.processPromptLiteral(variableName, typeHint, value));
    } else if (
      value.type === "functionCall" &&
      value.functionName === "interrupt"
    ) {
      const interruptArgs = value.arguments
        .map((arg) => this.str(this.processNode(arg)))
        .join(", ");
      return ts.raw(
        renderInterruptAssignment.default({
          variableName: `${scopeVar}.${variableName}${chainStr}`,
          interruptArgs,
          nodeContext: this.getCurrentScope().type === "node",
        }),
      );
    } else if (value.type === "functionCall") {
      const code = this.str(this.processNode(value));
      return ts.raw(
        renderFunctionCallAssignment.default({
          variableName: `${scopeVar}.${variableName}${chainStr}`,
          functionCode: code.trim(),
          nodeContext: this.getCurrentScope().type === "node",
          globalScope: this.getCurrentScope().type === "global",
        }),
      );
    } else if (value.type === "timeBlock") {
      return this.processTimeBlock(value, variableName);
    } else if (value.type === "messageThread") {
      const varName = `${scopeVar}.${variableName}${chainStr}`;
      return this.processMessageThread(value, varName);
    } else {
      const lhs = this.buildAssignmentLhs(node.scope!, variableName, node.accessChain);
      return ts.assign(lhs, this.processNode(value));
    }
  }

  private renderAccessChain(chain?: AccessChainElement[]): string {
    if (!chain || chain.length === 0) return "";
    return chain
      .map((el) => {
        switch (el.kind) {
          case "property":
            return `.${el.name}`;
          case "index":
            return `[${this.str(this.processNode(el.index))}]`;
          case "methodCall":
            return `.${this.generateFunctionCallExpression(el.functionCall, "valueAccess")}`;
        }
      })
      .join("");
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
          const callNode = this.generateFunctionCallExpression(el.functionCall, "valueAccess");
          if (callNode.kind === "call" && callNode.callee.kind === "identifier") {
            result = $(result).prop(callNode.callee.name).call(callNode.arguments).done();
          } else {
            result = ts.raw(`${this.str(result)}.${this.str(callNode)}`);
          }
          break;
        }
      }
    }
    return result;
  }

  private buildAssignmentLhs(scope: ScopeType, variableName: string, chain?: AccessChainElement[]): TsNode {
    return this.buildAccessChain(ts.scopedVar(variableName, scope), chain);
  }

  private processPromptLiteral(
    variableName: string,
    variableType: VariableType | undefined,
    node: PromptLiteral,
  ): string {
    const interpolatedVars = uniq(
      node.segments
        .filter((s) => s.type === "interpolation")
        .map((s) => getBaseVarName(s as InterpolationSegment)),
    );

    const functionCode = this.generatePromptFunction({
      variableName,
      variableType,
      functionArgs: interpolatedVars,
      prompt: node,
    });
    return functionCode;
  }

  private generatePromptFunction({
    variableName,
    variableType,
    functionArgs = [],
    prompt,
  }: {
    variableName: string;
    variableType: VariableType | undefined;
    functionArgs: string[];
    prompt: PromptLiteral;
  }): string {
    const _variableType = variableType ||
      this.typeHints[variableName] || {
        type: "primitiveType" as const,
        value: "string",
      };

    const zodSchema = mapTypeToZodSchema(_variableType, this.typeAliases);
    const clientConfig = prompt.config
      ? this.str(this.processNode(prompt.config))
      : "{}";

    const promptCode = this.buildPromptString({
      segments: prompt.segments,
      typeHints: this.typeHints,
      skills: prompt.skills || [],
    });
    const parts = [...functionArgs];
    parts.push("__metadata");
    const argsStr = parts.join(", ");
    let _tools = "";
    if (prompt.tools) {
      _tools = prompt.tools.toolNames.map((name) => `__${name}Tool`).join(", ");
    }
    const tools = _tools.length > 0 ? `[${_tools}]` : "undefined";

    const toolHandlerEntries = (
      prompt.tools || { type: "usesTool", toolNames: [] }
    ).toolNames.map((toolName) => {
      if (BUILTIN_TOOLS.includes(toolName)) {
        const internalName = BUILTIN_FUNCTIONS[toolName] || toolName;
        return `{ name: "${toolName}", params: __${toolName}ToolParams, execute: ${internalName}, isBuiltin: true }`;
      }
      if (
        !this.functionDefinitions[toolName] &&
        !this.isImportedTool(toolName)
      ) {
        throw new Error(
          `Tool '${toolName}' is being used but no function definition found for it. Make sure to define a function for this tool.`,
        );
      }

      return `{ name: "${toolName}", params: __${toolName}ToolParams, execute: ${toolName}, isBuiltin: false }`;
    });

    let threadExpr: string;
    if (this.parallelThreadVars[variableName]) {
      threadExpr = `__threads.get(${this.parallelThreadVars[variableName]})`;
    } else if (prompt.async) {
      threadExpr = `new MessageThread()`;
    } else {
      threadExpr = `__threads.getOrCreateActive()`;
    }
    const metadataObj = `{
      messages: ${threadExpr}
    }`;

    const scopedFunctionArgs = functionArgs.map((arg) => {
      const interpSegment = prompt.segments.find(
        (s) =>
          s.type === "interpolation" &&
          getBaseVarName(s as InterpolationSegment) === arg,
      ) as InterpolationSegment | undefined;
      if (!interpSegment) {
        return arg;
      }
      const baseExpr =
        interpSegment.expression.type === "variableName"
          ? interpSegment.expression
          : interpSegment.expression.base;
      return this.str(this.processNode(baseExpr));
    });

    return promptFunction.default({
      variableName,
      argsStr,
      funcCallParams: [...scopedFunctionArgs, metadataObj].join(", "),
      promptCode,
      hasResponseFormat: zodSchema !== DEFAULT_SCHEMA,
      zodSchema,
      tools,
      toolHandlers: toolHandlerEntries.join(", "),
      clientConfig,
      nodeContext: this.getCurrentScope().type === "node",
      isStreaming: prompt.isStreaming || false,
      isAsync: prompt.async || false,
      maxToolCallRounds: this.agencyConfig.maxToolCallRounds || 10,
    });
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
        renderSkillPrompt.default({
          skills: skillsArr.join("\n"),
        }),
      );
    }

    return "`" + promptParts.join("") + "`";
  }

  private processSpecialVar(node: SpecialVar): TsNode {
    const value = this.str(this.processNode(node.value));
    switch (node.name) {
      case "model":
        return ts.raw(
          renderSpecialVar.default({
            name: "model",
            value,
          }),
        );
      case "messages":
        return $(ts.threads.active()).prop("setMessages").call([this.processNode(node.value)]).done();
      default:
        throw new Error(`Unhandled SpecialVar name: ${node.name}`);
    }
  }

  private processTimeBlock(node: TimeBlock, timingVarName: string): TsNode {
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.str(this.processNode(stmt)));
    }
    const bodyCodeStr = bodyCodes.join("\n");
    return ts.raw(
      renderTime.default({
        timingVarName,
        bodyCodeStr,
        printTime: node.printTime || false,
      }),
    );
  }

  private processMessageThread(node: MessageThread, varName?: string): TsNode {
    if (node.threadType === "parallel") {
      return this.processParallelThread(node, varName);
    }

    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.str(this.processNode(stmt)));
    }
    const bodyCodeStr = bodyCodes.join("\n");

    return ts.raw(
      renderMessageThread.default({
        bodyCode: bodyCodeStr,
        hasVar: !!varName,
        varName,
        isSubthread: node.threadType === "subthread",
      }),
    );
  }

  private processParallelThread(node: MessageThread, varName?: string): TsNode {
    const stmts: TsNode[] = [];

    const assignmentVarNames: [string, ScopeType][] = [];
    for (const stmt of node.body) {
      if (stmt.type === "assignment" && stmt.value.type === "prompt") {
        assignmentVarNames.push([stmt.variableName, stmt.scope!]);
      }
    }

    for (const [name] of assignmentVarNames) {
      const threadVarName = `__ptid_${name}`;
      stmts.push(ts.varDecl("const", threadVarName, ts.threads.create()));
      this.parallelThreadVars[name] = threadVarName;
    }

    for (const stmt of node.body) {
      stmts.push(this.processNode(stmt));
    }

    const scopedVarNodes = assignmentVarNames.map(
      ([name, scope]) => ts.scopedVar(name, scope),
    );

    stmts.push(ts.assign(
      ts.arr(scopedVarNodes),
      $.id("Promise").prop("all").call([ts.arr(scopedVarNodes)]).await().done(),
    ));

    if (varName) {
      const entries: TsObjectEntry[] = assignmentVarNames.map(([name]) => ({
        spread: false,
        key: name,
        value: ts.call(
          ts.prop(ts.threads.get(ts.id(this.parallelThreadVars[name])), "cloneMessages"),
        ),
      }));
      stmts.push(ts.assign(ts.raw(varName), ts.obj(entries)));
    }

    for (const [name] of assignmentVarNames) {
      delete this.parallelThreadVars[name];
    }

    // Bare block for scoping the const declarations
    return ts.raw(`{\n${stmts.map(s => this.str(s)).join("\n")}\n}`);
  }

  private processBodyAsParts(body: AgencyNode[]): TsNode[] {
    const parts: TsNode[][] = [[]];
    for (const stmt of body) {
      if (!TYPES_THAT_DONT_TRIGGER_NEW_PART.includes(stmt.type)) {
        parts.push([]);
      }
      if (this.containsImpureCall(stmt)) {
        parts[parts.length - 1].push(ts.assign(ts.prop(ts.runtime.self, "__retryable"), ts.bool(false)));
      }
      parts[parts.length - 1].push(this.processStatement(stmt));
    }
    return parts.map((part, i) => ts.stepBlock(i, ts.statements(part)));
  }

  // ------- Imports and pre/post processing -------

  private generateBuiltins(): string {
    return generateBuiltinHelpers(this.functionsUsed);
  }

  private generateImports(): string {
    return renderImports.default({
      logHost: this.agencyConfig.log?.host || "",
      logProjectId: this.agencyConfig.log?.projectId || "",
      hasApiKey: !!this.agencyConfig.log?.apiKey,
      logApiKey: this.agencyConfig.log?.apiKey || undefined,
      logDebugMode: this.agencyConfig.log?.debugMode || false,
      clientLogLevel: this.agencyConfig.client?.logLevel || "warn",
      clientDefaultModel:
        this.agencyConfig.client?.defaultModel || "gpt-4o-mini",
      hasOpenAiApiKey: !!this.agencyConfig.client?.openAiApiKey,
      clientOpenAiApiKey: this.agencyConfig.client?.openAiApiKey || undefined,
      hasGoogleApiKey: !!this.agencyConfig.client?.googleApiKey,
      clientGoogleApiKey: this.agencyConfig.client?.googleApiKey || undefined,
      clientStatelogHost: this.agencyConfig.client?.statelog?.host || "",
      clientStatelogProjectId:
        this.agencyConfig.client?.statelog?.projectId || "",
    });
  }

  private preprocess(): TsNode[] {
    const nodes: TsNode[] = [];
    this.importedNodes.forEach((importNode) => {
      const from = importNode.agencyFile.replace(".agency", ".js");
      const defaultImportName = this.agencyFileToDefaultImportName(
        importNode.agencyFile,
      );
      nodes.push(ts.importDecl({ importKind: "default", defaultName: defaultImportName, from }));
      const nodeParamNames = importNode.importedNodes.map((name) => `__${name}NodeParams`);
      nodes.push(ts.importDecl({ importKind: "named", names: nodeParamNames, from }));
    });
    return nodes;
  }

  private postprocess(): string {
    const lines: string[] = [];
    Object.keys(this.adjacentNodes).forEach((node) => {
      const adjacent = this.adjacentNodes[node];
      if (adjacent.length === 0) {
        return;
      }
      lines.push(
        renderConditionalEdge.default({
          fromNode: node,
          toNodes: JSON.stringify(adjacent),
        }),
      );
    });

    this.importedNodes.forEach((importNode) => {
      const defaultImportName = this.agencyFileToDefaultImportName(
        importNode.agencyFile,
      );
      lines.push(`graph.merge(${defaultImportName});`);
    });

    for (const node of this.graphNodes) {
      const args = node.parameters;
      const argsStr = args.map((arg) => arg.name).join(", ");
      const typedArgsStr = args
        .map((arg) => {
          if (arg.typeHint) {
            return `${arg.name}: ${formatTypeHint(arg.typeHint)}`;
          }
          return `${arg.name}: any`;
        })
        .join(", ");
      lines.push(
        renderRunNodeFunction.default({
          nodeName: node.nodeName,
          hasArgs: args.length > 0,
          argsStr,
          typedArgsStr,
        }),
      );
      const paramNames = args.map((arg) => `"${arg.name}"`).join(", ");
      lines.push(
        `export const __${node.nodeName}NodeParams = [${paramNames}];`,
      );
    }

    if (this.graphNodes.map((n) => n.nodeName).includes("main")) {
      lines.push(
        renderStartNode.default({
          startNode: "main",
        }),
      );
    }

    lines.push("export default graph;");

    return lines.join("\n");
  }
}
