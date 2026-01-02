import * as builtinFunctionsInput from "@/templates/backends/typescriptGenerator/builtinFunctions/input";
import * as builtinFunctionsRead from "@/templates/backends/typescriptGenerator/builtinFunctions/read";
import * as builtinFunctionsFetchJSON from "@/templates/backends/typescriptGenerator/builtinFunctions/fetchJSON";
import * as builtinFunctionsFetch from "@/templates/backends/typescriptGenerator/builtinFunctions/fetch";

/**
 * Maps ADL built-in function names to TypeScript equivalents
 */
export const BUILTIN_FUNCTIONS: Record<string, string> = {
  print: "console.log",
  input: "_builtinInput",
  read: "_builtinRead",
  write: "fs.writeFileSync",
  fetch: "_builtinFetch",
  fetchJSON: "_builtinFetchJSON",
  fetchJson: "_builtinFetchJSON",
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
export function generateBuiltinHelpers(functionsUsed: Set<string>): string {
  const inputFunc = builtinFunctionsInput.default({});
  const readFunc = builtinFunctionsRead.default({});
  const fetchJSONFunc = builtinFunctionsFetchJSON.default({});

  const helpers: string[] = [];
  if (functionsUsed.has("input")) {
    helpers.push(inputFunc);
  }
  if (functionsUsed.has("read")) {
    helpers.push(readFunc);
  }
  if (functionsUsed.has("fetchJSON") || functionsUsed.has("fetchJson")) {
    helpers.push(fetchJSONFunc);
  }
  if (functionsUsed.has("fetch")) {
    const fetchFunc = builtinFunctionsFetch.default({});
    helpers.push(fetchFunc);
  }

  return helpers.join("\n\n");
}
