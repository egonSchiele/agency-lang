import { VALID_CALLBACK_NAMES, type CallbackName } from "../types/function.js";
import type { Run } from "../runtime/asyncContext.js";
import { AgencyFunction } from "../runtime/agencyFunction.js";

// This file backs `callback` in the prelude, so every compiled program imports
// it. It must not import the compiler. It used to live in `agency.ts`, which
// imports the parser and the type checker, and that pulled the whole compiler
// into every program.

/**
 * Register a scoped callback for the dynamic extent of the caller's function
 * or node. Implementation backing for `callback(name, fn)` in std::index.
 *
 * Frame targeting:
 *   - At top level (inside `__initializeGlobals`, before any node frame is
 *     pushed) — route to `ctx.topLevelCallbacks`, which lives on the
 *     execution context for the whole run.
 *   - Otherwise — push onto the caller's stack frame, which auto-cleans up
 *     when the caller's frame pops.
 *
 * NOTE on the AgencyFunction wrapping: this function needs the run, to
 * walk the state stack and find the caller's frame. It is wrapped as an
 * AgencyFunction because `invoke()` passes every body the run as its first
 * argument.
 */
// Exported as `_callbackImpl` so unit tests can call it directly, with a run
// from `runInTestContext`.
export function _callbackImpl(run: Run, name: string, fn: unknown): void {
  if (!VALID_CALLBACK_NAMES.includes(name as CallbackName)) {
    throw new Error(`Unknown callback '${name}'. Valid: ${VALID_CALLBACK_NAMES.join(", ")}`);
  }
  if (typeof fn !== "function" && !AgencyFunction.isAgencyFunction(fn)) {
    throw new Error(
      `callback('${name}', fn): fn must be a function, got ${fn === null ? "null" : typeof fn}`,
    );
  }
  const { ctx } = run;
  // Top-level: we're inside __initializeGlobals. The only frame on the stack
  // is `callback`'s own (or none, defensively). There is no caller frame
  // that survives past init, so route to ctx.topLevelCallbacks.
  if (ctx.stateStack.isGlobalContext()) {
    ctx.topLevelCallbacks.push({ name, fn });
    return;
  }
  ctx.stateStack.callerFrame().addScopedCallback(name as CallbackName, fn);
}

export const _callback = new AgencyFunction({
  name: "_callback",
  module: "agency-lang/stdlib-lib/callback.js",
  fn: _callbackImpl,
  params: [
    { name: "name", hasDefault: false, defaultValue: undefined, variadic: false },
    { name: "fn", hasDefault: false, defaultValue: undefined, variadic: false },
  ],
  toolDefinition: null,
});
