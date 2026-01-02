import {
  ADLComment,
  ADLNode,
  ADLProgram,
  Assignment,
  InterpolationSegment,
  Literal,
  PromptLiteral,
  PromptSegment,
  TypeAlias,
  TypeHint,
  TypeHintMap,
  VariableType,
} from "@/types";

import * as renderImports from "@/templates/backends/typescriptGenerator/imports";
import * as promptFunction from "@/templates/backends/typescriptGenerator/promptFunction";
import {
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "@/types/access";
import {
  FunctionCall,
  FunctionDefinition,
  ReturnStatement,
} from "@/types/function";
import { MatchBlock } from "@/types/matchBlock";
import { escape } from "@/utils";
import {
  generateBuiltinHelpers,
  mapFunctionName,
} from "./typescriptGenerator/builtins";
import { variableTypeToString } from "./typescriptGenerator/typeToString";
import { mapTypeToZodSchema } from "./typescriptGenerator/typeToZodSchema";
import { ADLObject, ADLArray } from "@/types/dataStructures";
import { BaseGenerator } from "./baseGenerator";

export class TypeScriptGenerator extends BaseGenerator {
  constructor() {
    super();
  }

  protected generateBuiltins(): string {
    return generateBuiltinHelpers(this.functionsUsed);
  }

  protected processTypeAlias(node: TypeAlias): void {
    this.typeAliases[node.aliasName] = node.aliasedType;
    const typeAliasStr = this.typeAliasToString(node);
    this.generatedTypeAliases.push(typeAliasStr);
  }

  protected typeAliasToString(node: TypeAlias): string {
    const aliasedTypeStr = variableTypeToString(
      node.aliasedType,
      this.typeAliases
    );
    return `type ${node.aliasName} = ${aliasedTypeStr};`;
  }

  protected processTypeHint(node: TypeHint): void {
    if (node.variableType.type === "typeAliasVariable") {
      if (!(node.variableType.aliasName in this.typeAliases)) {
        throw new Error(
          `Type alias '${node.variableType.aliasName}' not defined for variable '${node.variableName}'.`
        );
      }
    }
    this.typeHints[node.variableName] = node.variableType;
  }

  protected processADLObject(node: ADLObject): string {
    const kvCodes = node.entries.map((entry) => {
      const keyCode = entry.key;
      const valueCode = this.processNode(entry.value).trim();
      return `"${keyCode}": ${valueCode}`;
    });
    return `{${kvCodes.join(", ")}}`;
  }

  protected processADLArray(node: ADLArray): string {
    const itemCodes = node.items.map((item) => {
      return this.processNode(item).trim();
    });
    return `[${itemCodes.join(", ")}]`;
  }

  protected processComment(node: ADLComment): string {
    return `// ${node.content}\n`;
  }

  protected processReturnStatement(node: ReturnStatement): string {
    const returnCode = this.processNode(node.value);
    return `return ${returnCode}` + "\n";
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
      }
      if (caseItem.caseValue === "_") {
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
      node.functionCall
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
    this.variablesInScope.add(variableName);

    if (value.type === "prompt") {
      return this.processPromptLiteral(variableName, value);
    } else if (value.type === "functionCall") {
      // Direct assignment for other literal types
      const code = this.processNode(value);
      return `const ${variableName} = await ${code.trim()};` + "\n";
    } else {
      // Direct assignment for other literal types
      const code = this.processNode(value);
      return `const ${variableName} = ${code.trim()};` + "\n";
    }
  }
  /* 
  protected processADLArray(node: ADLArray): string {
    const itemCodes = node.items.map((item) => {
      if (item.type === "functionCall") { */

  protected processPromptLiteral(
    variableName: string,
    node: PromptLiteral
  ): string {
    // Validate all interpolated variables are in scope
    const interpolatedVars = node.segments
      .filter((s) => s.type === "interpolation")
      .map((s) => (s as InterpolationSegment).variableName);

    for (const varName of interpolatedVars) {
      if (!this.variablesInScope.has(varName)) {
        throw new Error(
          `Variable '${varName}' used in prompt interpolation but not defined. ` +
            `Referenced in assignment to '${variableName}'.`
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

  /**
   * Process a function definition node
   */
  protected processFunctionDefinition(node: FunctionDefinition): string {
    const { functionName, body } = node;

    const functionLines: string[] = [];
    functionLines.push(`async function ${functionName}() {`);

    const bodyCode: string[] = [];
    for (const stmt of body) {
      bodyCode.push(this.processNode(stmt));
    }
    functionLines.push(bodyCode.join("\n"));
    functionLines.push("}\n");
    return functionLines.join("\n");
  }

  /**
   * Process a function call node
   */
  protected processFunctionCall(node: FunctionCall): string {
    this.functionsUsed.add(node.functionName);
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
      } else if (arg.type === "accessExpression") {
        return this.processAccessExpression(arg);
      } else {
        return this.generateLiteral(arg);
      }
    });
    const argsString = parts.join(", ");
    return `${functionName}(${argsString})`;
  }

  protected generateLiteral(literal: Literal): string {
    switch (literal.type) {
      case "number":
        return literal.value;
      case "string":
        return `"${escape(literal.value)}"`;
      case "variableName":
        return literal.value;
      case "prompt":
        // Reconstruct text for comment from segments
        const text = literal.segments
          .map((s) => (s.type === "text" ? s.value : `#{${s.variableName}}`))
          .join("");
        return `/* prompt: ${text} */\n`;
    }
  }

  generateImports(): string {
    return renderImports.default({});
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
    const typeString = variableTypeToString(variableType, this.typeAliases);

    // Build prompt construction code
    const promptCode = this.buildPromptString(prompt.segments, this.typeHints);
    const argsStr = functionArgs
      .map(
        (arg) =>
          `${arg}: ${variableTypeToString(
            this.typeHints[arg] || { type: "primitiveType", value: "string" },
            this.typeAliases
          )}`
      )
      .join(", ");
    return promptFunction.default({
      variableName,
      argsStr,
      typeString,
      promptCode,
      zodSchema,
    });
  }
}

/**
 * Convenience function to generate TypeScript code from an ADL program
 */
export function generateTypeScript(program: ADLProgram): string {
  const generator = new TypeScriptGenerator();
  return generator.generate(program).output;
}
