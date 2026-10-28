/**
 * The per-run fetch cache: a URL a model tool call fetched once is not
 * fetched again in the same conversation. The second call gets the
 * stored result, with no request and no interrupt.
 * See docs/dev/stdlib/fetch-cache.md.
 */
import type { Run } from "./asyncContext.js";
import { GlobalStore } from "./state/globalStore.js";
import type { StateStack } from "./state/stateStack.js";

/** One fetched URL: how the model spelled it, which tool fetched it, the
 *  thread whose conversation it was fetched for, the fetch's number in
 *  the run (the oldest is dropped first), the result, and the result's
 *  size in characters. */
export type FetchCacheEntry = {
  url: string;
  tool: string;
  threadId: string | null;
  ordinal: number;
  value: unknown;
  size: number;
};

/** The most result text the cache keeps, in characters. The cache rides
 *  in every checkpoint beside the spill store, whose cap of 1,000,000 is
 *  set by the hosted resume limit (spill.md), so the two together stay
 *  under it with room for two copies. */
export const MAX_CACHED_CHARS = 500_000;

export type FetchCache = {
  entries: Record<string, FetchCacheEntry>;
  count: number;
};

/** The global the cache is kept in. The globals of a run are shared by
 *  its tool calls, copied into a fork branch, and serialized with every
 *  checkpoint, which is what the cache needs (globalstore.md). */
const CACHE_KEY = "__fetchCache";

/** What a fetch looks like to the cache. */
export type FetchRequest = {
  url: string;
  method: string;
  body: unknown;
  tool: string;
};

/**
 * The key two spellings of one page share: scheme and host lowercased, a
 * leading `www.` dropped, the fragment dropped, and a trailing slash
 * dropped. The query stays, since `?page=2` is another page. `null` when
 * the string is not a URL.
 */
export function normalizeFetchUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const port = parsed.port ? `:${parsed.port}` : "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol.toLowerCase()}//${host}${port}${path}${parsed.search}`;
}

/** Only a read with no body is cached: a POST is an action, and two POSTs
 *  to one URL are two actions. */
function isCacheable(request: FetchRequest): boolean {
  return request.method.toUpperCase() === "GET" && request.body == null;
}

/** Where the tool loop records what it knows about a tool call: on the
 *  call's branch stack, which the body reads as `run.toolInvocationStack`.
 *  The body runs on a thread store of its own (`invokeOnFreshThreadStore`),
 *  so it cannot find the conversation its result goes to by itself. */
const TOOL_CALL_KEY = "fetchCacheToolCall";

/** The module the three fetch functions are compiled from. */
const HTTP_MODULE = "stdlib/http.agency";

/** What the loop records for one tool call: the threads whose messages
 *  the call's result will sit among (the conversation's thread and its
 *  ancestors, nearest first, from `ThreadStore.lineageOf`), and which
 *  function the model called. */
export type ToolCallRecord = {
  conversation: string[];
  tool: { module: string; registeredName: string };
};

/** Record a tool call on its branch stack: the function the model called
 *  and the conversation its result goes to. The tool loop calls this
 *  before it invokes the tool. */
export function recordToolCall(
  branchStack: StateStack,
  tool: { module: string; registeredName: string },
  conversation: string[],
): void {
  const record: ToolCallRecord = {
    conversation,
    tool: { module: tool.module, registeredName: tool.registeredName },
  };
  branchStack.other[TOOL_CALL_KEY] = record;
}

/** The tool call this fetch is, when the fetch function itself is the
 *  tool the model called, or null. Null outside a tool call: a program
 *  that fetches the same URL in a loop, to poll a status page for
 *  example, is not a model repeating itself and gets the page every
 *  time. Null inside a tool that fetches on its own account too: a data
 *  connector that reads an API through `fetchJSON` expects JSON back,
 *  and the model called the connector, not the fetch. */
function directToolCall(run: Run, request: FetchRequest): ToolCallRecord | null {
  const record = run.toolInvocationStack?.other[TOOL_CALL_KEY] as ToolCallRecord | undefined;
  if (record === undefined) return null;
  const { module, registeredName } = record.tool;
  return module === HTTP_MODULE && registeredName === request.tool ? record : null;
}

function readCache(run: Run): FetchCache {
  const existing = run.globals.get(GlobalStore.INTERNAL_MODULE, CACHE_KEY) as
    FetchCache | undefined;
  if (existing !== undefined) return existing;
  const fresh: FetchCache = { entries: {}, count: 0 };
  run.globals.set(GlobalStore.INTERNAL_MODULE, CACHE_KEY, fresh);
  return fresh;
}

/** Whether the content fetched on `threadId` is in this conversation: it
 *  is the conversation's own thread, or an ancestor of it (a subthread
 *  starts with its parent's messages). A fetch on an unrelated thread put
 *  nothing in this conversation, so it does not count. */
function fetchedInConversation(conversation: string[], threadId: string | null): boolean {
  return threadId !== null && conversation.includes(threadId);
}

/**
 * The stored result a tool call gets when this conversation already
 * fetched the URL, or `null` when the fetch should run: the fetch function
 * is not the tool the model called, the request is not a plain GET, the
 * call asked for a refresh, or the URL was not fetched in this
 * conversation before (or its result was dropped to make room). The
 * result is wrapped because a JSON body can itself be `null`.
 */
export function cachedFetch(
  run: Run,
  request: FetchRequest,
  refresh: boolean,
): { value: unknown } | null {
  const call = directToolCall(run, request);
  if (refresh || call === null || !isCacheable(request)) return null;
  const key = normalizeFetchUrl(request.url);
  if (key === null) return null;
  const entry = readCache(run).entries[key];
  if (entry === undefined || !fetchedInConversation(call.conversation, entry.threadId)) return null;
  // A checkpoint saved before results were stored has entries without one.
  if (!("value" in entry)) return null;
  return { value: entry.value };
}

function sizeOf(value: unknown): number {
  return typeof value === "string" ? value.length : (JSON.stringify(value)?.length ?? 0);
}

/** Drop the oldest entries until the stored results fit in the cap. */
function evictOldest(cache: FetchCache): void {
  const entries = Object.entries(cache.entries).sort(([, a], [, b]) => a.ordinal - b.ordinal);
  let total = entries.reduce((sum, [, entry]) => sum + (entry.size ?? 0), 0);
  for (const [key, entry] of entries) {
    if (total <= MAX_CACHED_CHARS) return;
    delete cache.entries[key];
    total -= entry.size ?? 0;
  }
}

/** Record a fetch that completed and its result, so the next call for
 *  the same URL in this conversation gets the result back. Call it after
 *  the fetch succeeded: a failed fetch is not recorded, so the model may
 *  try the URL again. A result larger than the whole cap is not kept, and
 *  that URL is fetched again next time. */
export function recordFetch(run: Run, request: FetchRequest, value: unknown): void {
  const call = directToolCall(run, request);
  if (call === null || !isCacheable(request)) return;
  const key = normalizeFetchUrl(request.url);
  if (key === null) return;
  const cache = readCache(run);
  const size = sizeOf(value);
  if (size > MAX_CACHED_CHARS) {
    delete cache.entries[key];
    return;
  }
  cache.count += 1;
  cache.entries[key] = {
    url: request.url,
    tool: request.tool,
    threadId: call.conversation[0] ?? null,
    ordinal: cache.count,
    value,
    size,
  };
  evictOldest(cache);
}
