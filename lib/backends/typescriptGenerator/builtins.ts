import * as builtinFunctionsInput from "../../templates/backends/typescriptGenerator/builtinFunctions/input.js";
import * as builtinFunctionsRead from "../../templates/backends/typescriptGenerator/builtinFunctions/read.js";
import * as builtinFunctionsReadImage from "../../templates/backends/typescriptGenerator/builtinFunctions/readImage.js";
import * as builtinFunctionsFetchJSON from "../../templates/backends/typescriptGenerator/builtinFunctions/fetchJSON.js";
import * as builtinFunctionsFetch from "../../templates/backends/typescriptGenerator/builtinFunctions/fetch.js";
import * as builtinFunctionsSleep from "../../templates/backends/typescriptGenerator/builtinFunctions/sleep.js";
import { BUILTIN_FUNCTIONS } from "@/config.js";

/**
 * Maps an Agency function name to its TypeScript equivalent
 * Returns the original name if not a built-in
 */
export function mapFunctionName(functionName: string): string {
  return BUILTIN_FUNCTIONS[functionName] || functionName;
}

/**
 * Generates helper functions for built-in Agency functions
 */
export function generateBuiltinHelpers(functionsUsed: Set<string>): string {
  const inputFunc = builtinFunctionsInput.default({});
  const readFunc = builtinFunctionsRead.default({});
  const fetchJSONFunc = builtinFunctionsFetchJSON.default({});
  const helpers: string[] = [];
  // all included by default, since we don't want to have conditional imports in the generated code

  /*
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
  if (functionsUsed.has("readImage")) {
    const readImageFunc = builtinFunctionsReadImage.default({});
    helpers.push(readImageFunc);
  } */
  /* 
  already included by default
    if (functionsUsed.has("sleep")) {
      const sleepFunc = builtinFunctionsSleep.default({});
      helpers.push(sleepFunc);
    }
   */
  return helpers.join("\n\n");
}
