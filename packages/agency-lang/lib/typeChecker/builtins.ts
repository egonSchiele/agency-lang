import { BuiltinSignature } from "./types.js";

const string = { type: "primitiveType", value: "string" } as const;
const number = { type: "primitiveType", value: "number" } as const;
const boolean = { type: "primitiveType", value: "boolean" } as const;
const voidT = { type: "primitiveType", value: "void" } as const;
const stringArray = { type: "arrayType", elementType: string } as const;
const anyArray = {
  type: "arrayType",
  elementType: { type: "primitiveType", value: "any" } as const,
} as const;

/**
 * Signatures for builtin / auto-imported functions that the typechecker
 * needs to know about.
 *
 * NOTE: many entries here (print, fetch, read, etc.) are also defined as
 * real functions in stdlib/index.agency. Ideally the typechecker would
 * resolve them through the SymbolTable instead of hardcoding signatures.
 * Until that lands, hardcoding here keeps arg-count and return-type
 * checking working for callers.
 */
export const BUILTIN_FUNCTION_TYPES: Record<string, BuiltinSignature> = {
  // --- IO / debugging ---
  print: { params: ["any"], returnType: voidT },
  printJSON: { params: ["any"], returnType: voidT },
  input: { params: [string], returnType: string },
  read: { params: [string], returnType: string },
  readImage: { params: [string], returnType: string },
  write: { params: [string, string], returnType: voidT },
  fetch: { params: [string], returnType: string },
  fetchJSON: { params: [string], returnType: "any" },
  notify: { params: [string, string], returnType: boolean },
  sleep: { params: [number], returnType: voidT },
  round: { params: [number, number], minParams: 1, returnType: number },
  llm: { params: ["any", "any"], minParams: 1, returnType: string },
  emit: { params: ["any"], returnType: voidT },

  // --- Object / array helpers (auto-imported from stdlib/index.agency) ---
  range: { params: [number, number], minParams: 1, returnType: { type: "arrayType", elementType: number } },
  keys: { params: ["any"], returnType: stringArray },
  values: { params: ["any"], returnType: anyArray },
  entries: { params: ["any"], returnType: anyArray },
  mostCommon: { params: [anyArray], returnType: "any" },

  // --- Result type (lib/runtime/result.ts) ---
  success: { params: ["any"], returnType: "any" },
  failure: { params: ["any", "any"], minParams: 1, returnType: "any" },
  isSuccess: { params: ["any"], returnType: boolean },
  isFailure: { params: ["any"], returnType: boolean },

  // --- Checkpoint / rewind ---
  restore: { params: ["any", "any"], minParams: 1, returnType: voidT },
};
