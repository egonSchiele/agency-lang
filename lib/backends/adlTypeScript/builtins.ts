import * as builtinFunctionsInput from "@/templates/builtinFunctions/input";

/**
 * Maps ADL built-in function names to TypeScript equivalents
 */
export const BUILTIN_FUNCTIONS: Record<string, string> = {
  print: "console.log",
  input: "_builtinInput",
};

/**
 * Maps an ADL function name to its TypeScript equivalent
 * Returns the original name if not a built-in
 */
export function mapFunctionName(functionName: string): string {
  return BUILTIN_FUNCTIONS[functionName] || functionName;
}

/**
 * Generates helper functions for built-in ADL functions
 */
export function generateBuiltinHelpers(usedBuiltins: Set<string>): string {
  const inputFunc = builtinFunctionsInput.default({});

  const helpers: string[] = [];
  if (usedBuiltins.has("input")) {
    helpers.push(inputFunc);
  }

  return helpers.join("\n\n");
}
