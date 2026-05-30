/**
 * TS-side helpers for `stdlib/threads.agency` — the user-facing
 * cross-thread registry module. Wraps the `agency.threads.*` primitives
 * from Task 1 and owns a per-run cache of labels and summaries keyed
 * by thread id.
 *
 * Cache placement rationale: Agency-side `static const` maps are
 * immutable after initialization, so the registry cache has to live in
 * TS. Keeping it here also keeps the Agency module tiny and lets the
 * cache survive interrupt-resume cleanly (it is rebuilt the same way
 * the rest of the registry is — from the run's onThreadEnd events).
 *
 * Naming follows stdlib conventions: every export is `_`-prefixed and
 * reads its runtime context from AsyncLocalStorage via `agency.*`.
 */
import { agency, type ThreadInfoTS, type ThreadMessageTS } from "../runtime/agency.js";
import { registerGlobalHook } from "../runtime/hooks.js";

export type _Cached = { label?: string; summary?: string };

/** Per-run cache of thread metadata keyed by slug id. Single owner:
 *  `_remember()`. Single reader: the Agency `listThreads()` and
 *  `summaryFor()` helpers. */
const _cache: Record<string, _Cached> = {};

// Module-load: register a global hook that snapshots a thread's
// `label` on close. Mirrors what an Agency-side
// `callback("onThreadEnd") as evt { ... }` would do, but a top-level
// Agency callback only fires when the OWNING module is imported as
// the entry point — it does not propagate cross-module. A global
// hook here makes the registry work transparently for any program
// that imports `std::threads`, with no boilerplate at the call site.
//
// Eager summarization (`thread(summarize: true)`) is intentionally
// NOT handled here: summarize() needs to make an LLM call, and
// firing an LLM call from a TS-side hook on every thread close
// would surprise users who only wanted to register the registry.
// Eager summarize remains an opt-in agency hook that users can add
// themselves; the v1 stdlib does lazy summarization at
// `listThreads()` call time instead (one call per thread that
// doesn't have a cached summary yet).
registerGlobalHook("onThreadEnd", (evt: any) => {
  if (evt && typeof evt.label === "string") {
    _remember(evt.threadId, { label: evt.label });
  }
});

/** Single owner of the cache-write rule. Shallow-merges `patch` into
 *  the entry for `id`. Agency-side callers go through this so the
 *  "label set → object updated, summary set → object updated"
 *  composition lives in one place. */
export function _remember(id: string, patch: _Cached): void {
  const existing = _cache[id];
  _cache[id] = existing ? { ...existing, ...patch } : patch;
}

/** Read the cached entry for `id`, or `null` if absent. Used by the
 *  Agency listThreads() implementation to attach label + summary to
 *  each raw ThreadInfo. */
export function _getCached(id: string): _Cached | null {
  return _cache[id] ?? null;
}

/** Test/cleanup hook: empties the cache. Exposed for unit tests that
 *  reuse the module across cases. Not used at runtime. */
export function _resetCache(): void {
  for (const k of Object.keys(_cache)) delete _cache[k];
}

/** Pass-through to `agency.threads.list()`. */
export function _listThreadsRaw(): ThreadInfoTS[] {
  return agency.threads.list();
}

/** Pass-through to `agency.threads.get(id, offset, limit)`. */
export function _getThread(
  id: string,
  offset: number = 0,
  limit: number = 50,
): ThreadMessageTS[] {
  return agency.threads.get(id, offset, limit);
}

/** Slug form of the active thread, or `""` (Agency has no undefined). */
export function _currentThreadId(): string {
  return agency.threads.current() ?? "";
}
