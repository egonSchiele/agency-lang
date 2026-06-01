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
