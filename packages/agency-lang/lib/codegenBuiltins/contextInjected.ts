import type { VariableType } from "../types.js";
import {
  BOOLEAN_T as boolean,
  STRING_T as string,
  VOID_T as voidT,
  ANY_T,
} from "../typeChecker/primitives.js";

/**
 * Registry of "context-injected builtins": agency-callable identifiers
 * whose call sites are rewritten by the TypeScript builder to inject
 * the runtime context (`__ctx`) as the first positional argument.
 *
 *   agency:    __internal_recall(query)
 *   generated: await __internal_recall(__ctx, query)
 *
 * Used as the single source of truth for two consumers:
 *   - the typechecker (via `BUILTIN_FUNCTION_TYPES`) for arg/return
 *     type validation against the user-visible signature;
 *   - the TypeScript builder for the codegen rewrite that prepends
 *     `__ctx` and emits a direct (non-`__call`) function invocation.
 *
 * Adding a new context-injected builtin: (1) add an entry here with
 * the user-visible signature, (2) export the TS implementation under
 * the same name from one of the importable modules in `lib/stdlib/`
 * (today: `memory.ts`). The arity-parity test in
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
   *  codegen. Today every entry comes from the memory module; add
   *  more sources by adding entries with a different `from`. */
  from: string;
  /** Param types as the user calls the function. The TS impl
   *  receives `__ctx` plus these, so `impl.length === 1 + params.length`. */
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
