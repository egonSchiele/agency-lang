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
import * as renderSpecialVar from "../templates/backends/graphGenerator/specialVar.js";
import * as renderTime from "../templates/backends/typescriptGenerator/builtinFunctions/time.js";
import * as builtinTools from "../templates/backends/typescriptGenerator/builtinTools.js";
import * as renderFunctionDefinition from "../templates/backends/typescriptGenerator/functionDefinition.js";
import * as renderInternalFunctionCall from "../templates/backends/typescriptGenerator/internalFunctionCall.js";
import * as renderFunctionCallAssignment from "../templates/backends/typescriptGenerator/functionCallAssignment.js";
import * as renderImports from "../templates/backends/typescriptGenerator/imports.js";
import * as renderMessageThread from "../templates/backends/typescriptGenerator/messageThread.js";
import * as promptFunction from "../templates/backends/typescriptGenerator/promptFunction.js";
import * as renderTool from "../templates/backends/typescriptGenerator/tool.js";
import * as renderToolCall from "../templates/backends/typescriptGenerator/toolCall.js";
import * as renderSkillPrompt from "@/templates/prompts/skill.js";

import {
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "../types/access.js";
import { AgencyArray, AgencyObject } from "../types/dataStructures.js";
import {
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
} from "../types/function.js";
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

const DEFAULT_PROMPT_NAME = "__promptVar";

export class TypeScriptGenerator extends BaseGenerator {
  protected currentMessageThreadNodeId = ["0"];
  constructor(args: { config?: AgencyConfig } = {}) {
    super(args);
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

  protected processReturnStatement(node: ReturnStatement): string {
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

  protected processAccessExpression(node: AccessExpression): string {
    switch (node.expression.type) {
      case "dotProperty":
        return this.processDotProperty(node.expression);
      case "indexAccess":
        return this.processIndexAccess(node.expression);
      case "dotFunctionCall":
        return this.processDotFunctionCall(node.expression);
    }
  }

  protected processMatchBlock(node: MatchBlock): string {
    let lines = [`switch (${this.generateLiteral(node.expression)}) {`];

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

  protected processDotProperty(node: DotProperty): string {
    const objectCode = this.processNode(node.object);

    const propertyAccess = `${objectCode}.${node.propertyName}`;
    return propertyAccess;
  }

  protected processDotFunctionCall(node: DotFunctionCall): string {
    const objectCode = this.processNode(node.object);

    const functionCallCode = this.generateFunctionCallExpression(
      node.functionCall,
    );
    const fullCall = `${objectCode}.${functionCallCode}`;
    return fullCall;
  }

  protected processIndexAccess(node: IndexAccess): string {
    const arrayCode = this.processNode(node.array);

    const indexCode = this.processNode(node.index);
    const accessCode = `${arrayCode}[${indexCode}]`;
    return accessCode;
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
    /*     if (this.functionSignatures[node.functionName] === undefined) {
      throw new Error(
        `Function '${node.functionName}' is not defined or imported.`
      );
    }
 */ this.functionsUsed.add(node.functionName);
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
      argsString = parts.join(", ");
      const metadata = `{
        statelogClient,
        graph: __graph,
        messages: __self.messages_${this.currentMessageThreadNodeId.at(-1)}.getMessages(),
      }`;
      return renderInternalFunctionCall.default({
        functionName,
        argsString,
        metadata,
        awaitPrefix: node.async ? "" : "await ",
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
    let arr = [renderImports.default({})];
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

    /* What's going on here? This is a nine. We change all agency functions to take an array of arguments.
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
      messages: __self.messages_${this.currentMessageThreadNodeId.at(-1)}?.getMessages(),
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
      messagesVar: `__self.messages_${this.currentMessageThreadNodeId.at(-1)}`,
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
    return ""; // handled in preprocess in graphgenerator
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
        return `__self.messages_${this.currentMessageThreadNodeId.at(-1)}.setMessages(${value});\n`;
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
    this.currentMessageThreadNodeId.push(node.nodeId || "0");
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    const bodyCodeStr = bodyCodes.join("\n");
    this.currentMessageThreadNodeId.pop();
    return renderMessageThread.default({
      bodyCode: bodyCodeStr,
      hasVar: !!varName,
      varName,
      isSubthread: node.subthread,
      nodeId: node.nodeId || "0",
      parentNodeId: node.parentNodeId || "0",
    });
  }

  protected processSkill(node: Skill): string {
    return "";
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
