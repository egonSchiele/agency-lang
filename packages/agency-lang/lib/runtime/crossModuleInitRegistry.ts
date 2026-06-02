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
 * Closure-wide bootstrap: ensure every JS-loaded Agency module has had
 * Phase A (statics) and Phase B (globals) initialized on this ctx
 * before user code runs.
 *
 * Called once from {@link runNode} on every fresh agent run, right
 * after the entry module's own `initializeGlobals` runs. Iteration
 * order doesn't matter for correctness — each module's
 * `__initializeGlobals` has its own `await __awaitGlobalsInit(...)`
 * prelude for its dep modules, and Phase A is deduped per process
 * via the `__staticInitPromise` guard in each module, Phase B per
 * execCtx via the `globals.isInitialized(...)` early-return baked
 * into `__initializeGlobals`. So even if we visit a module before
 * one of its deps, the dep gets pulled in first by the nested await
 * chain and the duplicate visit becomes a no-op.
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
  // Statics first across the whole closure, then globals. Each
  // module's `__initializeGlobals` would do its own static init
  // anyway, but doing it as a separate pass here keeps "Phase A
  // completes before any Phase B starts" visible at the runtime
  // boundary instead of relying on per-module ordering.
  for (const moduleId of Object.keys(staticInits)) {
    await staticInits[moduleId](ctx);
  }
  for (const moduleId of Object.keys(globalsInits)) {
    await globalsInits[moduleId](ctx);
  }
}
