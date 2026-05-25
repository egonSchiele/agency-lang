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
  llm: {
    params: ["any", llmOptions],
    minParams: 1,
    returnType: string,
    description:
      "Send a prompt to an LLM and return its response. The return type is inferred from the call-site annotation and compiled to a JSON schema for structured output.",
  },

  // --- Result type (lib/runtime/result.ts) ---
  success: {
    params: ["any"],
    returnType: "any",
    description: "Wrap a value in a successful `Result`.",
  },
  failure: {
    params: ["any", "any"],
    minParams: 1,
    returnType: "any",
    description: "Wrap an error (and optionally a value) in a failed `Result`.",
  },
  isSuccess: {
    params: ["any"],
    returnType: boolean,
    description: "Check whether a `Result` is a success.",
  },
  isFailure: {
    params: ["any"],
    returnType: boolean,
    description: "Check whether a `Result` is a failure.",
  },

  // --- Checkpoint / rewind ---
  restore: {
    params: ["any", "any"],
    returnType: voidT,
    description:
      "Restore execution to a previously captured checkpoint. Accepts a checkpoint object or ID and an options object (e.g. `{ maxRestores: 3 }` or variable overrides).",
  },

  // --- Handler outcomes (reserved names) ---
  approve: {
    params: ["any"],
    minParams: 0,
    returnType: "any",
    description:
      "Inside a `handle ... with` block, approve the wrapped action (optionally substituting a return value).",
  },
  reject: {
    params: ["any"],
    minParams: 0,
    returnType: "any",
    description: "Inside a `handle ... with` block, block the wrapped action.",
  },
  propagate: {
    params: [],
    returnType: "any",
    description:
      "Inside a `handle ... with` block, pass the interrupt up to the next handler in the chain.",
  },

  // --- Checkpointing ---
  checkpoint: {
    params: [],
    returnType: number,
    description:
      "Take a snapshot of the current execution state and return a checkpoint ID.",
  },
  getCheckpoint: {
    params: [number],
    returnType: "any",
    description: "Return the full checkpoint object for a given checkpoint ID.",
  },

  // --- Concurrency (language constructs with block arguments) ---
  // `fork` and `race` are special — they take a `string[]` of labels plus a
  // block, and their return type depends on the block body. We type the
  // return as `any` for now (no generic-block inference yet) but mark them
  // `acceptsBlock` so the typechecker doesn't reject the call shape, and
  // populate `description` so the LSP hover shows useful docs.
  fork: {
    params: [anyArray],
    returnType: anyArray,
    acceptsBlock: true,
    description:
      "Run multiple branches in parallel and wait for all of them to finish. Returns an array of results, one per item. Use as `fork(items) as <name> { ... }`.",
  },
  race: {
    params: [anyArray],
    returnType: "any",
    acceptsBlock: true,
    description:
      "Like `fork`, but returns as soon as the first branch completes and cancels the rest. Use as `race(items) as <name> { ... }`.",
  },

  callback: {
    params: [string],
    returnType: "any",
    acceptsBlock: true,
    description:
      "Register a callback. Use as `callback('<eventName>') as data { ... }`. The block receives event data as an argument.",
  },
};
