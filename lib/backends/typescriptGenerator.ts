import {
  AgencyComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  InterpolationSegment,
  Literal,
  PromptLiteral,
  PromptSegment,
  TypeAlias,
  TypeHint,
  TypeHintMap,
  VariableType,
} from "../types.js";

import { BUILTIN_TOOLS, TYPES_THAT_DONT_TRIGGER_NEW_PART } from "@/config.js";
import { AwaitStatement } from "@/types/await.js";
import { SpecialVar } from "@/types/specialVar.js";
import { TimeBlock } from "@/types/timeBlock.js";
import * as renderSpecialVar from "../templates/backends/typescriptGenerator/specialVar.js";
import * as renderTime from "../templates/backends/typescriptGenerator/builtinFunctions/time.js";
import * as builtinTools from "../templates/backends/typescriptGenerator/builtinTools.js";
import * as renderConditionalEdge from "../templates/backends/typescriptGenerator/conditionalEdge.js";
import * as renderFunctionDefinition from "../templates/backends/typescriptGenerator/functionDefinition.js";
import * as renderInternalFunctionCall from "../templates/backends/typescriptGenerator/internalFunctionCall.js";
import * as renderFunctionCallAssignment from "../templates/backends/typescriptGenerator/functionCallAssignment.js";
import * as goToNode from "../templates/backends/typescriptGenerator/goToNode.js";
import * as renderGraphNode from "../templates/backends/typescriptGenerator/graphNode.js";
import * as renderImports from "../templates/backends/typescriptGenerator/imports.js";
import * as renderInitializeMessageThread from "../templates/backends/typescriptGenerator/initializeMessageThread.js";
import * as renderMessageThread from "../templates/backends/typescriptGenerator/messageThread.js";
import * as promptFunction from "../templates/backends/typescriptGenerator/promptFunction.js";
import * as renderRunNodeFunction from "../templates/backends/typescriptGenerator/runNodeFunction.js";
import * as renderStartNode from "../templates/backends/typescriptGenerator/startNode.js";
import * as renderTool from "../templates/backends/typescriptGenerator/tool.js";
import * as renderToolCall from "../templates/backends/typescriptGenerator/toolCall.js";
import * as renderSkillPrompt from "@/templates/prompts/skill.js";
import * as renderBuiltinFunctionsSystem from "@/templates/backends/typescriptGenerator/builtinFunctions/system.js";

import { ValueAccess } from "../types/access.js";
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
import { WhileLoop } from "../types/whileLoop.js";
import { escape, uniq } from "../utils.js";
import { BaseGenerator } from "./baseGenerator.js";
import {
  generateBuiltinHelpers,
  mapFunctionName,
} from "./typescriptGenerator/builtins.js";
import { variableTypeToString } from "./typescriptGenerator/typeToString.js";
import {
  DEFAULT_SCHEMA,
  mapTypeToZodSchema,
} from "./typescriptGenerator/typeToZodSchema.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { AgencyConfig } from "@/config.js";
import { MessageThread } from "@/types/messageThread.js";
import { Skill } from "@/types/skill.js";
import path from "path";
import { BinOpExpression } from "@/types/binop.js";

const DEFAULT_PROMPT_NAME = "__promptVar";

export class TypeScriptGenerator extends BaseGenerator {
  protected adjacentNodes: Record<string, string[]> = {};
  protected currentAdjacentNodes: string[] = [];
  protected isInsideGraphNode: boolean = false;

  constructor(args: { config?: AgencyConfig } = {}) {
    super(args);
  }

  configDefaults(): Partial<AgencyConfig> {
    return {
      log: {
        host: "https://agency-lang.com",
      },
      client: {
        logLevel: "warn",
        defaultModel: "gpt-4o-mini",
      },
    };
  }

  protected generateBuiltins(): string {
    return generateBuiltinHelpers(this.functionsUsed);
  }

  protected processTypeAlias(node: TypeAlias): string {
    this.typeAliases[node.aliasName] = node.aliasedType;
    const typeAliasStr = this.typeAliasToString(node);
    if (!this.generatedTypeAliases.includes(typeAliasStr)) {
      this.generatedTypeAliases.push(typeAliasStr);
    }
    return "";
  }

  protected typeAliasToString(node: TypeAlias): string {
    const aliasedTypeStr = variableTypeToString(
      node.aliasedType,
      this.typeAliases,
    );
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
      const keyCode = entry.key;
      const valueCode = this.processNode(entry.value).trim();
      return `"${keyCode}": ${valueCode}`;
    });
    return `{${kvCodes.join(", ")}}`;
  }

  protected processAgencyArray(node: AgencyArray): string {
    const itemCodes = node.items.map((item) => {
      return this.processNode(item).trim();
    });
    return `[${itemCodes.join(", ")}]`;
  }

  protected processComment(node: AgencyComment): string {
    return `// ${node.content}\n`;
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
    const paramNames =
      "[" + parameters.map((p) => `"${p.name}"`).join(", ") + "]";

    return renderGraphNode.default({
      name: nodeName,
      body: bodyCode.join("\n"),
      hasParam: parameters.length > 0,
      paramNames,
      initializeMessageThreads: this.initializeMessageThreads(
        node.threadIds || [],
      ),
    });
  }

  protected processReturnStatement(node: ReturnStatement): string {
    if (this.isInsideGraphNode) {
      const returnCode = this.processNode(node.value);
      if (node.value.type === "functionCall") {
        if (this.isGraphNode(node.value.functionName)) {
          // we're going to return a goToNode call, so just return that directly
          return `return ${returnCode}\n`;
        }
      }
      return `return { messages: __stack.messages, data: ${returnCode}}\n`;
    }

    const returnCode = this.processNode(node.value);
    if (
      node.value.type === "functionCall" &&
      node.value.functionName === "interrupt"
    ) {
      /* In this case we're not popping off the stack, because we need to save the state,
      because we will be restoring it (since this is an interrupt). However we do need to
      advance the step so that the next time we come here, we start at the part after this
      interrupt. */
      return `__stack.step++;\nreturn ${returnCode}\n`;
    } else if (node.value.type === "prompt") {
      return `${returnCode}\n__stateStack.pop();\nreturn __self.${DEFAULT_PROMPT_NAME};\n`;
    }
    /* Pop the state off the stack, we won't be coming back.
    Doesn't matter if we update the step or not, since we won't be coming back here. */
    return `__stateStack.pop();\nreturn ${returnCode}\n`;
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
          code += `.${this.generateFunctionCallExpression(element.functionCall)}`;
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


  protected processAssignment(node: Assignment): string {
    const { variableName, typeHint, value } = node;
    const scopeVar = this.scopetoString(node.scope!);

    const typeAnnotation = "";

    if (value.type === "prompt") {
      return this.processPromptLiteral(variableName, typeHint, value);
    } else if (value.type === "functionCall") {
      // Direct assignment for other literal types
      const code = this.processNode(value);
      return renderFunctionCallAssignment.default({
        variableName: `${scopeVar}.${variableName}`,
        functionCode: code.trim(),
        nodeContext: this.getCurrentScope().type === "node",
        globalScope: this.getCurrentScope().type === "global",
      });
    } else if (value.type === "timeBlock") {
      const timingVarName = variableName;
      const code = this.processTimeBlock(value, timingVarName);
      return code;
    } else if (value.type === "messageThread") {
      const varName = `${scopeVar}.${variableName}`;
      return this.processMessageThread(value, varName);
    } else {
      // Direct assignment for other literal types
      const code = this.processNode(value);
      return (
        `${scopeVar}.${variableName}${typeAnnotation} = ${code.trim()};` + "\n"
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
        .map((s) => (s as InterpolationSegment).variableName),
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
      schema += `"${key}": ${value}, `;
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

    const bodyCode = this.processBodyAsParts(body);

    this.endScope();
    const argsStr = args.map((arg) => `"${arg}"`).join(", ") || "";
    return renderFunctionDefinition.default({
      functionName,
      argsStr,
      functionBody: bodyCode.join("\n"),
    });
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
    const functionCallCode = this.generateFunctionCallExpression(node);

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
  protected generateFunctionCallExpression(node: FunctionCall): string {
    const functionName = mapFunctionName(node.functionName);
    const args = node.arguments;
    const parts = args.map((arg) => {
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        return this.generateFunctionCallExpression(arg);
      } else {
        return this.processNode(arg);
      }
    });
    let argsString = "";
    if (this.isAgencyFunction(node.functionName)) {
      if (!node.threadId) {
        throw new Error(
          `No threadId for function call: ${JSON.stringify(node)}`,
        );
      }
      argsString = parts.join(", ");
      return renderInternalFunctionCall.default({
        functionName,
        argsString,
        statelogClient: "statelogClient",
        graph: "__graph",
        messages: `__stack.messages`, //[${node.threadId}]`,
        threadId: node.threadId ? `${node.threadId}` : "undefined",
        awaitPrefix: node.async ? "" : "await ",
      });
    } else if (node.functionName === "system") {
      return renderBuiltinFunctionsSystem.default({
        threadId: node.threadId ? `${node.threadId}` : "undefined",
        systemMessage: parts[0],
      });
    } else {
      // must be a builtin function or imported function
      argsString = parts.join(", ");
      const awaitStr = node.async ? "await " : "";
      return `${awaitStr}${functionName}(${argsString})`;
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
        return `${this.scopetoString(literal.scope!)}.${literal.value}`;
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
    }
  }
  protected generateImports(): string {
    const args = {
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
    };

    const arr = [renderImports.default(args)];
    arr.push(builtinTools.default({}));
    return arr.join("\n");
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
        const varName = segment.variableName.replace(".", "_");
        const varType = typeHints[varName];

        // Serialize complex types to JSON
        if (varType && varType.type === "arrayType") {
          promptParts.push(`\${JSON.stringify(${varName})}`);
        } else {
          promptParts.push(`\${${varName}}`);
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
        // Interpolation segment
        stringParts.push(
          "${" +
            this.scopetoString(segment.scope!) +
            "." +
            segment.variableName +
            "}",
        );
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
    if (!prompt.threadId) {
      throw new Error(`No threadId for prompt: ${JSON.stringify(prompt)}`);
    }

    // Generate async function for prompt-based assignment
    const _variableType = variableType ||
      this.typeHints[variableName] || {
        type: "primitiveType" as const,
        value: "string",
      };

    const zodSchema = mapTypeToZodSchema(_variableType, this.typeAliases);

    // Build prompt construction code
    const promptCode = this.buildPromptString({
      segments: prompt.segments,
      typeHints: this.typeHints,
      skills: prompt.skills || [],
    });
    const parts = functionArgs.map((arg) => arg.replace(".", "_"));
    parts.push("__metadata");
    const argsStr = parts.join(", ");
    let _tools = "";
    if (prompt.tools) {
      _tools = prompt.tools.toolNames.map((name) => `__${name}Tool`).join(", ");
    }
    const tools = _tools.length > 0 ? `[${_tools}]` : "undefined";

    /* What's going on here? This is annoying. We change all agency functions to take an array of arguments.
So, for example, `function add(a, b)` would get turned into `function add(arr)`.
Earlier, the arguments were getting converted into an object like `function add({a, b})` because LLMs
pass back an object of parameters for the function calls, so that made it easy to pass those arguments
straight to a function.

But that meant if a function was defined in another file, we would need to parse the contents of the file
to understand the names of the function parameters, hence the idea of an array. Unfortunately, the array
still doesn't solve the problem completely, because if what we get back from a tool call is an object
like `{a:1, b:2}`, we need to know how to convert it into an array. We need to know the order of the parameters.

So now, every function call generates a related tool definition, but it also generats an array of parameter names.
So if the user defines `add`, we'll generate `export const __addTool`, which is the tool definition,
and `export const __addToolParams`, which is an array of param names.

It's a mess and needs rethinking 🤮

This still doesn't work perfectly, because I can't introspect imported functions to see if they throw an interrupt,
so I have to always assume they do, which reduces some opportunity for parallelism. Maybe I just need to bite the bullet
and commit to having a preprocessed step where all the files get read.
I'll probably need to do that for supporting type checking anyway.
*/

    const functionCalls = (
      prompt.tools || { type: "usesTool", toolNames: [] }
    ).toolNames
      .filter((t) => !BUILTIN_TOOLS.includes(t))
      .map((toolName) => {
        if (
          !this.functionDefinitions[toolName] &&
          !this.isImportedTool(toolName)
        ) {
          throw new Error(
            `Tool '${toolName}' is being used but no function definition found for it. Make sure to define a function for this tool.`,
          );
        }

        return renderToolCall.default({
          name: toolName,
        });
      })
      .join("\n");

    const clientConfig = prompt.config ? this.processNode(prompt.config) : "{}";
    const metadataObj = `{
      messages: __stack.messages[(typeof __threadId !== 'undefined') ? __threadId : ${prompt.threadId}]
    }`;

    const scopedFunctionArgs = functionArgs.map((arg) => {
      // Find the scope for this interpolated variable from the prompt segments
      const interpSegment = prompt.segments.find(
        (s) => s.type === "interpolation" && s.variableName === arg,
      );
      const scope =
        interpSegment?.type === "interpolation"
          ? interpSegment.scope
          : undefined;
      return `${this.scopetoString(scope!)}.${arg}`;
    });

    return promptFunction.default({
      variableName,
      argsStr,
      funcCallParams: [...scopedFunctionArgs, metadataObj].join(", "),
      promptCode,
      hasResponseFormat: zodSchema !== DEFAULT_SCHEMA,
      zodSchema,
      tools,
      functionCalls,
      clientConfig,
      nodeContext: this.getCurrentScope().type === "node",
      isStreaming: prompt.isStreaming || false,
      isAsync: prompt.async || false,
    });
  }

  protected processImportStatement(node: ImportStatement): string {
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

  protected processWhileLoop(node: WhileLoop): string {
    const conditionCode = this.processNode(node.condition);
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    const bodyCodeStr = bodyCodes.join("\n");
    return `while (${conditionCode}) {\n${bodyCodeStr}\n}\n`;
  }

  protected processIfElse(node: IfElse): string {
    const conditionCode = this.processNode(node.condition);

    const thenBodyCodes: string[] = [];
    for (const stmt of node.thenBody) {
      thenBodyCodes.push(this.processNode(stmt));
    }
    const thenBodyStr = thenBodyCodes.join("\n");

    let result = `if (${conditionCode}) {\n${thenBodyStr}\n}`;

    if (node.elseBody && node.elseBody.length > 0) {
      const elseBodyCodes: string[] = [];
      for (const stmt of node.elseBody) {
        elseBodyCodes.push(this.processNode(stmt));
      }
      const elseBodyStr = elseBodyCodes.join("\n");
      result += ` else {\n${elseBodyStr}\n}`;
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
        if (!node.threadId) {
          throw new Error(
            `No threadId for messages specialVar: ${JSON.stringify(node)}`,
          );
        }

        return `__stack.messages[${node.threadId}].setMessages(${value});\n`;
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

  protected processAwaitStatement(node: AwaitStatement): string {
    const code = this.processNode(node.expression);
    return `await ${code}`;
  }

  protected processMessageThread(
    node: MessageThread,
    varName?: string,
  ): string {
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    const bodyCodeStr = bodyCodes.join("\n");
    return renderMessageThread.default({
      bodyCode: bodyCodeStr,
      hasVar: !!varName,
      varName,
      isSubthread: node.subthread,
      threadId: node.threadId || "0",
      parentThreadId: node.parentThreadId || "0",
    });
  }

  protected processSkill(node: Skill): string {
    return "";
  }

  protected processBinOpExpression(node: BinOpExpression): string {
    return `${this.processNode(node.left).trim()} ${node.operator} ${this.processNode(node.right).trim()}`;
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
        return this.generateFunctionCallExpression(arg);
      } else {
        return this.processNode(arg);
      }
    });
    const argsString = "[" + parts.join(", ") + "]";
    return goToNode.default({
      nodeName: functionName,
      hasData: parts.length > 0,
      data: argsString,
    });
  }

  protected initializeMessageThreads(threadIds: string[]): string {
    const lines = threadIds.map((threadId, index) => {
      return renderInitializeMessageThread.default({ index: threadId });
    });
    return lines.join("\n");
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
      lines.push(
        renderRunNodeFunction.default({
          nodeName: node.nodeName,
          hasArgs: args.length > 0,
          argsStr,
        }),
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
      parts[parts.length - 1].push(this.processNode(stmt));
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
}

export function generateTypeScript(
  program: AgencyProgram,
  config?: AgencyConfig,
): string {
  const preprocessor = new TypescriptPreprocessor(program, config);
  const preprocessedProgram = preprocessor.preprocess();
  const generator = new TypeScriptGenerator({ config });
  return generator.generate(preprocessedProgram).output;
}
