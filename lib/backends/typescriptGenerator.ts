import {
  AgencyComment,
  AgencyProgram,
  Assignment,
  InterpolationSegment,
  Literal,
  PromptLiteral,
  PromptSegment,
  TypeAlias,
  TypeHint,
  TypeHintMap,
} from "../types.js";

import { SpecialVar } from "@/types/specialVar.js";
import * as renderSpecialVar from "../templates/backends/graphGenerator/specialVar.js";
import * as builtinTools from "../templates/backends/typescriptGenerator/builtinTools.js";
import * as renderFunctionDefinition from "../templates/backends/typescriptGenerator/functionDefinition.js";
import * as renderImports from "../templates/backends/typescriptGenerator/imports.js";
import * as promptFunction from "../templates/backends/typescriptGenerator/promptFunction.js";
import * as renderTool from "../templates/backends/typescriptGenerator/tool.js";
import * as renderToolCall from "../templates/backends/typescriptGenerator/toolCall.js";
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
import { ImportStatement } from "../types/importStatement.js";
import { MatchBlock } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { UsesTool } from "../types/tools.js";
import { WhileLoop } from "../types/whileLoop.js";
import { escape, zip } from "../utils.js";
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
import { TimeBlock } from "@/types/timeBlock.js";

export class TypeScriptGenerator extends BaseGenerator {
  constructor() {
    super();
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
    return `type ${node.aliasName} = ${aliasedTypeStr};`;
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
    return `return ${returnCode}\n`;
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
    const { variableName, value } = node;
    // Track this variable as in scope
    this.functionScopedVariables.push(variableName);

    if (value.type === "prompt") {
      return this.processPromptLiteral(variableName, value);
    } else if (value.type === "functionCall") {
      // Direct assignment for other literal types
      const code = this.processNode(value);
      return `const ${variableName} = await ${code.trim()};` + "\n";
    } else if (value.type === "timeBlock") {
      const timingVarName = `_timeBlockResult_${variableName}`;
      const code = this.processTimeBlock(value, timingVarName);
      return `const ${variableName} = await ${code.trim()};` + "\n";
    } else {
      // Direct assignment for other literal types
      const code = this.processNode(value);
      return `const ${variableName} = ${code.trim()};` + "\n";
    }
  }
  /*
  protected processAgencyArray(node: AgencyArray): string {
    const itemCodes = node.items.map((item) => {
      if (item.type === "functionCall") { */

  protected processPromptLiteral(
    variableName: string,
    node: PromptLiteral,
  ): string {
    // Validate all interpolated variables are in scope
    const interpolatedVars = node.segments
      .filter((s) => s.type === "interpolation")
      .map((s) => (s as InterpolationSegment).variableName);

    for (const varName of interpolatedVars) {
      if (
        !this.functionScopedVariables.includes(varName) &&
        !this.globalScopedVariables.includes(varName)
      ) {
        throw new Error(
          `Variable '${varName}' used in prompt interpolation but not defined. ` +
            `Referenced in assignment to '${variableName}'.`,
        );
      }
    }

    const functionCode = this.generatePromptFunction({
      variableName,
      functionArgs: interpolatedVars,
      prompt: node,
    });
    this.generatedStatements.push(functionCode);

    const argsStr = interpolatedVars.join(", ");
    // Generate the function call
    return `const ${variableName} = await _${variableName}(${argsStr});` + "\n";
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
    });
  }

  protected processUsesTool(node: UsesTool): string {
    this.toolsUsed.push(node.toolName);
    return "";
  }

  /**
   * Process a function definition node
   */
  protected processFunctionDefinition(node: FunctionDefinition): string {
    const { functionName, body, parameters } = node;
    this.functionScopedVariables = [...parameters.map((p) => p.name)];
    const bodyCode: string[] = [];
    for (const stmt of body) {
      bodyCode.push(this.processNode(stmt));
    }
    this.functionScopedVariables = [];
    const args = parameters.map((p) => p.name).join(", ") || "";
    return renderFunctionDefinition.default({
      functionName,
      args: "{" + args + "}",
      returnType: node.returnType
        ? variableTypeToString(node.returnType, this.typeAliases)
        : "any",
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
        /*       } else if (arg.type === "accessExpression") {
        return this.processAccessExpression(arg);
      } else if (arg.type === "indexAccess") {
        return this.processIndexAccess(arg);
 */
      } else {
        //        return this.generateLiteral(arg);
        return this.processNode(arg);
      }
    });
    let argsString = "";
    const paramNames = this.functionSignatures[node.functionName];
    if (paramNames) {
      const partsWithNames = zip(paramNames, parts).map(([paramName, part]) => {
        return `${paramName}: ${part}`;
      });
      argsString = partsWithNames.join(", ");
      return `${functionName}({${argsString}})`;
    } else {
      // must be a builtin function or imported function,
      // as we don't have the signature info
      // in that case don't do named parameters
      argsString = parts.join(", ");
      return `${functionName}(${argsString})`;
    }
  }

  protected generateLiteral(literal: Literal): string {
    switch (literal.type) {
      case "number":
        return literal.value;
      case "string":
        return `"${escape(literal.value)}"`;
      case "multiLineString":
        return `\`${escape(literal.value)}\``;
      case "variableName":
        return literal.value;
      case "prompt":
        //return this.processPromptLiteral("asd", literal).trim();
        // Reconstruct text for comment from segments
        const text = literal.segments
          .map((s) => (s.type === "text" ? s.value : `#{${s.variableName}}`))
          .join("");
        return `/* prompt for: ${text} */`;
    }
  }

  protected generateImports(): string {
    let arr = [renderImports.default({})];
    arr.push(builtinTools.default({}));
    return arr.join("\n");
  }

  buildPromptString(segments: PromptSegment[], typeHints: TypeHintMap): string {
    const promptParts: string[] = [];

    for (const segment of segments) {
      if (segment.type === "text") {
        const escaped = escape(segment.value);
        promptParts.push(escaped);
      } else {
        // Interpolation segment
        const varName = segment.variableName;
        const varType = typeHints[varName];

        // Serialize complex types to JSON
        if (varType && varType.type === "arrayType") {
          promptParts.push(`\${JSON.stringify(${varName})}`);
        } else {
          promptParts.push(`\${${varName}}`);
        }
      }
    }

    return "`" + promptParts.join("") + "`";
  }

  /**
   * Generates an async for prompt-based assignments
   */
  generatePromptFunction({
    variableName,
    functionArgs = [],
    prompt,
  }: {
    variableName: string;
    functionArgs: string[];
    prompt: PromptLiteral;
  }): string {
    // Generate async function for prompt-based assignment
    const variableType = this.typeHints[variableName] || {
      type: "primitiveType" as const,
      value: "string",
    };

    const zodSchema = mapTypeToZodSchema(variableType, this.typeAliases);
    //console.log("Generated Zod schema for variable", variableName, "Variable type:", variableType, ":", zodSchema, "aliases:", this.typeAliases, "hints:", this.typeHints);
    const typeString = variableTypeToString(variableType, this.typeAliases);

    // Build prompt construction code
    const promptCode = this.buildPromptString(prompt.segments, this.typeHints);
    const argsStr = functionArgs
      .map(
        (arg) =>
          `${arg}: ${variableTypeToString(
            this.typeHints[arg] || { type: "primitiveType", value: "string" },
            this.typeAliases,
          )}`,
      )
      .join(", ");

    const _tools = this.toolsUsed
      .map((toolName) => `${toolName}Tool`)
      .join(", ");

    const tools = _tools.length > 0 ? `[${_tools}]` : "undefined";

    const functionCalls = this.toolsUsed
      .map((toolName) => {
        return renderToolCall.default({
          name: toolName,
        });
      })
      .join("\n");
    this.toolsUsed = []; // reset after use
    return promptFunction.default({
      variableName,
      argsStr,
      typeString,
      promptCode,
      hasResponseFormat: zodSchema !== DEFAULT_SCHEMA,
      zodSchema,
      tools,
      functionCalls,
    });
  }

  protected processImportStatement(node: ImportStatement): string {
    return `import ${node.importedNames} from ${node.modulePath};`;
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

  protected processSpecialVar(node: SpecialVar): string {
    const value = this.processNode(node.value);
    switch (node.name) {
      case "model":
        return renderSpecialVar.default({
          name: "model",
          value,
        });
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
    return bodyCodeStr;
  }
}

export function generateTypeScript(program: AgencyProgram): string {
  const generator = new TypeScriptGenerator();
  return generator.generate(program).output;
}
