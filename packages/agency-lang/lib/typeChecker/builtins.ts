import { VariableType } from "../types.js";
import { BuiltinSignature } from "./types.js";
import {
  ANY_T,
  BOOLEAN_T as boolean,
  NUMBER_T as number,
  STRING_T as string,
  UNDEFINED_T as undef,
  VOID_T as voidT,
} from "./primitives.js";

const stringArray = { type: "arrayType", elementType: string } as const;
const anyArray = { type: "arrayType", elementType: ANY_T } as const;

const optional = (t: VariableType): VariableType => ({
  type: "unionType",
  types: [t, undef],
});

/**
 * Options accepted by `llm()`'s second argument. Mirrors the user-facing
 * fields of smoltalk's PromptConfig (lib/runtime/llmClient.ts) — the runtime
 * forwards everything to smoltalk. `metadata` accepts arbitrary shape, so
 * we type it as optional `any` and skip structural checking.
 */
const llmOptions: VariableType = {
  type: "objectType",
  properties: [
    { key: "model", value: optional(string) },
    { key: "provider", value: optional(string) },
    { key: "apiKey", value: optional(string) },
    { key: "maxTokens", value: optional(number) },
    { key: "temperature", value: optional(number) },
    { key: "stream", value: optional(boolean) },
    {
      key: "reasoningEffort",
      value: optional({
        type: "unionType",
        types: [
          { type: "stringLiteralType", value: "low" },
          { type: "stringLiteralType", value: "medium" },
          { type: "stringLiteralType", value: "high" },
        ],
      }),
    },
    {
      key: "thinking",
      value: optional({
        type: "objectType",
        properties: [
          { key: "enabled", value: boolean },
          { key: "budgetTokens", value: optional(number) },
        ],
      }),
    },
    { key: "tools", value: optional(anyArray) },
    // `memory: true` enables retrieval/injection on this llm() call.
    // The object form is reserved for future config (e.g. per-call
    // model override); for now only the boolean form is wired.
    { key: "memory", value: optional(boolean) },
    // `any` already accepts undefined, so no need to wrap in optional.
    { key: "metadata", value: ANY_T },
  ],
};

/**
 * Public shape returned by `getContext()`. Mirrors the `Context` type
 * defined in `lib/runtime/publicContext.ts`. We model `memoryManager` as
 * optional `any` because the agency type system doesn't model class
 * instances; users access methods through the runtime side (TS bindings),
 * not directly via field access in agency code.
 */
const contextType: VariableType = {
  type: "objectType",
  properties: [
    { key: "memoryManager", value: optional(ANY_T) },
  ],
};

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
  print: { params: [], restParam: "any", returnType: voidT },
  printJSON: { params: [], restParam: "any", returnType: voidT },
  input: { params: [string], returnType: string },
  read: { params: [string], returnType: string },
  readImage: { params: [string], returnType: string },
  write: { params: [string, string], returnType: voidT },
  fetch: { params: [string], returnType: string },
  fetchJSON: { params: [string], returnType: "any" },
  notify: { params: [string, string], returnType: boolean },
  sleep: { params: [number], returnType: voidT },
  round: { params: [number, number], returnType: number },
  llm: { params: ["any", llmOptions], minParams: 1, returnType: string },
  emit: { params: [], restParam: "any", returnType: voidT },

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
  restore: { params: ["any", "any"], returnType: voidT },

  // --- Runtime context (compile-time rewrite to __ctx) ---
  // Lowered to the `__ctx` identifier in lib/backends/typescriptBuilder.ts.
  // No TS implementation; pure codegen. Intentionally NOT in BUILTIN_FUNCTIONS
  // (lib/config.ts) since that registry is for runtime helper bindings.
  getContext: { params: [], returnType: contextType },
};
