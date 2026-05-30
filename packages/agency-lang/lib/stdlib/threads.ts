/**
 * TS-side helpers for `stdlib/threads.agency` — the user-facing
 * cross-thread registry module. Wraps the `agency.threads.*` primitives
 * from Task 1.
 *
 * Post-Commit-B cleanup: there is no module-level cache here anymore.
 * `label` and `summary` live directly on the per-run `MessageThread`
 * (see `lib/runtime/state/messageThread.ts`), so per-run isolation
 * comes for free and the cache survives interrupt-resume via the
 * existing `toJSON`/`fromJSON` round-trip. `_setThreadSummary` is the
 * single TS-side writer Agency uses to record a freshly-computed
 * summary; the rest is read-through from `agency.threads.list()`.
 *
 * Naming follows stdlib conventions: every export is `_`-prefixed and
 * reads its runtime context from AsyncLocalStorage via `agency.*`.
 */
import { agency, type ThreadInfoTS } from "../runtime/agency.js";

/** Pass-through to `agency.threads.list()`. */
export function _listThreadsRaw(): ThreadInfoTS[] {
  return agency.threads.list();
}

/** Read a slice of a thread's messages, coerced to the
 *  `{ role: string, content: string }` shape Agency's
 *  `ThreadMessage` declares. Non-string `content` values
 *  (tool-call / structured) are JSON-stringified at the boundary so
 *  the Agency caller's `m.content` field is always a string — the
 *  TS-internal `agency.threads.get` returns the raw
 *  `smoltalk.MessageJSON` shape for callers that need full structure.
 */
export function _getThread(
  id: string,
  offset: number = 0,
  limit: number = 50,
): Array<{ role: string; content: string }> {
  const raw = agency.threads.get(id, offset, limit);
  return raw.map((m) => ({
    role: String(m.role),
    content:
      typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content ?? ""),
  }));
}

/** Slug form of the active thread, or `""` (Agency has no undefined). */
export function _currentThreadId(): string {
  return agency.threads.current() ?? "";
}

/** Stash a freshly-computed summary on the underlying `MessageThread`
 *  so subsequent `listThreads()` calls read it back without
 *  re-prompting. Called by the Agency-side `summaryFor()` helper after
 *  the lazy summarize round-trip. No-op when the id is unknown or
 *  there is no active store (e.g. called from non-Agency code). */
export function _setThreadSummary(id: string, summary: string): void {
  const store = agency.thread.storeMaybe();
  if (!store) return;
  const rawId = id.startsWith("t") ? id.slice(1) : id;
  const thread = store.threads[rawId];
  if (!thread) return;
  thread.summary = summary;
}
