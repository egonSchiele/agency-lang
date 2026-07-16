import {
  AgencyCancelledError,
  isAbortError,
  readCause,
} from "../runtime/errors.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { failure, type ResultFailure } from "../runtime/result.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function readBodyCapped(
  response: Response,
  url: string,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let total = 0;
  // Cancel the body read when the AbortSignal fires (e.g., user
  // hit Ctrl-C while we're streaming a large response). `fetch`'s
  // signal handles connect/headers; the streaming body read needs
  // its own listener because the in-flight reader.read() promise
  // won't auto-reject on signal abort.
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `Response from ${url} exceeds ${MAX_BODY_BYTES} bytes`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {}
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

function validateUrl(
  baseUrl: string,
  urlPath: string,
  allowedDomains: string[],
): string {
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
function httpStatusFailure(
  result: Response,
  url: string,
  body: string,
): ResultFailure | null {
  if (result.ok) return null;
  const snippet = normalizeSnippet(body);
  const statusText = result.statusText ? ` ${result.statusText}` : "";
  const message =
    `HTTP ${result.status}${statusText} from ${url}` +
    (snippet ? `: ${snippet}` : "");
  return failure({
    status: result.status,
    statusText: result.statusText,
    url,
    body: snippet,
    message,
  });
}

/** Collapse whitespace and truncate a response body into a failure snippet. */
function normalizeSnippet(body: string, max = 300): string {
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
 * call — this helper only handles the catch side.
 */
export async function runHttp<T>(fn: () => Promise<T>, url: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isAbortError(e)) {
      // Carry the structured cause so a guard trip that aborted this fetch
      // surfaces as an AgencyCancelledError whose guardTrip cause survives —
      // the owning guard's `try` then converts it instead of letting a bare
      // cancel escape. In current Node, `fetch` rejects with `signal.reason`
      // directly, so the cause is on `e`. But an abort delivered as a bare
      // DOMException (no reason) wouldn't carry it, so fall back to reading
      // the cause off the active runtime abort signal.
      let cause = readCause(e);
      if (cause === undefined) {
        try {
          const { ctx, stack } = getRuntimeContext();
          cause = readCause(ctx.getAbortSignal(stack));
        } catch {
          /* not inside an execution frame — no signal cause to recover */
        }
      }
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
): Promise<string | ResultFailure> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const signal = ctx.getAbortSignal(stack);
  return await runHttp(async () => {
    const result = await fetch(url, buildInit(method, headers, body, signal));
    let responseBody: string;
    try {
      responseBody = await readBodyCapped(result, url, signal);
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new Error(`Failed to get text from ${url}: ${e}`);
    }
    const statusFailure = httpStatusFailure(result, url, responseBody);
    if (statusFailure) return statusFailure;
    return responseBody;
  }, url);
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
): Promise<string | ResultFailure> {
  return fetchImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains, method, body);
}

/** ALS-reading replacement for `__internal_fetch`. */
export async function _fetch(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string,
  body: any,
): Promise<string | ResultFailure> {
  const { ctx, stack } = getRuntimeContext();
  return fetchImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains, method, body);
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
): Promise<any> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const signal = ctx.getAbortSignal(stack);
  return await runHttp(async () => {
    const result = await fetch(url, buildInit(method, headers, body, signal));
    const text = await readBodyCapped(result, url, signal);
    const statusFailure = httpStatusFailure(result, url, text);
    if (statusFailure) return statusFailure;
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Failed to parse JSON from ${url}: ${e}`);
    }
  }, url);
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
): Promise<any> {
  return fetchJSONImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains, method, body);
}

/** ALS-reading replacement for `__internal_fetchJSON`. */
export async function _fetchJSON(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string,
  body: any,
): Promise<any> {
  const { ctx, stack } = getRuntimeContext();
  return fetchJSONImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains, method, body);
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
): Promise<string | ResultFailure> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const signal = ctx.getAbortSignal(stack);
  return await runHttp(async () => {
    const result = await fetch(url, buildInit(method, headers, body, signal));
    const contentType = result.headers.get("content-type") ?? "";
    const responseBody = await readBodyCapped(result, url, signal);
    const statusFailure = httpStatusFailure(result, url, responseBody);
    if (statusFailure) return statusFailure;
    if (contentType.includes("text/html")) {
      return htmlToMarkdown(responseBody);
    }
    return responseBody;
  }, url);
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
): Promise<string | ResultFailure> {
  return fetchMarkdownImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains, method, body);
}

/** ALS-reading replacement for `__internal_fetchMarkdown`. */
export async function _fetchMarkdown(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
  method: string,
  body: any,
): Promise<string | ResultFailure> {
  const { ctx, stack } = getRuntimeContext();
  return fetchMarkdownImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains, method, body);
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

  s = s.replace(
    /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, inner) => {
      const text = stripTags(inner).trim();
      return text ? `[${text}](${href})` : href;
    },
  );

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

export function checkAllowedDomains(
  url: string,
  allowedDomains: string[],
): string | null {
  if (allowedDomains.length === 0) return null;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const allowed = allowedDomains.map((d) => d.toLowerCase());
    if (!allowed.includes(hostname)) {
      return `Domain "${hostname}" is not in allowedDomains.`;
    }
    return null;
  } catch {
    return `Invalid URL: "${url}"`;
  }
}
