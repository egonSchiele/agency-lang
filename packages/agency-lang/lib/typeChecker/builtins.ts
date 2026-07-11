import { VariableType } from "../types.js";
import { BuiltinSignature } from "./types.js";
import {
  ANY_T,
  BOOLEAN_T as boolean,
  NUMBER_T as number,
  STRING_T as string,
  NULL_T as nullT,
  VOID_T as voidT,
} from "./primitives.js";


const anyArray = { type: "arrayType", elementType: ANY_T } as const;
const stringArray = { type: "arrayType", elementType: string } as const;

const optional = (t: VariableType): VariableType => ({
  type: "unionType",
  types: [t, nullT],
});

/** Per-provider API-key map, mirroring `SmolConfig["apiKey"]` (see
 *  lib/runtime/llmClient.ts) and `agency.json` `client.apiKey`. Every field is
 *  optional so `{}` and any partial subset type-check. This is the ONLY form
 *  accepted by `llm()`'s `apiKey` option — a bare string is intentionally
 *  rejected so a non-OpenAI key can never be silently routed to `openAi`. */
const apiKeyObject: VariableType = {
  type: "objectType",
  properties: [
    { key: "openAi", value: optional(string) },
    { key: "google", value: optional(string) },
    { key: "anthropic", value: optional(string) },
    { key: "ollama", value: optional(string) },
    { key: "openRouter", value: optional(string) },
    { key: "deepInfra", value: optional(string) },
    { key: "liteLlm", value: optional(string) },
    { key: "openAiCompat", value: optional(string) },
  ],
};

/**
 * Options accepted by `llm()`'s second argument. Mirrors the user-facing
 * fields of smoltalk's PromptConfig (lib/runtime/llmClient.ts) — the runtime
 * forwards everything to smoltalk. `metadata` accepts arbitrary shape, so
 * we type it as optional `any` and skip structural checking.
 */
const llmOptionProperties: { key: string; value: VariableType }[] = [
    { key: "model", value: optional(string) },
    { key: "provider", value: optional(string) },
    // Per-provider key map only (see `apiKeyObject`) — no bare-string
    // shorthand, so a key is never silently routed to the wrong provider.
    // Runtime: `toSmolConfig`.
    { key: "apiKey", value: optional(apiKeyObject) },
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
    // Provider hosted tools (server-side) to enable for this call, by
    // capability name, e.g. ["web_search"]. Forwarded to smoltalk via the
    // LLMClient PromptConfig. See lib/runtime/llmClient.ts.
    { key: "hostedTools", value: optional(stringArray) },
    // `memory: true` enables retrieval/injection on this llm() call.
    // The object form is reserved for future config (e.g. per-call
    // model override); for now only the boolean form is wired.
    { key: "memory", value: optional(boolean) },
    // Per-call cap on characters of a tool result fed back to the LLM
    // (overrides agency.json `client.maxToolResultChars`). `0` disables.
    { key: "maxToolResultChars", value: optional(number) },
    // Resilience policy. Defaults: retries 2, timeout 10min, backoff 500ms
    // x2 capped at 10s. `retries: 0` / `timeout: 0` disable. `setLlmOptions`
    // sets the same per-branch.
    //
    // KEEP IN SYNC with `RetryConfig` in `lib/runtime/llmRetry.ts` — this is
    // the Agency-AST mirror of that TS type. The TS side (`LlmOpts`,
    // `LlmDefaults`) already extends `RetryConfig`; this list cannot, because
    // it lives in the AST type universe rather than TS, so it must be
    // updated by hand when fields are added.
    { key: "retries", value: optional(number) },
    { key: "timeout", value: optional(number) },
    {
      key: "backoff",
      value: optional({
        type: "objectType",
        properties: [
          { key: "initial", value: optional(number) },
          { key: "factor", value: optional(number) },
          { key: "max", value: optional(number) },
        ],
      }),
    },
    // Validation retries: re-ask the model when structured output fails
    // schema validation. `0` disables. Independent of `retries`.
    { key: "validationRetries", value: optional(number) },
    // `any` already accepts undefined, so no need to wrap in optional.
    { key: "metadata", value: ANY_T },
];

const llmOptions: VariableType = {
  type: "objectType",
  properties: llmOptionProperties,
};

/**
 * The same option fields exposed as named arguments, so callers may write
 * `llm(prompt, model: "…", tools: [...])` instead of passing an options
 * object. Derived from {@link llmOptionProperties} so the two forms never
 * drift. Codegen folds these named args back into the options object.
 */
const llmNamedOptions: Record<string, VariableType> = Object.assign(
  // Null-prototype: the checker tests membership with `in`, so a normal
  // prototype would make user-controlled names like `__proto__` /
  // `constructor` appear "allowed" via the prototype chain (and codegen
  // would then emit `{ "__proto__": ... }`, mutating the object prototype).
  Object.create(null),
  Object.fromEntries(llmOptionProperties.map((p) => [p.key, p.value])),
);

/** `llm()`'s first argument: a plain string, or an array mixing text strings
 *  and `image()` / `file()` attachments.
 *
 *  The attachment element references the `Attachment` type alias defined in
 *  `stdlib/thread.agency` (the single source of truth) rather than restating
 *  its shape here — it resolves against the type-alias table the same way any
 *  user type does. `image()` / `file()` return `Attachment`, so a call like
 *  `llm(["hi", image("x")])` type-checks; `llm([42])` does not. */
const attachmentRef: VariableType = {
  type: "typeAliasVariable",
  aliasName: "Attachment",
};

const llmContent: VariableType = {
  type: "unionType",
  types: [
    string,
    {
      type: "arrayType",
      elementType: { type: "unionType", types: [string, attachmentRef] },
    },
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
/**
 * Methods callable on any Agency function / tool value
 * (`fn.describe("…")`, `fn.preapprove()`, `fn.rename("…")`). Declared here
 * as plain {@link BuiltinSignature}s so adding a new one is a one-line type
 * entry — the typechecker validates arity + arg types generically via
 * `validatePrimitiveMethodCall` (see synthesizer.ts) rather than needing
 * bespoke checker code.
 *
 * `partial` is intentionally NOT here: it takes named arguments validated
 * against the *base* function's parameter list, which the generic
 * signature path can't express, so it keeps its own logic in the checker.
 *
 * Return type is `any` for all three: each returns a new function/tool, and
 * the chain (`fn.partial(...).describe(...).rename(...)`) is resolved as
 * `any` so further method calls type-check.
 */
export const AGENCY_FUNCTION_METHOD_TYPES: Record<string, BuiltinSignature> = {
  describe: {
    params: [string],
    returnType: "any",
    description:
      "Override the tool description an LLM sees for this function. Returns a new tool.",
  },
  preapprove: {
    params: [],
    returnType: "any",
    description:
      "Auto-approve every interrupt this function raises. Returns a new tool.",
  },
  rename: {
    params: [string],
    returnType: "any",
    description:
      "Give this tool a distinct name (the name the LLM sees and that tool-call dispatch matches). Use when deriving several tools from one function — `.partial()`/`.describe()`/import aliases keep the base name, which collides in a single `llm({tools})` call. Returns a new tool.",
  },
};

export const BUILTIN_FUNCTION_TYPES: Record<string, BuiltinSignature> = {
  // --- LLM primitive ---
  llm: {
    params: [llmContent, llmOptions],
    minParams: 1,
    returnType: string,
    acceptsNamedArgs: llmNamedOptions,
    description:
      "Send a prompt to an LLM and return its response. The prompt is a string, or an array of text strings and image()/file() attachments. The return type is inferred from the call-site annotation and compiled to a JSON schema for structured output.",
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

  // `throw("message")` lowers to `throw new Error("message")` (see
  // processFunctionCall in typescriptBuilder.ts). Registered here so the
  // undefined-function diagnostic doesn't warn on legitimate usage.
  throw: {
    params: ["any"],
    returnType: voidT,
    description:
      "Raise an exception. Unwinds the current function/node. Argument is coerced to a string for the Error message.",
  },

  // `_emit(data)` is a compiler intrinsic (handled by name in
  // typescriptBuilder.ts) with no `.js` import backing it, so the
  // undefined-function diagnostic would otherwise warn wherever the
  // `emit` stdlib wrapper calls it. Registered here so `std::statelog`
  // (which now owns `emit`) type-checks clean.
  _emit: {
    params: ["any"],
    returnType: voidT,
    description: "Emit a custom event to the host via the onEmit callback.",
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
    // `shared: true` opts into pointer-sharing globals across all
    // branches (threads stay branch-local). Default is isolated.
    acceptsNamedArgs: { shared: boolean },
    description:
      "Run multiple branches in parallel and wait for all of them to finish. Returns an array of results, one per item. Use as `fork(items) as <name> { ... }`. Pass `shared: true` to share globals across branches.",
  },
  race: {
    params: [anyArray],
    returnType: "any",
    acceptsBlock: true,
    acceptsNamedArgs: { shared: boolean },
    description:
      "Like `fork`, but returns as soon as the first branch completes and cancels the rest. Use as `race(items) as <name> { ... }`. Pass `shared: true` to share globals across branches.",
  },

  callback: {
    params: [string],
    returnType: "any",
    acceptsBlock: true,
    description:
      "Register a callback. Use as `callback('<eventName>') as data { ... }`. The block receives event data as an argument.",
  },
};
