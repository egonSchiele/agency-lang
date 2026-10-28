import {
  AgencyCancelledError,
  isAbortError,
  isTimeoutError,
  readCause,
} from "../runtime/errors.js";
import { currentRun, type Run } from "../runtime/asyncContext.js";
import { cachedFetch, recordFetch } from "../runtime/fetchCache.js";
import { failure, isFailure, type ResultFailure } from "../runtime/result.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";
import { AWS_OBJECT_BYTE_LIMIT } from "../constants.js";

/** How long a fetch may take, headers and body together, when the caller
 *  names no limit. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** The signal a request runs under: the run's own signal, so a cancel or a
 *  guard trip still tears the request down, joined with a timeout when one
 *  is set. `0` means no limit. */
function requestSignal(runSignal: AbortSignal, timeoutMs: number): AbortSignal {
  if (timeoutMs <= 0) {
    return runSignal;
  }
  return AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)]);
}

/** An ordinary error, not a cancellation, so the `try` around the call
 *  turns it into a Failure the model can read. */
function timeoutError(url: string, timeoutMs: number): Error {
  return new Error(
    `Request to ${url} timed out after ${timeoutMs / 1000} seconds. Do not retry it as is: ` +
      `pass a larger timeout if the source is slow, or use a different source.`,
  );
}

// Cancellation is best-effort cleanup; a cancel error must never replace the
// primary abort or size-cap error we are about to throw.
function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  reader.cancel().catch(() => {});
}

// Releasing the lock can throw if the reader is mid-read; that must not mask the
// real outcome we are returning or throwing from the surrounding `finally`.
function releaseReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    /* release is cleanup-only; see comment above */
  }
}

/**
 * Read a response body into bytes with a hard size cap and abort safety. On
 * abort we cancel the reader to unblock the pending `read()`, then
 * `throwIfAborted()` turns that into an `AbortError` rather than resolving to the
 * partial prefix. The cap and abort policy live here once; the text reader and
 * the AWS pipeline both decode this primitive.
 */
export async function readBodyBytesCapped(
  response: Response,
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => {
    cancelReaderBestEffort(reader);
  };
  // Install the cancel path (or cancel now if already aborted) BEFORE the abort
  // check, so an already-aborted signal still cancels the stream and reaches the
  // `finally` that releases the reader lock.
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      // Check before handling `done`: a cancel from onAbort resolves the pending
      // read as done, and we must throw rather than return the prefix.
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > AWS_OBJECT_BYTE_LIMIT) {
        cancelReaderBestEffort(reader);
        throw new Error(`Response from ${url} exceeds ${AWS_OBJECT_BYTE_LIMIT} bytes`);
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
    releaseReaderBestEffort(reader);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readBodyCapped(
  response: Response,
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const bytes = await readBodyBytesCapped(response, url, signal);
  return new TextDecoder("utf-8").decode(bytes);
}

function validateUrl(baseUrl: string, urlPath: string, allowedDomains: string[]): string {
  const url = resolveUrl(baseUrl, urlPath);
  const domainError = checkAllowedDomains(url, allowedDomains);
  if (domainError) throw new Error(domainError);
  return url;
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
}

/**
 * Build the `fetch` request init. A body is attached only for methods that
 * carry one (not GET/HEAD): a string is sent as-is, a non-string is
 * JSON-serialized with a default `Content-Type: application/json` (unless the
 * caller already set a content-type header). Headers are copied so the default
 * doesn't mutate the caller's object.
 */
function buildInit(
  method: string,
  headers: Record<string, string>,
  body: any,
  signal: AbortSignal,
): RequestInit {
  const h: Record<string, string> = { ...headers };
  const init: RequestInit = { method, headers: h, signal };
  if (body != null && method !== "GET" && method !== "HEAD") {
    if (typeof body === "string") {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      if (!hasContentType(h)) {
        h["Content-Type"] = "application/json";
      }
    }
  }
  return init;
}

/**
 * A structured `failure` for a non-2xx response, or `null` when the status is
 * ok (`Response.ok`, i.e. in [200, 300)). Returning a `failure` — rather than
 * throwing — lets std::http's `try`-wrapped callers pass the Result through
 * intact (see `__tryCall`), so callers see the structured `error`
 * `{ status, statusText, url, body, message }` instead of a flat string. The
 * body is already read (and size-capped); the snippet is whitespace-collapsed
 * and truncated so the message stays stable and log-friendly.
 */
function httpStatusFailure(result: Response, url: string, body: string): ResultFailure | null {
  if (result.ok) return null;
  const snippet = normalizeSnippet(body);
  const statusText = result.statusText ? ` ${result.statusText}` : "";
  const message =
    `HTTP ${result.status}${statusText} from ${url}` + (snippet ? `: ${snippet}` : "");
  return failure(message, {
    status: result.status,
    statusText: result.statusText,
    url,
    body: snippet,
  });
}

/** Collapse whitespace and truncate a response body into a failure snippet. */
export function normalizeSnippet(body: string, max = 300): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Run an HTTP request, translating any abort-shaped error into the
 * runtime's `AgencyCancelledError`. Node's `fetch` surfaces an
 * aborted request as a `DOMException` with `name === "AbortError"`,
 * which `isAbortError` matches. Translating to `AgencyCancelledError`
 * lets `__tryCall` re-throw it (alongside `GuardExceededError`) so
 * the agency-side `try` wrapper doesn't silently convert it into a
 * `Failure` value — the cancellation propagates to the runner the
 * same way an aborted LLM call does.
 *
 * Exported so other stdlib JS modules that do their own `fetch`
 * (oauth.ts token exchange, speech.ts whisper upload, browserUse.ts
 * session creation/polling) can share the same abort-error translation
 * without each one re-implementing it. Each caller still has to thread
 * the `AbortSignal` from `ctx.getAbortSignal(stack)` into its `fetch`
 * call — this helper only handles the catch side. `signal` is that same
 * signal, read here only to recover the abort cause. `timeoutMs` is the
 * limit the signal carries, named in the failure when it is what fired.
 */
export async function runHttp<T>(
  fn: () => Promise<T>,
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number = 0,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isTimeoutError(e)) {
      throw timeoutError(url, timeoutMs);
    }
    if (isAbortError(e)) {
      // Carry the structured cause so a guard trip that aborted this fetch
      // surfaces as an AgencyCancelledError whose guardTrip cause survives —
      // the owning guard's `try` then converts it instead of letting a bare
      // cancel escape. In current Node, `fetch` rejects with `signal.reason`
      // directly, so the cause is on `e`. But an abort delivered as a bare
      // DOMException (no reason) wouldn't carry it, so fall back to reading
      // the cause off the signal the caller gave the request.
      const cause = readCause(e) ?? (signal ? readCause(signal) : undefined);
      throw new AgencyCancelledError(`fetch ${url} cancelled`, cause);
    }
    // Network-level failure (undici surfaces a bare "fetch failed" TypeError):
    // the environment likely can't reach the host. Turn it into an actionable
    // message so the model stops retrying the same unreachable URL.
    if (e instanceof TypeError && String(e.message).includes("fetch failed")) {
      throw new Error(
        `Could not reach ${url} (network error). This environment may not allow ` +
          `outbound web requests. Do NOT keep retrying this URL — use a different ` +
          `tool (e.g. web_search) or answer from your own knowledge.`,
      );
    }
    throw e;
  }
}

async function fetchImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string,
  body: any,
  timeoutMs: number,
): Promise<string | ResultFailure> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const signal = requestSignal(ctx.getAbortSignal(stack), timeoutMs);
  return await runHttp(
    async () => {
      const result = await ctx.host.network.fetch(url, buildInit(method, headers, body, signal));
      let responseBody: string;
      try {
        responseBody = await readBodyCapped(result, url, signal);
      } catch (e) {
        if (isAbortError(e) || isTimeoutError(e)) throw e;
        throw new Error(`Failed to get text from ${url}: ${e}`);
      }
      const statusFailure = httpStatusFailure(result, url, responseBody);
      if (statusFailure) return statusFailure;
      return responseBody;
    },
    url,
    signal,
    timeoutMs,
  );
}

/** Deprecated context-injected wrapper kept during the ALS migration;
 *  see `_fetch`. */
export async function __internal_fetch(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string = "GET",
  body: any = null,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<string | ResultFailure> {
  return fetchImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains, method, body, timeoutMs);
}

/**
 * The stored result a fetch tool returns instead of fetching, when this
 * conversation already fetched the URL, or null when the fetch should
 * run. Called by the Agency fetch functions before they raise their
 * interrupt, so a cache hit asks no one. `tool` is the function's name,
 * for the record. See lib/runtime/fetchCache.ts.
 */
export function _cachedFetch(
  baseUrl: string,
  urlPath: string,
  method: string,
  body: unknown,
  headers: Record<string, unknown>,
  refresh: boolean,
  tool: string,
): { value: unknown } | null {
  const run = currentRun();
  return cachedFetch(
    run,
    { url: resolveUrl(baseUrl, urlPath), method, body, headers, tool },
    refresh,
  );
}

/** Record a completed fetch and its result in the run's fetch cache. A
 *  failure is not a fetch, so it is not recorded. */
function remember(
  run: Run,
  result: unknown,
  request: {
    baseUrl: string;
    urlPath: string;
    method: string;
    body: unknown;
    headers: Record<string, unknown>;
    tool: string;
  },
): void {
  if (isFailure(result)) return;
  recordFetch(
    run,
    {
      url: resolveUrl(request.baseUrl, request.urlPath),
      method: request.method,
      body: request.body,
      headers: request.headers,
      tool: request.tool,
    },
    result,
  );
}

/** ALS-reading replacement for `__internal_fetch`. */
export async function _fetch(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string,
  body: any,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<string | ResultFailure> {
  const run = currentRun();
  const { ctx, stack } = run;
  const result = await fetchImpl(
    ctx,
    stack,
    baseUrl,
    urlPath,
    headers,
    allowedDomains,
    method,
    body,
    timeoutMs,
  );
  remember(run, result, { baseUrl, urlPath, method, body, headers, tool: "fetch" });
  return result;
}

async function fetchJSONImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string,
  body: any,
  timeoutMs: number,
): Promise<any> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const signal = requestSignal(ctx.getAbortSignal(stack), timeoutMs);
  return await runHttp(
    async () => {
      const result = await ctx.host.network.fetch(url, buildInit(method, headers, body, signal));
      const text = await readBodyCapped(result, url, signal);
      const statusFailure = httpStatusFailure(result, url, text);
      if (statusFailure) return statusFailure;
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`Failed to parse JSON from ${url}: ${e}`);
      }
    },
    url,
    signal,
    timeoutMs,
  );
}

/** Deprecated; see `_fetchJSON`. */
export async function __internal_fetchJSON(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string = "GET",
  body: any = null,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<any> {
  return fetchJSONImpl(
    ctx,
    stack,
    baseUrl,
    urlPath,
    headers,
    allowedDomains,
    method,
    body,
    timeoutMs,
  );
}

/** ALS-reading replacement for `__internal_fetchJSON`. */
export async function _fetchJSON(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string,
  body: any,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<any> {
  const run = currentRun();
  const { ctx, stack } = run;
  const result = await fetchJSONImpl(
    ctx,
    stack,
    baseUrl,
    urlPath,
    headers,
    allowedDomains,
    method,
    body,
    timeoutMs,
  );
  remember(run, result, { baseUrl, urlPath, method, body, headers, tool: "fetchJSON" });
  return result;
}

async function fetchMarkdownImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string,
  body: any,
  timeoutMs: number,
): Promise<string | ResultFailure> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const signal = requestSignal(ctx.getAbortSignal(stack), timeoutMs);
  return await runHttp(
    async () => {
      const result = await ctx.host.network.fetch(url, buildInit(method, headers, body, signal));
      const contentType = result.headers.get("content-type") ?? "";
      const responseBody = await readBodyCapped(result, url, signal);
      const statusFailure = httpStatusFailure(result, url, responseBody);
      if (statusFailure) return statusFailure;
      if (contentType.includes("text/html")) {
        return htmlToMarkdown(responseBody);
      }
      return responseBody;
    },
    url,
    signal,
    timeoutMs,
  );
}

/** Deprecated; see `_fetchMarkdown`. */
export async function __internal_fetchMarkdown(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string = "GET",
  body: any = null,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<string | ResultFailure> {
  return fetchMarkdownImpl(
    ctx,
    stack,
    baseUrl,
    urlPath,
    headers,
    allowedDomains,
    method,
    body,
    timeoutMs,
  );
}

/** ALS-reading replacement for `__internal_fetchMarkdown`. */
export async function _fetchMarkdown(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string,
  body: any,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<string | ResultFailure> {
  const run = currentRun();
  const { ctx, stack } = run;
  const result = await fetchMarkdownImpl(
    ctx,
    stack,
    baseUrl,
    urlPath,
    headers,
    allowedDomains,
    method,
    body,
    timeoutMs,
  );
  remember(run, result, { baseUrl, urlPath, method, body, headers, tool: "fetchMarkdown" });
  return result;
}

function htmlToMarkdown(html: string): string {
  let s = html;

  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, inner) => {
    const hashes = "#".repeat(parseInt(n, 10));
    return `\n\n${hashes} ${stripTags(inner).trim()}\n\n`;
  });

  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<p[^>]*>/gi, "");
  s = s.replace(/<\/div>/gi, "\n");
  s = s.replace(/<div[^>]*>/gi, "");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => {
    return `- ${stripTags(inner).trim()}\n`;
  });

  s = s.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const text = stripTags(inner).trim();
    return text ? `[${text}](${href})` : href;
  });

  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  s = stripTags(s);
  s = s.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m]);
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

export function resolveUrl(baseUrl: string, path: string): string {
  if (!path) return baseUrl;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path : "/" + path;
  return base + p;
}

/** Where a request goes, as two plain words a policy rule can match:
 *  the URL's scheme, and whether the host is on the public internet or
 *  on this machine or its network. `network` is "local" for loopback,
 *  unspecified, link-local, private, and carrier-grade NAT addresses
 *  (IPv4 and IPv6, an IPv4 address inside IPv6 included) and for
 *  `localhost`, `.localhost`, and `.local` names, with or without a
 *  trailing dot; "public" for any
 *  other host; "unknown" when the string is not a URL. A rule that
 *  approves a read of the web says `scheme: "https", network: "public"`,
 *  which keeps a local admin page or the cloud metadata address out of
 *  its reach (docs/dev/agents/approval-policies.md). Names are judged as
 *  written, not resolved: a public name that resolves to a private
 *  address is not caught here. */
export type FetchTarget = {
  scheme: string;
  network: "public" | "local" | "unknown";
};

export function _fetchTarget(baseUrl: string, urlPath: string): FetchTarget {
  try {
    const url = new URL(resolveUrl(baseUrl, urlPath));
    return { scheme: url.protocol.replace(/:$/, ""), network: networkOf(url.hostname) };
  } catch {
    return { scheme: "", network: "unknown" };
  }
}

// 100.64.0.0/10 is carrier-grade NAT, which Tailscale uses for every
// machine on a tailnet.
const LOCAL_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
];
const LOCAL_V6 = [/^f[cd][0-9a-f]{2}:/, /^fe[89ab][0-9a-f]:/];

export function networkOf(hostname: string): "public" | "local" {
  // `localhost.` is the same machine as `localhost`: a trailing dot only
  // marks the name as fully qualified.
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "local";
  }
  if (host === "0.0.0.0" || host === "::" || host === "::1") return "local";
  // An IPv4 address carried inside IPv6 is judged as the IPv4 address.
  // The URL parser writes it in hex (`[::ffff:127.0.0.1]` becomes
  // `[::ffff:7f00:1]`), so both spellings are read.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return networkOf(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return networkOf(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if ([...LOCAL_V4, ...LOCAL_V6].some((pattern) => pattern.test(host))) return "local";
  return "public";
}

/** A host and the same host without its `www.`: `www.example.com` and
 *  `example.com` are one site to anyone writing an allow list. A model
 *  given `https://www.3blue1brown.com` listed `3blue1brown.com` three
 *  times in a row and was refused each time (ADI-44). Any other subdomain
 *  is a different host and must be listed. */
function withoutWww(host: string): string {
  return host.replace(/^www\./, "");
}

export function checkAllowedDomains(url: string, allowedDomains: string[]): string | null {
  // A model's tool call can carry the list as JSON text, "[]", when a
  // provider stringifies arguments. Say so, not "Invalid URL".
  if (!Array.isArray(allowedDomains)) {
    return `allowedDomains must be a list of domain names, got ${JSON.stringify(allowedDomains)}.`;
  }
  if (allowedDomains.length === 0) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return `Invalid URL: "${url}"`;
  }
  const allowed = allowedDomains.map((d) => withoutWww(d.toLowerCase()));
  if (!allowed.includes(withoutWww(hostname))) {
    return `Domain "${hostname}" is not in allowedDomains.`;
  }
  return null;
}
