/**
 * Cross-module init orchestrator.
 *
 * Each compiled Agency module calls `__registerModule(...)` at top
 * level (as a side effect of being loaded). The registry preserves
 * registration order, which — because ES module loading is depth-first
 * post-order over static imports — is exactly the dependency order we
 * want: deps before importers, entry module last.
 *
 * The orchestrator does NOT do init itself. It exposes the ordered
 * list so the entry module's `__initializeGlobals` (the
 * backward-compat shim that the codegen still emits) can run the
 * two-phase init:
 *
 *   Phase 1: every reachable module's `__initializeStatic` — populates
 *            all top-level static vars (and as a side effect, any
 *            top-level `let`/`const` reads that flowed through the
 *            getter cascade).
 *   Phase 2: every reachable module's `__runImperatives` — top-level
 *            imperative side effects in import order.
 *
 * The phase split is the invariant: every static everywhere must be
 * populated before ANY imperative runs anywhere. Imperatives in
 * module C may read a `static const X` from module B that no init
 * expression depends on; without Phase 1 finishing first, that read
 * would observe `undefined`.
 *
 * Determinism: registration order is fixed by ES module load order,
 * which is itself fixed by the static import graph. Sequential
 * `for await` (NOT `Promise.all`) over the registry preserves a
 * deterministic checkpoint/trace replay order.
 */

export type ModuleInitHandle = {
  __moduleId: string;
  __initializeStatic: (ctx: any) => Promise<void>;
  __runImperatives: (ctx: any) => Promise<void>;
};

const modules: ModuleInitHandle[] = [];

/**
 * Register a compiled module's init handles. Idempotent: a module that
 * gets imported by multiple parents only registers once. The first
 * registration wins (it preserves the natural import-order DFS).
 */
export function __registerModule(mod: ModuleInitHandle): void {
  for (const m of modules) {
    if (m.__moduleId === mod.__moduleId) return;
  }
  modules.push(mod);
}

/** Snapshot of the registered modules in registration (= dependency) order. */
export function __getReachableModules(): ModuleInitHandle[] {
  return modules.slice();
}

/**
 * Test-only reset hook. Clears the registry so tests that load
 * recompiled modules don't accumulate stale handles across runs.
 * Production code MUST NOT call this.
 */
export function __resetModuleRegistry(): void {
  modules.length = 0;
}
