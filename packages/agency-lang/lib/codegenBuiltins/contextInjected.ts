import type { VariableType } from "../types.js";
import {
  BOOLEAN_T as boolean,
  NUMBER_T as number,
  STRING_T as string,
  VOID_T as voidT,
  ANY_T,
} from "../typeChecker/primitives.js";

/**
 * Registry of "context-injected builtins": agency-callable identifiers
 * whose call sites are rewritten by the TypeScript builder to inject
 * runtime locals as the first three positional arguments.
 *
 *   agency:    __internal_recall(query)
 *   generated: await __internal_recall(__ctx, __stateStack, __threads, query)
 *
 * `__stateStack` is required by per-branch reads (e.g., std::thread's
 * `getCost` / `getTokens`) and is always in scope inside function/node
 * bodies. `__threads` is required by message-pushing builtins
 * (`*Message`) and is also always in scope. Builtins that don't need
 * one of these accept it as an unused `_stack` / `_threads` param.
 *
 * Used as the single source of truth for two consumers:
 *   - the typechecker (via `BUILTIN_FUNCTION_TYPES`) for arg/return
 *     type validation against the user-visible signature;
 *   - the TypeScript builder for the codegen rewrite that prepends
 *     the three locals and emits a direct (non-`__call`) function
 *     invocation.
 *
 * Adding a new context-injected builtin: (1) add an entry here with
 * the user-visible signature, (2) export the TS implementation under
 * the same name from one of the importable modules in `lib/stdlib/`
 * (today: `memory.ts`, `thread.ts`). The TS impl must take
 * `(ctx, stack, threads, ...userParams)`. The arity-parity test in
 * `contextInjected.test.ts` will fail loudly if (1) and (2) drift.
 */
export type ContextInjectedBuiltin = {
  /** Agency-side name. MUST start with `__internal_` so it is
   *  routed by the codegen's `__`-prefixed direct-call branch and
   *  is sufficiently distinct from user identifiers. */
  name: string;
  /** Package-style import specifier (as the generated code will see
   *  it) for the module that exports the TS implementation. Used by
   *  the TypeScript builder to emit one `import { ... } from "..."`
   *  block per source module — keeps the "where the impl lives" fact
   *  next to the rest of the entry instead of hardcoded into the
   *  codegen. */
  from: string;
  /** Param types as the user calls the function. The TS impl
   *  receives `__ctx`, `__stateStack`, `__threads`, then these, so
   *  `impl.length === 3 + params.length`. */
  params: (VariableType | "any")[];
  /** If set, calls with at least `minParams` and at most `params.length`
   *  args are valid (i.e. trailing optionals). Same semantics as
   *  `BuiltinSignature.minParams`. */
  minParams?: number;
  /** If set, accepts unlimited extra args of this type after the fixed params. */
  restParam?: VariableType | "any";
  returnType: VariableType | "any";
};

/** Default import source for the memory builtins. Keep the literal
 *  here instead of duplicating it across nine entries. */
const MEMORY_FROM = "agency-lang/stdlib-lib/memory.js";

/** Import source for the std::thread builtins (`*Message`, `getCost`,
 *  `getTokens`). */
const THREAD_FROM = "agency-lang/stdlib-lib/thread.js";

/** Import source for the std::http builtins (`__internal_fetch`,
 *  `__internal_fetchJSON`, `__internal_fetchMarkdown`). Context-
 *  injected so each fetch can pass `ctx.getAbortSignal(stack)` to
 *  the underlying global `fetch` — that's what makes Ctrl-C and
 *  per-branch race-loser aborts tear down in-flight HTTP requests
 *  instead of leaving them running. */
const HTTP_FROM = "agency-lang/stdlib-lib/http.js";

/** Import sources for the other stdlib builtins promoted to
 *  context-injected so they honour Ctrl-C / race-loser / time guard
 *  cancellation. Same wiring as HTTP: each impl receives `__ctx` and
 *  uses `ctx.getAbortSignal(stack)` to tear down its in-flight work
 *  (subprocess via SIGTERM, sleep/input via teardown callbacks). */
const BUILTINS_FROM = "agency-lang/stdlib-lib/builtins.js";
const UI_FROM = "agency-lang/stdlib-lib/ui.js";
const SHELL_FROM = "agency-lang/stdlib-lib/shell.js";
const SYSTEM_FROM = "agency-lang/stdlib-lib/system.js";
const SPEECH_FROM = "agency-lang/stdlib-lib/speech.js";
const BROWSER_USE_FROM = "agency-lang/stdlib-lib/browserUse.js";
const OAUTH_FROM = "agency-lang/stdlib-lib/oauth.js";

/** Param list shared by all three HTTP fetch builtins:
 *  (baseUrl, path, headers, allowedDomains). */
const HTTP_FETCH_PARAMS: (VariableType | "any")[] = [string, string, ANY_T, ANY_T];

export const CONTEXT_INJECTED_BUILTINS: Record<string, ContextInjectedBuiltin> = {
  __internal_setMemoryId: {
    name: "__internal_setMemoryId",
    from: MEMORY_FROM,
    params: [string],
    returnType: voidT,
  },
  __internal_shouldRunMemory: {
    name: "__internal_shouldRunMemory",
    from: MEMORY_FROM,
    params: [],
    returnType: boolean,
  },
  __internal_buildExtractionPrompt: {
    name: "__internal_buildExtractionPrompt",
    from: MEMORY_FROM,
    params: [string],
    returnType: string,
  },
  __internal_applyExtractionResult: {
    name: "__internal_applyExtractionResult",
    from: MEMORY_FROM,
    // `any` here mirrors how the agency-side caller passes a typed
    // ExtractionResult literal — the typechecker validates the
    // shape via the agency type annotation on `llm()`'s return,
    // so this builtin doesn't re-validate.
    params: [ANY_T],
    returnType: voidT,
  },
  __internal_buildForgetPrompt: {
    name: "__internal_buildForgetPrompt",
    from: MEMORY_FROM,
    params: [string],
    returnType: string,
  },
  __internal_applyForgetResult: {
    name: "__internal_applyForgetResult",
    from: MEMORY_FROM,
    params: [ANY_T],
    returnType: voidT,
  },
  __internal_remember: {
    name: "__internal_remember",
    from: MEMORY_FROM,
    params: [string],
    returnType: voidT,
  },
  __internal_recall: {
    name: "__internal_recall",
    from: MEMORY_FROM,
    params: [string],
    returnType: string,
  },
  __internal_forget: {
    name: "__internal_forget",
    from: MEMORY_FROM,
    params: [string],
    returnType: voidT,
  },
  __internal_systemMessage: {
    name: "__internal_systemMessage",
    from: THREAD_FROM,
    params: [string],
    returnType: voidT,
  },
  __internal_userMessage: {
    name: "__internal_userMessage",
    from: THREAD_FROM,
    params: [string],
    returnType: voidT,
  },
  __internal_assistantMessage: {
    name: "__internal_assistantMessage",
    from: THREAD_FROM,
    params: [string],
    returnType: voidT,
  },
  __internal_getCost: {
    name: "__internal_getCost",
    from: THREAD_FROM,
    params: [],
    returnType: number,
  },
  __internal_getTokens: {
    name: "__internal_getTokens",
    from: THREAD_FROM,
    params: [],
    returnType: number,
  },
  // Push 0 or more guards (cost, time, or both) and return the count
  // pushed so the caller knows how many to pop. Param types are "any"
  // because each can be `number | null` (null = "no limit on this
  // dimension"). The stdlib `guard` function threads the count to
  // `__internal_popGuard(count)`.
  __internal_pushGuard: {
    name: "__internal_pushGuard",
    from: THREAD_FROM,
    params: [ANY_T, ANY_T],
    returnType: number,
  },
  __internal_popGuard: {
    name: "__internal_popGuard",
    from: THREAD_FROM,
    params: [number],
    returnType: voidT,
  },
  __internal_fetch: {
    name: "__internal_fetch",
    from: HTTP_FROM,
    params: HTTP_FETCH_PARAMS,
    returnType: string,
  },
  // Return shape is parsed JSON — could be anything. Caller's agency
  // type annotation on the surrounding `def fetchJSON` is what
  // narrows it for downstream consumers.
  __internal_fetchJSON: {
    name: "__internal_fetchJSON",
    from: HTTP_FROM,
    params: HTTP_FETCH_PARAMS,
    returnType: ANY_T,
  },
  __internal_fetchMarkdown: {
    name: "__internal_fetchMarkdown",
    from: HTTP_FROM,
    params: HTTP_FETCH_PARAMS,
    returnType: string,
  },
  __internal_sleep: {
    name: "__internal_sleep",
    from: BUILTINS_FROM,
    params: [number],
    returnType: voidT,
  },
  __internal_input: {
    name: "__internal_input",
    from: BUILTINS_FROM,
    params: [string],
    returnType: string,
  },
  __internal_prompt: {
    name: "__internal_prompt",
    from: UI_FROM,
    params: [string],
    returnType: string,
  },
  // exec: (command, args, cwd, timeout, stdin, options)
  // `options` is the trailing { allowedCommands, blockedCommands }
  // object the agency wrapper constructs — `any` because the agency
  // wrapper is what enforces the shape, not the typechecker.
  __internal_exec: {
    name: "__internal_exec",
    from: SHELL_FROM,
    params: [string, ANY_T, string, number, string, ANY_T],
    minParams: 5,
    returnType: ANY_T,
  },
  // bash: (command, cwd, timeout, stdin, options)
  __internal_bash: {
    name: "__internal_bash",
    from: SHELL_FROM,
    params: [string, string, number, string, ANY_T],
    minParams: 4,
    returnType: ANY_T,
  },
  __internal_openUrl: {
    name: "__internal_openUrl",
    from: SYSTEM_FROM,
    params: [string],
    returnType: voidT,
  },
  // screenshot: (filepath, x, y, width, height)
  __internal_screenshot: {
    name: "__internal_screenshot",
    from: SYSTEM_FROM,
    params: [string, number, number, number, number],
    returnType: voidT,
  },
  // speak: (text, voice, rate, outputFile)
  __internal_speak: {
    name: "__internal_speak",
    from: SPEECH_FROM,
    params: [string, string, number, string],
    returnType: voidT,
  },
  // record: (outputFile, silenceTimeout) -> path
  __internal_record: {
    name: "__internal_record",
    from: SPEECH_FROM,
    params: [string, number],
    returnType: string,
  },
  // transcribe: (filepath, language) -> text
  __internal_transcribe: {
    name: "__internal_transcribe",
    from: SPEECH_FROM,
    params: [string, string],
    returnType: string,
  },
  // browserUse: (task, options?) -> { output, status, sessionId }
  __internal_browserUse: {
    name: "__internal_browserUse",
    from: BROWSER_USE_FROM,
    params: [string, ANY_T],
    minParams: 1,
    returnType: ANY_T,
  },
  // authorize: (name, config) -> { success: boolean }
  __internal_authorize: {
    name: "__internal_authorize",
    from: OAUTH_FROM,
    params: [string, ANY_T],
    returnType: ANY_T,
  },
  // getAccessToken: (name) -> string
  __internal_getAccessToken: {
    name: "__internal_getAccessToken",
    from: OAUTH_FROM,
    params: [string],
    returnType: string,
  },
};

/** True iff `name` is registered as a context-injected builtin. */
export function isContextInjectedBuiltin(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    CONTEXT_INJECTED_BUILTINS,
    name,
  );
}

/**
 * True iff `name` looks like an internal builtin (matches the
 * `__internal_` naming convention) regardless of whether it's
 * registered. Used by the typechecker to flag typos: a name that
 * looks like an internal builtin but isn't in the registry is almost
 * certainly a typo and should not be silently accepted.
 */
export function looksLikeInternalBuiltin(name: string): boolean {
  return name.startsWith("__internal_");
}
