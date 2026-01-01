import {
  ADLNode,
  ADLProgram,
  Assignment,
  InterpolationSegment,
  Literal,
  PromptLiteral,
  PromptSegment,
  TypeAlias,
  TypeHint,
  VariableType,
} from "@/types";

import * as renderImports from "@/templates/backends/adlTypescript/imports";
import * as promptFunction from "@/templates/backends/adlTypescript/promptFunction";
import {
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "@/types/access";
import { escape } from "@/utils";
import {
  generateBuiltinHelpers,
  mapFunctionName,
} from "./adlTypeScript/builtins";
import { variableTypeToString } from "./adlTypeScript/typeToString";
import { mapTypeToZodSchema } from "./adlTypeScript/typeToZodSchema";
import { MatchBlock } from "@/types/matchBlock";
import { FunctionCall, FunctionDefinition } from "@/types/function";
type TypeHintMap = Record<string, VariableType>;

function generateImports(): string {
  return renderImports.default({});
}

function buildPromptString(
  segments: PromptSegment[],
  typeHints: TypeHintMap
): string {
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
 * Generates an async function for prompt-based assignments
 */
function generatePromptFunction({
  variableName,
  functionArgs = [],
  prompt,
  variableType,
  typeHints,
  typeAliases,
}: {
  variableName: string;
  functionArgs: string[];
  prompt: PromptLiteral;
  variableType: VariableType;
  typeHints: TypeHintMap;
  typeAliases: Record<string, VariableType>;
}): string {
  const zodSchema = mapTypeToZodSchema(variableType, typeAliases);
  const typeString = variableTypeToString(variableType, typeAliases);

  // Build prompt construction code
  const promptCode = buildPromptString(prompt.segments, typeHints);

  const argsStr = functionArgs
    .map(
      (arg) =>
        `${arg}: ${variableTypeToString(
          typeHints[arg] || { type: "primitiveType", value: "string" },
          typeAliases
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

export class TypeScriptFileGenerator {
  private typeHints: TypeHintMap = {};
  private generatedFunctions: string[] = [];
  private generatedStatements: string[] = [];
  private generatedTypeAliases: string[] = [];
  private variablesInScope: Set<string> = new Set();
  private functionsUsed: Set<string> = new Set();
  private typeAliases: Record<string, VariableType> = {};
  /**
   * Generate TypeScript code from an ADL program
   */
  generate(program: ADLProgram): string {
    // Build final output
    const output: string[] = [];

    // Add imports and OpenAI client setup
    output.push(generateImports());
    output.push("");

    const generator = new TypeScriptGenerator({
      variablesInScope: this.variablesInScope,
      typeAliases: this.typeAliases,
      typeHints: this.typeHints,
    });
    const result = generator.generate(program);
    this.functionsUsed = result.functionsUsed;

    // Add built-in helper functions
    output.push(generateBuiltinHelpers(this.functionsUsed));
    output.push("");

    output.push(result.output);

    return output.join("\n");
  }
}
export class TypeScriptGenerator {
  private typeHints: TypeHintMap = {};
  private generatedFunctions: string[] = [];
  private generatedStatements: string[] = [];
  private generatedTypeAliases: string[] = [];
  private variablesInScope: Set<string> = new Set();
  private functionsUsed: Set<string> = new Set();
  private typeAliases: Record<string, VariableType> = {};
  constructor({
    variablesInScope = new Set<string>(),
    typeAliases = {},
    typeHints = {},
  }: {
    variablesInScope?: Set<string>;
    typeAliases?: Record<string, VariableType>;
    typeHints?: TypeHintMap;
  } = {}) {
    this.variablesInScope = variablesInScope;
    this.typeAliases = typeAliases;
    this.typeHints = typeHints;
  }
  /**
   * Generate TypeScript code from an ADL program
   */
  generate(program: ADLProgram): {
    output: string;
    functionsUsed: Set<string>;
  } {
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

    // Pass 3: Process all nodes and generate code
    for (const node of program.nodes) {
      this.processNode(node);
    }

    const output: string[] = [];

    output.push(...this.generatedTypeAliases);

    output.push(...this.generatedFunctions);

    output.push(this.generatedStatements.join(""));

    return {
      output: output.filter(Boolean).join("\n"),
      functionsUsed: this.functionsUsed,
    };
  }

  private processTypeAlias(node: TypeAlias): void {
    this.typeAliases[node.aliasName] = node.aliasedType;
    const typeAliasStr = this.typeAliasToString(node);
    this.generatedTypeAliases.push(typeAliasStr);
  }

  private typeAliasToString(node: TypeAlias): string {
    const aliasedTypeStr = variableTypeToString(
      node.aliasedType,
      this.typeAliases
    );
    return `type ${node.aliasName} = ${aliasedTypeStr};`;
  }

  private processTypeHint(node: TypeHint): void {
    if (node.variableType.type === "typeAliasVariable") {
      if (!(node.variableType.aliasName in this.typeAliases)) {
        throw new Error(
          `Type alias '${node.variableType.aliasName}' not defined for variable '${node.variableName}'.`
        );
      }
    }
    this.typeHints[node.variableName] = node.variableType;
  }

  /**
   * Process any ADL node
   */
  private processNode(node: ADLNode): void {
    switch (node.type) {
      case "typeHint":
      case "typeAlias":
        // Already processed in first pass
        break;
      case "assignment":
        this.processAssignment(node);
        break;
      case "function":
        this.processFunctionDefinition(node);
        break;
      case "functionCall":
        this.processFunctionCall(node);
        break;
      case "accessExpression":
        const code = this.processAccessExpression(node);
        this.generatedStatements.push(code + "\n");
        break;
      case "matchBlock":
        const matchBlockCode = this.processMatchBlock(node);
        this.generatedStatements.push(matchBlockCode + "\n");
        break;
      case "number":
      case "string":
      case "variableName":
      case "prompt":
        // Standalone literals at top level
        this.generatedStatements.push(this.generateLiteral(node) + "\n");
        break;
      case "returnStatement":
        const generator = new TypeScriptGenerator({
          variablesInScope: this.variablesInScope,
          typeAliases: this.typeAliases,
          typeHints: this.typeHints,
        });
        const result = generator.generate({
          type: "adlProgram",
          nodes: [node.value],
        });
        this.functionsUsed = new Set([
          ...this.functionsUsed,
          ...result.functionsUsed,
        ]);
        this.generatedStatements.push(`return ${result.output}` + "\n");
        break;
    }
  }

  private processAccessExpression(node: AccessExpression): string {
    switch (node.expression.type) {
      case "dotProperty":
        return this.processDotProperty(node.expression);
      case "indexAccess":
        return this.processIndexAccess(node.expression);
      case "dotFunctionCall":
        return this.processDotFunctionCall(node.expression);
    }
  }

  private processMatchBlock(node: MatchBlock): string {
    let lines = [`switch (${this.generateLiteral(node.expression)}) {`];

    for (const caseItem of node.cases) {
      let caseValueCode: string;
      if (caseItem.caseValue === "_") {
        caseValueCode = "default";
      } else if (caseItem.caseValue.type === "accessExpression") {
        caseValueCode = this.processAccessExpression(caseItem.caseValue);
      } else {
        caseValueCode = this.generateLiteral(caseItem.caseValue);
      }
      lines.push(`  case ${caseValueCode}:`);
      const caseBodyGenerator = new TypeScriptGenerator({
        variablesInScope: this.variablesInScope,
        typeAliases: this.typeAliases,
        typeHints: this.typeHints,
      });
      const caseBodyResult = caseBodyGenerator.generate({
        type: "adlProgram",
        nodes: [caseItem.body],
      });
      this.functionsUsed = new Set([
        ...this.functionsUsed,
        ...caseBodyResult.functionsUsed,
      ]);
      const caseBodyLines = caseBodyResult.output
        .split("\n")
        .map((line) => "    " + line);
      lines.push(...caseBodyLines);
      lines.push("    break;");
    }

    lines.push("}");
    return lines.join("\n");
  }

  private processDotProperty(node: DotProperty): string {
    const generator = new TypeScriptGenerator({
      variablesInScope: this.variablesInScope,
      typeAliases: this.typeAliases,
      typeHints: this.typeHints,
    });
    const result = generator.generate({
      type: "adlProgram",
      nodes: [node.object],
    });
    this.functionsUsed = new Set([
      ...this.functionsUsed,
      ...result.functionsUsed,
    ]);
    const objectCode = result.output;

    const propertyAccess = `${objectCode}.${node.propertyName}`;
    return propertyAccess;
  }

  private processDotFunctionCall(node: DotFunctionCall): string {
    const generator = new TypeScriptGenerator({
      variablesInScope: this.variablesInScope,
      typeAliases: this.typeAliases,
      typeHints: this.typeHints,
    });
    const result = generator.generate({
      type: "adlProgram",
      nodes: [node.object],
    });
    this.functionsUsed = new Set([
      ...this.functionsUsed,
      ...result.functionsUsed,
    ]);
    const objectCode = result.output;
    const functionCallCode = this.generateFunctionCallExpression(
      node.functionCall
    );
    const fullCall = `${objectCode}.${functionCallCode}`;
    return fullCall;
  }

  private processIndexAccess(node: IndexAccess): string {
    const generator = new TypeScriptGenerator({
      variablesInScope: this.variablesInScope,
      typeAliases: this.typeAliases,
      typeHints: this.typeHints,
    });
    const arrayResult = generator.generate({
      type: "adlProgram",
      nodes: [node.array],
    });
    this.functionsUsed = new Set([
      ...this.functionsUsed,
      ...arrayResult.functionsUsed,
    ]);
    const arrayCode = arrayResult.output;

    const indexResult = generator.generate({
      type: "adlProgram",
      nodes: [node.index],
    });
    this.functionsUsed = new Set([
      ...this.functionsUsed,
      ...indexResult.functionsUsed,
    ]);
    const indexCode = indexResult.output;

    const accessCode = `${arrayCode}[${indexCode}]`;
    return accessCode;
  }

  private processAssignment(node: Assignment): void {
    const { variableName, value } = node;

    if (value.type === "prompt") {
      this.processPromptLiteral(variableName, value);
    } else if (value.type === "functionCall") {
      // Handle function call assignment
      this.functionsUsed.add(value.functionName);
      const functionCallCode = this.generateFunctionCallExpression(value);
      this.generatedStatements.push(
        `const ${variableName} = await ${functionCallCode};` + "\n"
      );
    } else if (value.type === "accessExpression") {
      // Handle access expression assignment
      const accessCode = this.processAccessExpression(value);
      this.generatedStatements.push(
        `const ${variableName} = ${accessCode};` + "\n"
      );
    } else {
      // Direct assignment for other literal types
      const literalCode = this.generateLiteral(value);
      this.generatedStatements.push(
        `const ${variableName} = ${literalCode};` + "\n"
      );
    }

    // Track this variable as in scope
    this.variablesInScope.add(variableName);
  }

  private processPromptLiteral(
    variableName: string,
    node: PromptLiteral
  ): void {
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

    // Generate async function for prompt-based assignment
    const variableType = this.typeHints[variableName] || {
      type: "primitiveType" as const,
      value: "string",
    };
    const functionCode = generatePromptFunction({
      variableName,
      functionArgs: interpolatedVars,
      prompt: node,
      variableType,
      typeHints: this.typeHints,
      typeAliases: this.typeAliases,
    });
    this.generatedFunctions.push(functionCode);

    // Generate the function call
    this.generatedStatements.push(
      `const ${variableName} = await _${variableName}(${interpolatedVars.join(
        ", "
      )});` + "\n"
    );
  }

  /**
   * Process a function definition node
   */
  private processFunctionDefinition(node: FunctionDefinition): void {
    const { functionName, body } = node;

    const functionLines: string[] = [];
    functionLines.push(`async function ${functionName}() {`);

    const bodyGenerator = new TypeScriptGenerator({
      variablesInScope: this.variablesInScope,
      typeAliases: this.typeAliases,
      typeHints: this.typeHints,
    });
    const result = bodyGenerator.generate({
      type: "adlProgram",
      nodes: body,
    });

    this.functionsUsed = new Set([
      ...this.functionsUsed,
      ...result.functionsUsed,
    ]);
    functionLines.push(result.output);
    functionLines.push("}");
    this.generatedFunctions.push(functionLines.join("\n"));
  }

  /**
   * Process a function call node
   */
  private processFunctionCall(node: FunctionCall): void {
    this.functionsUsed.add(node.functionName);
    const functionCallCode = this.generateFunctionCallExpression(node);

    this.generatedStatements.push(functionCallCode + "\n");
  }

  /**
   * Generates TypeScript expression for a function call (without semicolon)
   */
  private generateFunctionCallExpression(node: FunctionCall): string {
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

  private generateLiteral(literal: Literal): string {
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
        return `/* prompt: ${text} */`;
    }
  }
}

/**
 * Convenience function to generate TypeScript code from an ADL program
 */
export function generateTypeScript(program: ADLProgram): string {
  const generator = new TypeScriptFileGenerator();
  return generator.generate(program);
}
