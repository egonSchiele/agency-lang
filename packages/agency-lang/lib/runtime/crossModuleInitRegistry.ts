/**
 * Process-global registry of per-module init functions, used by
 * compiled Agency modules to coordinate cross-module initialization
 * order across the import closure.
 *
 * Background: PR 2 ("per-variable topological sort + centralized init")
 * computes at COMPILE time which modules' statics + globals must run
 * before others. The codegen attaches that information to each
 * compiled module: a list of source modules whose init must complete
 * first. We need a place at RUNTIME to look those functions up by
 * moduleId — that's this registry.
 *
 * Workflow per compiled module:
 *   1. At module-load time (immediately after declaring
 *      `__initializeStatic` / `__initializeGlobals`), the module calls
 *      `__registerStaticInit(moduleId, fn)` /
 *      `__registerGlobalsInit(moduleId, fn)`.
 *   2. At agent-run time, before running its own body, a module's
 *      init function calls `await __awaitStaticInit(depModuleId, ctx)`
 *      for each module its topsort plan says it depends on.
 *
 * Cycle safety: ES module load order matches the file-import DAG, so
 * by the time any init function runs (which only happens during agent
 * execution), every module's registration has already happened.
 * Compile-time topsort guarantees no var-level cycles inside the init
 * graph, so the await chain always terminates.
 *
 * Resetting the registry between test cases is intentionally NOT
 * supported here — modules are registered at JS-load time and JS-load
 * happens once per process. Tests that need isolation between runs
 * should use the existing checkpoint reset machinery instead.
 */

type InitFn = (ctx: unknown) => Promise<unknown>;

const staticInits: Record<string, InitFn> = {};
const globalsInits: Record<string, InitFn> = {};

/**
 * Register a module's `__initializeStatic` function under its absolute
 * moduleId. Called by every compiled module on JS-load.
 *
 * Last-write-wins semantics for the test-fixture case where the same
 * absolute path is loaded multiple times in a single process — the
 * previous fn is replaced. Production users do not hit this because
 * JS module caching ensures load-once.
 */
export function __registerStaticInit(moduleId: string, fn: InitFn): void {
  staticInits[moduleId] = fn;
}

export function __registerGlobalsInit(moduleId: string, fn: InitFn): void {
  globalsInits[moduleId] = fn;
}

/**
 * Run another module's static init and await it. Returns immediately
 * if the module hasn't registered yet (defensive: would only happen
 * if the import graph is broken so the codegen never had a chance to
 * register, in which case the PR-1 read-before-init trap fires as the
 * safety net).
 */
export async function __awaitStaticInit(
  moduleId: string,
  ctx: unknown,
): Promise<void> {
  const fn = staticInits[moduleId];
  if (!fn) return;
  await fn(ctx);
}

export async function __awaitGlobalsInit(
  moduleId: string,
  ctx: unknown,
): Promise<void> {
  const fn = globalsInits[moduleId];
  if (!fn) return;
  await fn(ctx);
}

/**
 * Shape of the `ctx` argument we care about here: enough to consult
 * the global store's per-execCtx "this module's globals already
 * initialized" flag. Keeps the registry independent of the full
 * RuntimeContext type (which lives elsewhere and would create a
 * circular import).
 */
type CtxWithGlobals = {
  globals?: {
    isInitialized(moduleId: string): boolean;
  };
};

/**
 * Closure-wide bootstrap: ensure every JS-loaded Agency module has
 * been initialized on this ctx before user code runs.
 *
 * Called from {@link runNode} on every fresh agent run, BEFORE the
 * entry module's own `initializeGlobals`. Iterates only the
 * `globalsInits` registry — each module's `__initializeGlobals`
 * internally does `markInitialized(moduleId)` first, then
 * `await __initializeStatic(__ctx)`, then its global-init
 * statements. Driving Phase A through `__initializeGlobals` (rather
 * than calling `__initializeStatic` directly here) is required for
 * correctness: every Agency function body has a per-function lazy
 * prelude that calls `__initializeGlobals(__ctx)` if its own module
 * isn't marked yet. If we called `__initializeStatic` first without
 * marking the module, that prelude would re-enter
 * `__initializeGlobals` from inside the IIFE that owns the pending
 * `__staticInitPromise` — and the inner `await __initializeStatic`
 * would receive the still-pending IIFE promise. Net result: a
 * subtle deadlock-or-skip ordering bug where statics end up with
 * the wrong values. Going through `__initializeGlobals` guarantees
 * `markInitialized` runs before the IIFE starts, so the per-function
 * prelude sees `isInitialized=true` and skips re-entry.
 *
 * Iteration order doesn't matter for correctness:
 *   • Phase A is deduped per process via the `__staticInitPromise`
 *     guard in each module's emitted `__initializeStatic`.
 *   • Phase B is deduped per execCtx via the
 *     `ctx.globals.isInitialized(...)` early-return baked into
 *     `__initializeGlobals` (current codegen) AND the same check
 *     here at the registry call site (safety net for compiled
 *     output that doesn't include its own per-execCtx guard).
 *   • Each module's `__initializeGlobals` has its own
 *     `await __awaitGlobalsInit(...)` prelude for its dep modules,
 *     so any cross-module dep edges from the compile-time dep graph
 *     are honored even if we visit a module before one of its deps.
 *
 * Why this exists: the per-variable dep graph in `compileClosure`
 * only sees references in *initializer expressions*. A `static const`
 * read from inside a function/node body doesn't show up there, so
 * if the entry module never directly references one of its
 * dependencies' statics in an initializer, that dependency's init
 * would never get triggered — and the read inside the function body
 * would hit `__UNINIT_STATIC` and throw at runtime. This loop closes
 * that hole by treating "imported into the closure" as enough reason
 * to initialize.
 */
export async function __initAllRegistered(ctx: unknown): Promise<void> {
  const globals = (ctx as CtxWithGlobals).globals;
  for (const moduleId of Object.keys(globalsInits)) {
    // Skip modules already initialized on this execCtx. Without this
    // guard, an older / non-conforming `__initializeGlobals` (one
    // missing the codegen-emitted early-return guard) would re-run
    // its body and double-execute every top-level global / bare
    // statement. The codegen-emitted guard makes this redundant for
    // current output; the registry-level check is the safety net.
    if (globals?.isInitialized(moduleId)) continue;
    await globalsInits[moduleId](ctx);
  }
}
