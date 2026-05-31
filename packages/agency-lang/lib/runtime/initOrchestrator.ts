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
 *   Phase 1: every registered module's `__initializeStatic` —
 *            populates all top-level static vars (and as a side
 *            effect, any top-level `let`/`const` reads that flowed
 *            through the getter cascade).
 *   Phase 2: every registered module's `__runImperatives` —
 *            top-level imperative side effects in import order.
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
 *
 * Scoping: the registry is a single process-global list, NOT scoped to
 * a particular entry module. If a long-lived process loads multiple
 * unrelated compiled Agency programs (or a test runner imports many
 * fixtures back-to-back without resetting), every registered module
 * will be visited by every subsequent `__initializeGlobals` call.
 * Per-entry scoping would require recording dependency edges at
 * registration time and walking only the reachable subgraph from the
 * entry module — tracked as a follow-up.
 */

export type ModuleInitHandle = {
  __moduleId: string;
  __initializeStatic: (ctx: any) => Promise<void>;
  __runImperatives: (ctx: any) => Promise<void>;
};

const modules: ModuleInitHandle[] = [];

/**
 * Register a compiled module's init handles. Idempotent on
 * `__moduleId`: a module that gets imported by multiple parents only
 * registers once. The FIRST registration wins (it preserves the
 * natural import-order DFS).
 *
 * Caveat: if the same compiled `.js` file is dynamically imported more
 * than once with cache-busting (query-string differs, hot reload, some
 * test setups), each ES module instance is independent but they share
 * the same `__moduleId`. The first instance's `__initializeStatic` and
 * `__runImperatives` capture the let-bindings from the FIRST module
 * instance, so subsequent instances' top-level statics will never
 * populate even though the orchestrator iterates over the stale
 * handles. Production code does not exercise this path; tests that
 * recompile and reimport must call `__resetModuleRegistry()` between
 * fixtures to keep instances isolated.
 */
export function __registerModule(mod: ModuleInitHandle): void {
  for (const m of modules) {
    if (m.__moduleId === mod.__moduleId) return;
  }
  modules.push(mod);
}

/**
 * Snapshot of every registered module in registration order. NOT
 * scoped to "reachable from a particular entry" — see the file
 * docstring for the scoping caveat.
 */
export function __getRegisteredModules(): ModuleInitHandle[] {
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
