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
 * Stdlib functions (`print`, `read`, `fetch`, `range`, etc.) used to live
 * here too. They are now resolved through `importedFunctions` via the
 * auto-injected `import { ... } from "std::index"` statement, using the
 * real signatures from `stdlib/index.agency`. This means a user `def
 * print()` correctly shadows the stdlib version with no special-casing.
 *
 * `llm` stays here — the runtime implements it as a primitive, not a
 * stdlib wrapper, and its argument is structurally typed.
 */
export const BUILTIN_FUNCTION_TYPES: Record<string, BuiltinSignature> = {
  // --- LLM primitive ---
  llm: { params: ["any", llmOptions], minParams: 1, returnType: string },

  // --- Result type (lib/runtime/result.ts) ---
  success: { params: ["any"], returnType: "any" },
  failure: { params: ["any", "any"], minParams: 1, returnType: "any" },
  isSuccess: { params: ["any"], returnType: boolean },
  isFailure: { params: ["any"], returnType: boolean },

  // --- Checkpoint / rewind ---
  restore: { params: ["any", "any"], returnType: voidT },

  // --- Handler outcomes (reserved names) ---
  approve: { params: ["any"], minParams: 0, returnType: "any" },
  reject: { params: ["any"], minParams: 0, returnType: "any" },
  propagate: { params: [], returnType: "any" },

  // --- Checkpointing ---
  checkpoint: { params: [], returnType: number },
  getCheckpoint: { params: [number], returnType: "any" },
  // --- Runtime context (compile-time rewrite to __ctx) ---
  // Lowered to the `__ctx` identifier in lib/backends/typescriptBuilder.ts.
  // No TS implementation; pure codegen. Intentionally NOT in BUILTIN_FUNCTIONS
  // (lib/config.ts) since that registry is for runtime helper bindings.
  getContext: { params: [], returnType: contextType },
};
