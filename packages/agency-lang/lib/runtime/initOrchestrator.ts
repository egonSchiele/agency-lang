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
 * Register a compiled module's init handles. Last-write-wins on
 * `__moduleId` while preserving the original DFS position:
 *
 *   - First-ever registration for a `__moduleId` appends to the
 *     registry, pinning the import-order DFS slot.
 *   - Subsequent registrations REPLACE the handles in-place at that
 *     same slot.
 *
 * Two scenarios this matters for (both rare in production):
 *   - Hot module replacement: the stale module's `__initializeStatic`
 *     and `__runImperatives` close over let-bindings from the old
 *     realm; replacing in place lets the orchestrator initialize the
 *     fresh instance.
 *   - Cache-busted dynamic re-imports (e.g. `import(url + "?v=" + n)`):
 *     user intent is "use the latest version"; in-place replacement
 *     honors that.
 *
 * Normal ESM behavior is unaffected — a module body only runs once
 * per realm, so `__registerModule` is called exactly once per
 * `__moduleId` and the first branch falls through unchanged.
 */
export function __registerModule(mod: ModuleInitHandle): void {
  for (let i = 0; i < modules.length; i++) {
    if (modules[i].__moduleId === mod.__moduleId) {
      modules[i] = mod;
      return;
    }
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
