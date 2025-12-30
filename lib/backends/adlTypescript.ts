import {
  ADLNode,
  ADLProgram,
  Assignment,
  FunctionCall,
  FunctionDefinition,
  InterpolationSegment,
  Literal,
  PromptLiteral,
  PromptSegment,
  TypeHint,
  VariableType,
} from "@/types";

import { escape } from "@/utils";

/**
 *
 * Generates the standardized imports and OpenAI client setup
 */
function generateImports(): string {
  return `import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});`;
}

/**
 * Maps ADL types to Zod schema strings
 */
function mapTypeToZodSchema(variableType: VariableType): string {
  if (variableType.type === "primitiveType") {
    switch (variableType.value.toLowerCase()) {
      case "number":
        return "z.number()";
      case "string":
        return "z.string()";
      case "boolean":
        return "z.boolean()";
      default:
        // Default to string for unknown types
        return "z.string()";
    }
  } else if (variableType.type === "arrayType") {
    // Recursively handle array element type
    const elementSchema = mapTypeToZodSchema(variableType.elementType);
    return `z.array(${elementSchema})`;
  } else if (variableType.type === "stringLiteralType") {
    return `z.literal("${variableType.value}")`;
  } else if (variableType.type === "numberLiteralType") {
    return `z.literal(${variableType.value})`;
  } else if (variableType.type === "booleanLiteralType") {
    return `z.literal(${variableType.value})`;
  }

  // Fallback (should never reach here)
  return "z.string()";
}

/**
 * Converts a VariableType to a string representation for naming/logging
 */
function variableTypeToString(variableType: VariableType): string {
  if (variableType.type === "primitiveType") {
    return variableType.value;
  } else if (variableType.type === "arrayType") {
    // Recursively build array type string
    return `${variableTypeToString(variableType.elementType)}[]`;
  }
  return "unknown";
}

/**
 * Escapes quotes in strings for TypeScript code generation
 */
function escapeString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Generates TypeScript code for a literal value
 */
function generateLiteral(literal: Literal): string {
  switch (literal.type) {
    case "number":
      return literal.value;
    case "string":
      return `"${escapeString(literal.value)}"`;
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

/**
 * Builds a template literal string from prompt segments
 */
function buildPromptString(
  segments: PromptSegment[],
  typeHints: Map<string, VariableType>
): string {
  const promptParts: string[] = [];

  for (const segment of segments) {
    if (segment.type === "text") {
      const escaped = escape(segment.value);
      promptParts.push(escaped);
    } else {
      // Interpolation segment
      const varName = segment.variableName;
      const varType = typeHints.get(varName);

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
}: {
  variableName: string;
  functionArgs: string[];
  prompt: PromptLiteral;
  variableType: VariableType;
  typeHints: Map<string, VariableType>;
}): string {
  const zodSchema = mapTypeToZodSchema(variableType);
  const typeString = variableTypeToString(variableType);

  // Build prompt construction code
  const promptCode = buildPromptString(prompt.segments, typeHints);

  const argsStr = functionArgs
    .map(
      (arg) =>
        `${arg}: ${variableTypeToString(
          typeHints.get(arg) || { type: "primitiveType", value: "string" }
        )}`
    )
    .join(", ");

  return `async function _${variableName}(${argsStr}): Promise<${typeString}> {
  const prompt = ${promptCode};
  const startTime = performance.now();
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: zodResponseFormat(z.object({
      value: ${zodSchema},
    }), "${variableName}_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable '${variableName}' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable '${variableName}':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}`;
}

/**
 * Maps ADL built-in function names to TypeScript equivalents
 */
const BUILTIN_FUNCTIONS: Record<string, string> = {
  print: "console.log",
};

/**
 * Maps an ADL function name to its TypeScript equivalent
 * Returns the original name if not a built-in
 */
function mapFunctionName(functionName: string): string {
  return BUILTIN_FUNCTIONS[functionName] || functionName;
}

/**
 * Main TypeScript code generator class
 */
export class TypeScriptGenerator {
  private typeHints: Map<string, VariableType> = new Map();
  private generatedFunctions: string[] = [];
  private generatedStatements: string[] = [];
  private variablesInScope: Set<string> = new Set();

  /**
   * Generate TypeScript code from an ADL program
   */
  generate(program: ADLProgram): string {
    // Pass 1: Collect all type hints
    for (const node of program.nodes) {
      if (node.type === "typeHint") {
        this.processTypeHint(node);
      }
    }

    // Pass 2: Process all nodes and generate code
    for (const node of program.nodes) {
      this.processNode(node);
    }

    // Build final output
    const output: string[] = [];

    // Add imports and OpenAI client setup
    output.push(generateImports());
    output.push(""); // Empty line separator

    // Add generated functions
    if (this.generatedFunctions.length > 0) {
      output.push(...this.generatedFunctions);
      output.push(""); // Empty line separator
    }

    // Add generated statements
    if (this.generatedStatements.length > 0) {
      output.push(...this.generatedStatements);
    }

    return output.join("\n");
  }

  /**
   * Process a type hint node
   */
  private processTypeHint(node: TypeHint): void {
    this.typeHints.set(node.variableName, node.variableType);
  }

  /**
   * Process any ADL node
   */
  private processNode(node: ADLNode): void {
    switch (node.type) {
      case "typeHint":
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
      case "number":
      case "string":
      case "variableName":
      case "prompt":
        // Standalone literals at top level
        this.generatedStatements.push(generateLiteral(node) + ";");
        break;
    }
  }

  private processAssignment(node: Assignment): void {
    const { variableName, value } = node;

    if (value.type === "prompt") {
      this.processPromptLiteral(variableName, value);
    } else {
      // Direct assignment for other literal types
      const literalCode = generateLiteral(value);
      this.generatedStatements.push(`const ${variableName} = ${literalCode};`);
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
    const variableType = this.typeHints.get(variableName) || {
      type: "primitiveType" as const,
      value: "string",
    };
    const functionCode = generatePromptFunction({
      variableName,
      functionArgs: interpolatedVars,
      prompt: node,
      variableType,
      typeHints: this.typeHints,
    });
    this.generatedFunctions.push(functionCode);

    // Generate the function call
    this.generatedStatements.push(
      `const ${variableName} = await _${variableName}(${interpolatedVars.join(
        ", "
      )});`
    );
  }

  /**
   * Process a function definition node
   */
  private processFunctionDefinition(node: FunctionDefinition): void {
    const { functionName, body } = node;

    const functionLines: string[] = [];
    functionLines.push(`function ${functionName}() {`);

    // Process function body
    for (const item of body) {
      if (item.type === "assignment") {
        const assignment = item as Assignment;
        if (assignment.value.type === "prompt") {
          // For prompts in functions, we need special handling
          // This is a simplified version - may need refinement
          functionLines.push(
            `  // TODO: Handle prompt for ${assignment.variableName}`
          );
        } else {
          const literalCode = generateLiteral(assignment.value);
          functionLines.push(
            `  const ${assignment.variableName} = ${literalCode};`
          );
        }
      } else {
        // Standalone literal in function body
        const literalCode = generateLiteral(item as Literal);
        functionLines.push(`  ${literalCode};`);
      }
    }

    functionLines.push("}");
    this.generatedFunctions.push(functionLines.join("\n"));
  }

  /**
   * Process a function call node
   */
  private processFunctionCall(node: FunctionCall): void {
    const functionCallCode = this.generateFunctionCallCode(
      mapFunctionName(node.functionName),
      node.arguments
    );

    this.generatedStatements.push(functionCallCode);
  }

  /**
   * Generates TypeScript code for a function call
   */
  private generateFunctionCallCode(
    functionName: string,
    args: string[]
  ): string {
    const argsString = args.join(", ");
    return `${functionName}(${argsString});`;
  }
}

/**
 * Convenience function to generate TypeScript code from an ADL program
 */
export function generateTypeScript(program: ADLProgram): string {
  const generator = new TypeScriptGenerator();
  return generator.generate(program);
}
