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
 * Eager summarize wiring: this module registers a global
 * `onThreadEnd` hook (see below) so that any `thread(summarize: true)
 * { ... }` block triggers a one-shot LLM summarize call at close
 * time and stashes the result on the underlying `MessageThread`.
 * Lazy summarize (the on-demand path in `summaryFor()` inside
 * `stdlib/threads.agency`) still runs for threads that did NOT opt
 * in eagerly. Importing `std::threads` from Agency code triggers
 * this module's load, which registers the hook.
 *
 * Naming follows stdlib conventions: every export is `_`-prefixed and
 * reads its runtime context from AsyncLocalStorage via `agency.*`.
 */
import { z } from "zod";
import * as smoltalk from "smoltalk";
import { agency, type ThreadInfoTS } from "../runtime/agency.js";
import { registerGlobalHook } from "../runtime/hooks.js";
import { MessageThread } from "../runtime/state/messageThread.js";
import { createLogger } from "../logger.js";

/** Coerce a `smoltalk` message's `content` to a flat string. Non-string
 *  content (tool-call / structured) is JSON-stringified; nullish
 *  content (common on tool-call assistant messages where the LLM
 *  emitted tool calls but no text) maps to `""` instead of the literal
 *  JSON-encoded `'""'`. Shared by `_getThread` (the Agency-facing
 *  reader) and `_buildSummaryTranscript` (the eager summarizer
 *  prompt) so both surfaces agree on the same coercion rule. */
function _contentToString(content: smoltalk.MessageJSON["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

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
    content: _contentToString(m.content),
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
  // Only strip canonical `t<digits>` slugs — non-slug ids pass
  // through unchanged (matches stripSlug in runner.ts and fromSlug
  // in agency.ts).
  const rawId = /^t\d+$/.test(id) ? id.slice(1) : id;
  const thread = store.threads[rawId];
  if (!thread) return;
  thread.summary = summary;
}

// ── Eager summarize hook ──────────────────────────────────────────
//
// Mirrors the Agency-side `summarize()` def in `stdlib/threads.agency`
// but lives in TS so the global onThreadEnd hook can invoke it
// directly without needing to look up an Agency function reference.
//
// Why TS: top-level `callback("onThreadEnd")` in an Agency module
// only fires when the module is the entry-point of the run (see the
// regression test at `tests/agency-js/threads-fix-callback-propagation`).
// A global TS hook bypasses that, so any program that imports
// `std::threads` gets eager summarize for free.

const _summarySchema = z.object({ summary: z.string() });

/** Build the transcript string used by both the lazy and eager
 *  summarize prompts. Keeps the shape symmetric with the Agency-side
 *  `summarize()` def. Non-string content gets coerced the same way
 *  `_getThread()` does to keep the prompt deterministic. */
function _buildSummaryTranscript(messages: smoltalk.MessageJSON[]): string {
  let transcript = "";
  for (const m of messages) {
    transcript += `[${String(m.role)}] ${_contentToString(m.content)}\n`;
  }
  return transcript;
}

/** Best-effort summarize at thread close. Mirrors the Agency-side
 *  `summarize()` prompt + structured-output shape so eager and lazy
 *  paths produce comparable summaries. Uses an ephemeral standalone
 *  `MessageThread` (NOT registered with the active `ThreadStore`)
 *  for the LLM call so the summarizer prompt doesn't pollute the
 *  agent's main conversation and doesn't show up in `listThreads()`.
 *  Mirrors what `thread(hidden: true) { llm(...) }` would do in
 *  Agency-land.
 *
 *  Errors never propagate to the caller — eager summarize is a
 *  performance optimization, not a correctness path. If the call
 *  fails (no LLM client, network error, missing API key), the next
 *  `listThreads()` falls back to the lazy summarize path which
 *  surfaces a clean error path through `try _listThreadsRaw()`.
 *  Failures are still recorded via `logger.debug` and the
 *  `threadEndHookError` statelog event so they're observable. */
export async function _eagerSummarizeIfNeeded(evt: {
  threadId: string;
  eagerSummarize: boolean;
  messages: smoltalk.MessageJSON[];
}): Promise<void> {
  if (!evt.eagerSummarize) return;
  if (!evt.messages || evt.messages.length === 0) return;
  // Skip if a summary is already present (e.g. set by lazy path
  // earlier in the same run). Re-summarizing would waste cost.
  const store = agency.thread.storeMaybe();
  if (!store) return;
  const rawId = /^t\d+$/.test(evt.threadId)
    ? evt.threadId.slice(1)
    : evt.threadId;
  const thread = store.threads[rawId];
  if (!thread) return;
  // Idempotency: any non-null cached summary (including an empty
  // string explicitly set by an earlier path) wins — re-summarizing
  // wastes an LLM call and would silently overwrite an intentional
  // empty marker.
  if (thread.summary != null) return;

  try {
    const transcript = _buildSummaryTranscript(evt.messages);
    const result = await agency.llm(
      `Summarize this conversation in 1-2 sentences:\n${transcript}`,
      {
        schema: _summarySchema,
        // Standalone MessageThread — not in the active ThreadStore,
        // so listThreads() never sees the summarizer prompt. Same
        // isolation guarantee as `thread(hidden: true) { ... }` on
        // the Agency side.
        thread: new MessageThread(),
      },
    );
    _setThreadSummary(evt.threadId, result.summary);
  } catch (e) {
    // Best-effort — lazy summarize will retry on next listThreads().
    // Surface the failure two ways: a `logger.debug` line for local
    // troubleshooting (gated on the runtime's `logLevel` so the
    // default `info` level still stays silent) and a structured
    // `threadEndHookError` statelog event so production traces show
    // it. Mirrors the belt-and-braces failure-reporting pattern in
    // `Runner.thread`'s finally block.
    const message = e instanceof Error ? e.message : String(e);
    const ctx = agency.ctxMaybe();
    createLogger(ctx?.logLevel ?? "info").debug(
      `eager summarize failed for thread ${evt.threadId}: ${message}`,
    );
    ctx?.statelogClient?.threadEndHookError?.({
      threadId: evt.threadId,
      error: message,
    });
  }
}

registerGlobalHook("onThreadEnd", _eagerSummarizeIfNeeded);
