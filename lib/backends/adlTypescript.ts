import {
  ADLProgram,
  ADLNode,
  TypeHint,
  Assignment,
  Literal,
  FunctionDefinition,
  FunctionCall,
  VariableType,
  PrimitiveType,
  ArrayType,
} from "../types";

/**
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
    return `${variableTypeToString(variableType.elementType)}_array`;
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
      // Prompt literals should be handled in assignment context
      return `/* prompt: ${literal.text} */`;
  }
}

/**
 * Generates an async function for prompt-based assignments
 */
function generatePromptFunction(
  variableName: string,
  promptText: string,
  variableType: VariableType
): string {
  const zodSchema = mapTypeToZodSchema(variableType);
  const escapedPrompt = escapeString(promptText);
  const typeString = variableTypeToString(variableType);

  return `async function _${variableName}() {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-2024-08-06",
    messages: [
      {
        role: "user",
        content: "${escapedPrompt}",
      },
    ],
    response_format: zodResponseFormat(z.object({
      value: ${zodSchema},
    }), "${typeString}_response"),
  });
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

  /**
   * Process an assignment node
   */
  private processAssignment(node: Assignment): void {
    const { variableName, value } = node;

    if (value.type === "prompt") {
      // Generate async function for prompt-based assignment
      const variableType = this.typeHints.get(variableName) || {
        type: "primitiveType" as const,
        value: "string",
      };
      const functionCode = generatePromptFunction(
        variableName,
        value.text,
        variableType
      );
      this.generatedFunctions.push(functionCode);

      // Generate the function call
      this.generatedStatements.push(
        `const ${variableName} = await _${variableName}();`
      );
    } else {
      // Direct assignment for other literal types
      const literalCode = generateLiteral(value);
      this.generatedStatements.push(`const ${variableName} = ${literalCode};`);
    }
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
