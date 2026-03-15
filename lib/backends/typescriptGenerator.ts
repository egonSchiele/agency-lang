import {
  AgencyComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  InterpolationSegment,
  Literal,
  PromptLiteral,
  PromptSegment,
  ScopeType,
  TypeAlias,
  TypeHint,
  TypeHintMap,
  VariableType,
} from "../types.js";

import {
  BUILTIN_FUNCTIONS,
  BUILTIN_TOOLS,
  TYPES_THAT_DONT_TRIGGER_NEW_PART,
} from "@/config.js";
import { SpecialVar } from "@/types/specialVar.js";
import { TimeBlock } from "@/types/timeBlock.js";
import { formatTypeHint } from "@/cli/util.js";
import * as renderSpecialVar from "../templates/backends/typescriptGenerator/specialVar.js";
import * as renderTime from "../templates/backends/typescriptGenerator/builtinFunctions/time.js";
// builtinTools now handled by runtime library
import * as renderConditionalEdge from "../templates/backends/typescriptGenerator/conditionalEdge.js";
import * as renderFunctionDefinition from "../templates/backends/typescriptGenerator/functionDefinition.js";
import * as renderInternalFunctionCall from "../templates/backends/typescriptGenerator/internalFunctionCall.js";
import * as renderFunctionCallAssignment from "../templates/backends/typescriptGenerator/functionCallAssignment.js";
import * as renderInterruptAssignment from "../templates/backends/typescriptGenerator/interruptAssignment.js";
import * as renderInterruptReturn from "../templates/backends/typescriptGenerator/interruptReturn.js";
import * as goToNode from "../templates/backends/typescriptGenerator/goToNode.js";
import * as renderGraphNode from "../templates/backends/typescriptGenerator/graphNode.js";
import * as renderImports from "../templates/backends/typescriptGenerator/imports.js";
import * as renderMessageThread from "../templates/backends/typescriptGenerator/messageThread.js";
import * as promptFunction from "../templates/backends/typescriptGenerator/promptFunction.js";
import * as renderRunNodeFunction from "../templates/backends/typescriptGenerator/runNodeFunction.js";
import * as renderStartNode from "../templates/backends/typescriptGenerator/startNode.js";
import * as renderTool from "../templates/backends/typescriptGenerator/tool.js";
// toolCall template replaced by data-driven dispatch in runPrompt
import * as renderSkillPrompt from "@/templates/prompts/skill.js";
import * as renderBuiltinFunctionsSystem from "@/templates/backends/typescriptGenerator/builtinFunctions/system.js";

import { AccessChainElement, ValueAccess } from "../types/access.js";
import { AgencyArray, AgencyObject } from "../types/dataStructures.js";
import {
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
} from "../types/function.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { IfElse } from "../types/ifElse.js";
import {
  ImportNameType,
  ImportNodeStatement,
  ImportStatement,
  ImportToolStatement,
} from "../types/importStatement.js";
import { MatchBlock } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { UsesTool } from "../types/tools.js";
import { ForLoop } from "../types/forLoop.js";
import { WhileLoop } from "../types/whileLoop.js";
import { escape, uniq } from "../utils.js";
import { BaseGenerator } from "./baseGenerator.js";
import {
  generateBuiltinHelpers,
  mapFunctionName,
} from "./typescriptGenerator/builtins.js";
import {
  DEFAULT_SCHEMA,
  mapTypeToZodSchema,
} from "./typescriptGenerator/typeToZodSchema.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { AgencyConfig } from "@/config.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { printTs } from "../ir/prettyPrint.js";
import { MessageThread } from "@/types/messageThread.js";
import { Skill } from "@/types/skill.js";
import path from "path";
import { BinOpExpression } from "@/types/binop.js";
import { expressionToString, getBaseVarName } from "@/utils/node.js";
import { Keyword } from "@/types/keyword.js";

const DEFAULT_PROMPT_NAME = "__promptVar";

export class TypeScriptGenerator extends BaseGenerator {
  protected adjacentNodes: Record<string, string[]> = {};
  protected currentAdjacentNodes: string[] = [];
  protected isInsideGraphNode: boolean = false;
  private parallelThreadVars: Record<string, string> = {};
  private loopVars: string[] = [];
  protected safeFunctions: Record<string, boolean> = {};
  protected importedFunctions: Record<string, boolean> = {};

  constructor(args: { config?: AgencyConfig } = {}) {
    super(args);
  }

  configDefaults(): Partial<AgencyConfig> {
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

  protected generateBuiltins(): string {
    return generateBuiltinHelpers(this.functionsUsed);
  }

  protected processTypeAlias(node: TypeAlias): string {
    this.typeAliases[node.aliasName] = node.aliasedType;
    return "";
  }

  protected processTypeHint(node: TypeHint): string {
    if (node.variableType.type === "typeAliasVariable") {
      if (!(node.variableType.aliasName in this.typeAliases)) {
        throw new Error(
          `Type alias '${node.variableType.aliasName}' not defined for variable '${node.variableName}'.`,
        );
      }
    }
    this.typeHints[node.variableName] = node.variableType;
    return "";
  }

  protected processAgencyObject(node: AgencyObject): string {
    const kvCodes = node.entries.map((entry) => {
      if ("type" in entry && entry.type === "splat") {
        return `...${this.processNode(entry.value).trim()}`;
      }
      const kv = entry as import("../types/dataStructures.js").AgencyObjectKV;
      const keyCode = kv.key.replace(/"/g, '\\"');
      const valueCode = this.processNode(kv.value).trim();
      return `"${keyCode}": ${valueCode}`;
    });
    return `{${kvCodes.join(", ")}}`;
  }

  protected processAgencyArray(node: AgencyArray): string {
    const itemCodes = node.items.map((item) => {
      if (item.type === "splat") {
        return `...${this.processNode(item.value).trim()}`;
      }
      return this.processNode(item).trim();
    });
    return `[${itemCodes.join(", ")}]`;
  }

  protected processComment(node: AgencyComment): string {
    return `// ${node.content}\n`;
  }

  protected processMultiLineComment(): string {
    return "";
  }

  protected processGraphNodeName(node: GraphNodeDefinition): void {
    this.graphNodes.push(node);
  }

  protected processGraphNode(node: GraphNodeDefinition): string {
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

    return renderGraphNode.default({
      name: nodeName,
      body: bodyCode.join("\n"),
      hasParam: parameters.length > 0,
      paramAssignments,
    });
  }

  protected processReturnStatement(node: ReturnStatement): string {
    if (this.isInsideGraphNode) {
      const returnCode = this.processNode(node.value);
      if (node.value.type === "functionCall") {
        if (this.isGraphNode(node.value.functionName)) {
          // we're going to return a goToNode call, so just return that directly
          return returnCode;
        }
      }
      return `return { messages: __threads, data: ${returnCode}}\n`;
    }

    const returnCode = this.processNode(node.value);
    if (
      node.value.type === "functionCall" &&
      node.value.functionName === "interrupt"
    ) {
      /* special case for `return interrupt(...)` syntax */

      const interruptArgs = node.value.arguments
        .map((arg) => this.processNode(arg))
        .join(", ");
      return renderInterruptReturn.default({
        interruptArgs,
        nodeContext: this.getCurrentScope().type === "node",
      });
    } else if (node.value.type === "prompt") {
      // special case for `return llm(...)` syntax
      return `${returnCode}\n__ctx.stateStack.pop();\nreturn __self.${DEFAULT_PROMPT_NAME};\n`;
    }
    /* Pop the state off the stack, we won't be coming back.
    Doesn't matter if we update the step or not, since we won't be coming back here. */
    return `__ctx.stateStack.pop();\nreturn ${returnCode}\n`;
  }

  protected processValueAccess(node: ValueAccess): string {
    let code = this.processNode(node.base);
    for (const element of node.chain) {
      switch (element.kind) {
        case "property":
          code += `.${element.name}`;
          break;
        case "index":
          code += `[${this.processNode(element.index)}]`;
          break;
        case "methodCall":
          code += `.${this.generateFunctionCallExpression(element.functionCall, "valueAccess")}`;
          break;
      }
    }
    return code;
  }

  protected processMatchBlock(node: MatchBlock): string {
    let lines = [`switch (${this.processNode(node.expression)}) {`];

    for (const caseItem of node.cases) {
      if (caseItem.type === "comment") {
        lines.push(`  // ${caseItem.content}`);
        continue;
      } else if (caseItem.caseValue === "_") {
        lines.push(`  default:`);
      } else {
        const caseValueCode = this.processNode(caseItem.caseValue);
        lines.push(`  case ${caseValueCode.trim()}:`);
      }
      const caseBodyCode = this.processNode(caseItem.body);
      lines.push(caseBodyCode);
      lines.push("    break;");
    }

    lines.push("}");
    return lines.join("\n");
  }

  private renderAccessChain(chain?: AccessChainElement[]): string {
    if (!chain || chain.length === 0) return "";
    return chain
      .map((el) => {
        switch (el.kind) {
          case "property":
            return `.${el.name}`;
          case "index":
            return `[${this.processNode(el.index)}]`;
          case "methodCall":
            return `.${this.generateFunctionCallExpression(el.functionCall, "valueAccess")}`;
        }
      })
      .join("");
  }

  protected processAssignment(node: Assignment): string {
    const { variableName, typeHint, value } = node;
    const scopeVar = this.scopetoString(node.scope!, variableName);
    const chainStr = this.renderAccessChain(node.accessChain);

    const typeAnnotation = "";

    if (value.type === "prompt") {
      return this.processPromptLiteral(variableName, typeHint, value);
    } else if (
      value.type === "functionCall" &&
      value.functionName === "interrupt"
    ) {
      // Special handling for interrupt assignments: x = interrupt("prompt")
      const interruptArgs = value.arguments
        .map((arg) => this.processNode(arg))
        .join(", ");
      return renderInterruptAssignment.default({
        variableName: `${scopeVar}.${variableName}${chainStr}`,
        interruptArgs,
        nodeContext: this.getCurrentScope().type === "node",
      });
    } else if (value.type === "functionCall") {
      // Direct assignment for other literal types
      const code = this.processNode(value);
      return renderFunctionCallAssignment.default({
        variableName: `${scopeVar}.${variableName}${chainStr}`,
        functionCode: code.trim(),
        nodeContext: this.getCurrentScope().type === "node",
        globalScope: this.getCurrentScope().type === "global",
      });
    } else if (value.type === "timeBlock") {
      const timingVarName = variableName;
      const code = this.processTimeBlock(value, timingVarName);
      return code;
    } else if (value.type === "messageThread") {
      const varName = `${scopeVar}.${variableName}${chainStr}`;
      return this.processMessageThread(value, varName);
    } else {
      // Direct assignment for other literal types
      const code = this.processNode(value);
      return (
        `${scopeVar}.${variableName}${chainStr}${typeAnnotation} = ${code.trim()};` +
        "\n"
      );
    }
  }
  /*
  protected processAgencyArray(node: AgencyArray): string {
    const itemCodes = node.items.map((item) => {
      if (item.type === "functionCall") { */

  protected processPromptLiteral(
    variableName: string,
    variableType: VariableType | undefined,
    node: PromptLiteral,
  ): string {
    // Validate all interpolated variables are in scope
    const interpolatedVars = uniq(
      node.segments
        .filter((s) => s.type === "interpolation")
        .map((s) => getBaseVarName(s as InterpolationSegment)),
    );

    /*     for (const varName of interpolatedVars) {
      if (
        !this.functionScopedVariables.includes(varName) &&
        !this.globalScopedVariables.includes(varName)
      ) {
        throw new Error(
          `Variable '${varName}' used in prompt interpolation but not defined. ` +
            `Referenced in assignment to '${variableName}'.`,
        );
      }
    } */

    const functionCode = this.generatePromptFunction({
      variableName,
      variableType,
      functionArgs: interpolatedVars,
      prompt: node,
    });
    return functionCode;
  }

  protected processTool(node: FunctionDefinition): string {
    const { functionName, body, parameters } = node;
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

    return renderTool.default({
      name: functionName,
      description: node.docString?.value || "No description provided.",
      schema: Object.keys(properties).length > 0 ? `{${schema}}` : "{}",
      parameters: JSON.stringify(parameters.map((p) => p.name)),
    });
  }

  protected processUsesTool(node: UsesTool): string {
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
    return "";
  }

  /**
   * Process a function definition node
   */
  protected processFunctionDefinition(node: FunctionDefinition): string {
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
    return renderFunctionDefinition.default({
      functionName,
      paramList,
      paramAssignments,
      argsObject,
      functionBody: bodyCode.join("\n"),
    });
  }

  /**
   * Process a function call used as a statement (not assigned to a variable).
   * When the called function is a user-defined agency function, the return value
   * must be checked for interrupts and propagated upward.
   */
  protected processFunctionCallAsStatement(node: FunctionCall): string {
    const code = this.processFunctionCall(node);
    const scope = this.getCurrentScope();

    if (
      this.isAgencyFunction(node.functionName, "topLevelStatement") &&
      !this.isGraphNode(node.functionName) &&
      scope.type !== "global"
    ) {
      const tempVar = "__funcResult";
      const nodeContext = scope.type === "node";
      const returnStmt = nodeContext
        ? `return { ...__state, data: ${tempVar} };`
        : `return { data: ${tempVar} };`;
      return `const ${tempVar} = ${code};\nif (isInterrupt(${tempVar})) {\n  ${returnStmt}\n}\n`;
    }

    return `${code};\n`;
  }

  /**
   * Process a node as a statement (not an expression). Handles function calls
   * specially to propagate any interrupts they may return.
   */
  protected processStatement(node: AgencyNode): string {
    if (node.type === "functionCall") {
      return this.processFunctionCallAsStatement(node);
    }
    return this.processNode(node);
  }

  /**
   * Process a function call node
   */
  protected processFunctionCall(node: FunctionCall): string {
    if (this.isGraphNode(node.functionName)) {
      this.currentAdjacentNodes.push(node.functionName);
      this.functionsUsed.add(node.functionName);
      const functionCallCode = this.generateNodeCallExpression(node);
      return functionCallCode;
    }

    this.functionsUsed.add(node.functionName);
    const functionCallCode = this.generateFunctionCallExpression(
      node,
      "topLevelStatement",
    );

    // Check if this is a built-in function that needs await
    const mappedName = mapFunctionName(node.functionName);
    const isBuiltinFunction = mappedName !== node.functionName;

    if (isBuiltinFunction) {
      return `await ${functionCallCode}`;
    }
    return functionCallCode;
  }

  /**
   * Generates TypeScript expression for a function call (without semicolon)
   */
  protected generateFunctionCallExpression(
    node: FunctionCall,
    context: "valueAccess" | "functionArg" | "topLevelStatement",
  ): string {
    const functionName =
      context === "valueAccess"
        ? node.functionName
        : mapFunctionName(node.functionName);
    const args = node.arguments;
    const parts = args.map((arg) => {
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        return this.generateFunctionCallExpression(arg, "functionArg");
      } else {
        return this.processNode(arg);
      }
    });
    let argsString = "";
    if (this.isAgencyFunction(node.functionName, context)) {
      argsString = parts.join(", ");
      return renderInternalFunctionCall.default({
        functionName,
        argsString,
        hasArgs: parts.length > 0,
        // in value access (eg foo.bar()) we never want to add an await
        // (eg foo.await bar())
        awaitPrefix: node.async || context === "valueAccess" ? "" : "await ",
        isAsync: node.async || false,
      });
    } else if (node.functionName === "system") {
      return renderBuiltinFunctionsSystem.default({
        systemMessage: parts[0],
      });
    } else {
      // must be a builtin function or imported function
      argsString = parts.join(", ");
      const awaitStr = node.async || context === "valueAccess" ? "" : "await ";
      return `${awaitStr}${functionName}(${argsString})\n`;
    }
  }

  protected generateLiteral(literal: Literal): string {
    switch (literal.type) {
      case "number":
        return literal.value;
      case "string":
        return this.generateStringLiteral(literal.segments);
      case "multiLineString":
        return this.generateStringLiteral(literal.segments);
      case "variableName":
        const scopeStr = this.scopetoString(literal.scope!, literal.value);
        if (scopeStr === "") {
          return literal.value;
        }
        return `${scopeStr}.${literal.value}`;
      case "prompt":
        return this.processPromptLiteral(
          DEFAULT_PROMPT_NAME,
          this.getScopeReturnType(),
          literal,
        );
      case "boolean":
        return literal.value ? "true" : "false";
    }
  }

  protected getScopeReturnType(): VariableType | undefined {
    const currentScope = this.getCurrentScope();
    switch (currentScope.type) {
      case "global":
        return undefined;
      case "function":
        const funcDef = this.functionDefinitions[currentScope.functionName];
        if (funcDef && funcDef.returnType) {
          return funcDef.returnType;
        }
        return undefined;
      case "node":
        const graphNode = this.graphNodes.find(
          (n) => n.nodeName === currentScope.nodeName,
        );
        if (graphNode && graphNode.returnType) {
          return graphNode.returnType;
        }
        return undefined;
      default:
        throw new Error(`Unknown scope type: ${(currentScope as any).type}`);
    }
  }
  protected generateImports(): string {
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

  buildPromptString({
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
        // Interpolation segment
        const exprStr = expressionToString(segment.expression);
        const baseVarName = getBaseVarName(segment);
        const varType = typeHints[baseVarName];

        // Serialize complex types to JSON
        if (varType && varType.type === "arrayType") {
          promptParts.push(`\${JSON.stringify(${exprStr})}`);
        } else {
          promptParts.push(`\${${exprStr}}`);
        }
      }
    }

    if (skills.length > 0) {
      const skillsArr = skills.map((skill) => {
        // strip the directory and extension from the filepath to get the skill name
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

  generateStringLiteral(segments: PromptSegment[]): string {
    const stringParts: string[] = [];

    for (const segment of segments) {
      if (segment.type === "text") {
        const escaped = escape(segment.value);
        stringParts.push(escaped);
      } else {
        // Interpolation segment — processNode on the expression handles scope
        stringParts.push("${" + this.processNode(segment.expression) + "}");
      }
    }

    return "`" + stringParts.join("") + "`";
  }

  /**
   * Generates an async for prompt-based assignments
   */
  generatePromptFunction({
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
    // Generate async function for prompt-based assignment
    const _variableType = variableType ||
      this.typeHints[variableName] || {
        type: "primitiveType" as const,
        value: "string",
      };

    const zodSchema = mapTypeToZodSchema(_variableType, this.typeAliases);
    const clientConfig = prompt.config ? this.processNode(prompt.config) : "{}";

    // Build prompt construction code
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
      // Find the interpolation segment matching this base var name
      const interpSegment = prompt.segments.find(
        (s) =>
          s.type === "interpolation" &&
          getBaseVarName(s as InterpolationSegment) === arg,
      ) as InterpolationSegment | undefined;
      if (!interpSegment) {
        return arg;
      }
      // Get the base VariableNameLiteral and use processNode to get scoped code
      const baseExpr =
        interpSegment.expression.type === "variableName"
          ? interpSegment.expression
          : interpSegment.expression.base;
      return this.processNode(baseExpr);
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

  protected processImportStatement(node: ImportStatement): string {
    // Track safe and imported functions from named imports
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

    const importedNames = node.importedNames.map((name) =>
      this.processImportNameType(name),
    );

    return `import ${importedNames.join(", ")} from "${node.modulePath.replace(/\.agency$/, ".js")}";`;
  }

  protected processImportNameType(node: ImportNameType): string {
    switch (node.type) {
      case "namedImport":
        return `{ ${node.importedNames.join(", ")} }`;
      case "namespaceImport":
        return `* as ${node.importedNames}`;
      case "defaultImport":
        return `${node.importedNames}`;
      default:
        throw new Error(`Unknown import name type: ${(node as any).type}`);
    }
  }

  protected processImportNodeStatement(node: ImportNodeStatement): string {
    return ""; // handled in preprocess
  }

  protected processImportToolStatement(node: ImportToolStatement): string {
    const importNames = node.importedTools
      .map((toolName) => [
        toolName,
        `__${toolName}Tool`,
        `__${toolName}ToolParams`,
      ])
      .flat();
    return `import { ${importNames.join(", ")} } from "${node.agencyFile.replace(/\.agency$/, ".js")}";`;
  }

  protected processForLoop(node: ForLoop): string {
    // Register loop variables so they bypass scope resolution
    this.loopVars.push(node.itemVar);
    if (node.indexVar) {
      this.loopVars.push(node.indexVar);
    }

    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processStatement(stmt));
    }
    const bodyCodeStr = bodyCodes.join("\n");

    // Unregister loop variables
    this.loopVars = this.loopVars.filter(
      (v) => v !== node.itemVar && v !== node.indexVar,
    );

    // Range form: for (i in range(start, end)) → for (let i = start; i < end; i++)
    if (
      node.iterable.type === "functionCall" &&
      node.iterable.functionName === "range"
    ) {
      const args = node.iterable.arguments;
      const start = args.length >= 1 ? this.processNode(args[0]) : "0";
      const end =
        args.length >= 2
          ? this.processNode(args[1])
          : this.processNode(args[0]);
      const actualStart = args.length >= 2 ? start : "0";
      const actualEnd = args.length >= 2 ? end : start;
      return `for (let ${node.itemVar} = ${actualStart}; ${node.itemVar} < ${actualEnd}; ${node.itemVar}++) {\n${bodyCodeStr}\n}\n`;
    }

    const iterableCode = this.processNode(node.iterable);

    // Indexed form: for (item, index in collection) → for (let index = 0; index < collection.length; index++) { const item = collection[index]; ... }
    if (node.indexVar) {
      const indexedBody = `const ${node.itemVar} = ${iterableCode}[${node.indexVar}];\n${bodyCodeStr}`;
      return `for (let ${node.indexVar} = 0; ${node.indexVar} < ${iterableCode}.length; ${node.indexVar}++) {\n${indexedBody}\n}\n`;
    }

    // Basic form: for (item in collection) → for (const item of collection)
    return `for (const ${node.itemVar} of ${iterableCode}) {\n${bodyCodeStr}\n}\n`;
  }

  protected processWhileLoop(node: WhileLoop): string {
    const conditionCode = this.processNode(node.condition);
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processStatement(stmt));
    }
    const bodyCodeStr = bodyCodes.join("\n");
    return `while (${conditionCode}) {\n${bodyCodeStr}\n}\n`;
  }

  protected processIfElse(node: IfElse): string {
    const conditionCode = this.processNode(node.condition);

    const thenBodyCodes: string[] = [];
    for (const stmt of node.thenBody) {
      thenBodyCodes.push(this.processStatement(stmt));
    }
    const thenBodyStr = thenBodyCodes.join("\n");

    let result = `if (${conditionCode}) {\n${thenBodyStr}\n}`;

    if (node.elseBody && node.elseBody.length > 0) {
      if (node.elseBody.length === 1 && node.elseBody[0].type === "ifElse") {
        // Emit "else if" instead of "else { if }"
        const elseIfCode = this.processIfElse(
          node.elseBody[0] as IfElse,
        ).trimEnd();
        result += ` else ${elseIfCode}`;
      } else {
        const elseBodyCodes: string[] = [];
        for (const stmt of node.elseBody) {
          elseBodyCodes.push(this.processStatement(stmt));
        }
        const elseBodyStr = elseBodyCodes.join("\n");
        result += ` else {\n${elseBodyStr}\n}`;
      }
    }

    return result + "\n";
  }

  protected processSpecialVar(node: SpecialVar): string {
    const value = this.processNode(node.value);
    switch (node.name) {
      case "model":
        return renderSpecialVar.default({
          name: "model",
          value,
        });
      case "messages":
        return `__threads.active().setMessages(${value});\n`;
      default:
        throw new Error(`Unhandled SpecialVar name: ${node.name}`);
    }
  }

  protected processTimeBlock(node: TimeBlock, timingVarName: string): string {
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    const bodyCodeStr = bodyCodes.join("\n");
    return renderTime.default({
      timingVarName,
      bodyCodeStr,
      printTime: node.printTime || false,
    });
  }

  protected processMessageThread(
    node: MessageThread,
    varName?: string,
  ): string {
    if (node.threadType === "parallel") {
      return this.processParallelThread(node, varName);
    }

    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    const bodyCodeStr = bodyCodes.join("\n");

    return renderMessageThread.default({
      bodyCode: bodyCodeStr,
      hasVar: !!varName,
      varName,
      isSubthread: node.threadType === "subthread",
    });
  }

  protected processParallelThread(
    node: MessageThread,
    varName?: string,
  ): string {
    const lines: string[] = ["{"];

    // Extract assignment variable names from body to create per-call threads
    const assignmentVarNames: [string, ScopeType][] = [];
    for (const stmt of node.body) {
      if (stmt.type === "assignment" && stmt.value.type === "prompt") {
        assignmentVarNames.push([stmt.variableName, stmt.scope!]);
      }
    }

    // Generate thread creation for each parallel call
    for (const [name, scope] of assignmentVarNames) {
      const threadVarName = `__ptid_${name}`;
      lines.push(`const ${threadVarName} = __threads.create();`);
      this.parallelThreadVars[name] = threadVarName;
    }

    // Process body nodes normally (they'll check parallelThreadVars)
    for (const stmt of node.body) {
      lines.push(this.processNode(stmt));
    }

    const varNames = assignmentVarNames.map(
      ([name, scope]) => `${this.scopetoString(scope, name)}.${name}`,
    );

    lines.push(
      `[${varNames.join(", ")}] = await Promise.all([${varNames.join(", ")}]);`,
    );

    // If assigned to a variable, generate object with cloned messages from each thread
    if (varName) {
      const entries = assignmentVarNames
        .map(
          ([name, scope]) =>
            `${name}: __threads.get(${this.parallelThreadVars[name]}).cloneMessages()`,
        )
        .join(", ");
      lines.push(`${varName} = { ${entries} };`);
    }

    // Clear parallel thread vars
    for (const [name, scope] of assignmentVarNames) {
      delete this.parallelThreadVars[name];
    }

    lines.push("}");
    return lines.join("\n");
  }

  protected processSkill(node: Skill): string {
    return "";
  }

  protected processBinOpExpression(node: BinOpExpression): string {
    const left = this.processNode(node.left).trim();
    const right = this.processNode(node.right).trim();
    const wrappedLeft = this.needsParensLeft(node.left, node.operator)
      ? `(${left})`
      : left;
    const wrappedRight = this.needsParensRight(node.right, node.operator)
      ? `(${right})`
      : right;
    return `${wrappedLeft} ${node.operator} ${wrappedRight}`;
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

  protected generateNodeCallExpression(node: FunctionCall): string {
    const functionName = mapFunctionName(node.functionName);
    const args = node.arguments;
    const parts = args.map((arg) => {
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        return this.generateFunctionCallExpression(arg, "functionArg");
      } else {
        return this.processNode(arg);
      }
    });

    // Look up target node's parameter names
    const targetNode = this.graphNodes.find((n) => n.nodeName === functionName);
    let argsString: string;
    if (targetNode && targetNode.parameters.length > 0) {
      const entries = targetNode.parameters.map(
        (p, i) => `${p.name}: ${parts[i]}`,
      );
      argsString = "{ " + entries.join(", ") + " }";
    } else if (parts.length > 0) {
      // For imported nodes, build the object at runtime using __NodeParams
      argsString = `Object.fromEntries(__${functionName}NodeParams.map((k, i) => [k, [${parts.join(", ")}][i]]))`;
    } else if (parts.length === 0) {
      argsString = "{}";
    } else {
      throw new Error(
        `Too many arguments provided to node '${functionName}'. Expected 0 but got ${parts.length}.`,
      );
      //argsString = parts.join(", ");
    }

    return goToNode.default({
      nodeName: functionName,
      hasData: parts.length > 0,
      data: argsString,
    });
  }

  private agencyFileToDefaultImportName(agencyFile: string): string {
    return `__graph_${agencyFile.replace(".agency", "").replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }

  protected preprocess(): string {
    const lines: string[] = [];
    this.importedNodes.forEach((importNode) => {
      const defaultImportName = this.agencyFileToDefaultImportName(
        importNode.agencyFile,
      );
      lines.push(
        `import ${defaultImportName} from "${importNode.agencyFile.replace(".agency", ".js")}";`,
      );
      // Import node parameter names for building correct data objects in goToNode calls
      const nodeParamImports = importNode.importedNodes
        .map((name) => `__${name}NodeParams`)
        .join(", ");
      lines.push(
        `import { ${nodeParamImports} } from "${importNode.agencyFile.replace(".agency", ".js")}";`,
      );
    });

    return lines.join("\n");
  }

  protected postprocess(): string {
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
      const typedArgsStr = args.map((arg) => {
        if (arg.typeHint) {
          return `${arg.name}: ${formatTypeHint(arg.typeHint)}`;
        }
        return `${arg.name}: any`;
      }).join(", ");
      lines.push(
        renderRunNodeFunction.default({
          nodeName: node.nodeName,
          hasArgs: args.length > 0,
          argsStr,
          typedArgsStr,
        }),
      );
      // Export node parameter names so imported nodes can build correct data objects
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

  /**
   * Check if a function name refers to an impure imported function
   * (imported from TS, not marked safe).
   */
  protected isImpureImportedFunction(functionName: string): boolean {
    return (
      !!this.importedFunctions[functionName] &&
      !this.safeFunctions[functionName]
    );
  }

  /**
   * Check if an AST node (or its children) contains a call to an impure imported function.
   */
  protected containsImpureCall(node: AgencyNode): boolean {
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

  /* This generates the body of a node or function separated into multiple parts.
  You can think of a part as roughly corresponding to a single statement
  (although some statements don't need their own parts, such as a newlines or type definitions).

  This is done so that we can keep track of what statement we're currently executing,
  so that we can serialize that as part of the state if we return from an interrupt,
  so that when we deserialize the state, we can pick up where we were and avoid having to
  re-execute all the statements that we already executed.

  Basically, this is part of the reason why agency can pick up exactly where you left off. */
  protected processBodyAsParts(body: AgencyNode[]): string[] {
    const parts: string[][] = [[]];
    for (const stmt of body) {
      if (!TYPES_THAT_DONT_TRIGGER_NEW_PART.includes(stmt.type)) {
        parts.push([]);
      }
      // Inject __self.__retryable = false before impure imported function calls
      if (this.containsImpureCall(stmt)) {
        parts[parts.length - 1].push("__self.__retryable = false;\n");
      }
      parts[parts.length - 1].push(this.processStatement(stmt));
    }
    const bodyCode: string[] = [];
    let partNum = 0;
    for (const part of parts) {
      const partCode = `
      if (__step <= ${partNum}) {
        ${part.join("").trimEnd()}
        __stack.step++;
      }
      `;
      bodyCode.push(partCode);
      partNum++;
    }
    return bodyCode;
  }

  protected processKeyword(node: Keyword): string {
    return `${node.value};\n`;
  }

  protected scopetoString(scope: ScopeType, varName?: string): string {
    if (varName && this.loopVars.includes(varName)) {
      return "";
    }
    return super.scopetoString(scope, varName);
  }
}

export function generateTypeScript(
  program: AgencyProgram,
  config?: AgencyConfig,
): string {
  const preprocessor = new TypescriptPreprocessor(program, config);
  const preprocessedProgram = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(config);
  const ir = builder.build(preprocessedProgram);
  return printTs(ir);
}
