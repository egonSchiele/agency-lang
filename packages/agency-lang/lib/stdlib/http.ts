import {
  AgencyCancelledError,
  isAbortError,
  readCause,
} from "../runtime/errors.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";
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
      // Carry the structured cause off the rejection (it IS the signal's
      // reason). A guard trip that aborted this fetch surfaces as an
      // AgencyCancelledError whose guardTrip cause must survive so the
      // owning guard's `try` converts it instead of letting a bare cancel
      // escape. Falls back to a plain cancel for an external/DOMException abort.
      throw new AgencyCancelledError(`fetch ${url} cancelled`, readCause(e));
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
): Promise<string> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const signal = ctx.getAbortSignal(stack);
  return await runHttp(async () => {
    const result = await fetch(url, { headers, signal });
    try {
      return await readBodyCapped(result, url, signal);
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new Error(`Failed to get text from ${url}: ${e}`);
    }
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
): Promise<string> {
  return fetchImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains);
}

/** ALS-reading replacement for `__internal_fetch`. */
export async function _fetch(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
): Promise<string> {
  const { ctx, stack } = getRuntimeContext();
  return fetchImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains);
}

async function fetchJSONImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
): Promise<any> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const signal = ctx.getAbortSignal(stack);
  return await runHttp(async () => {
    const result = await fetch(url, { headers, signal });
    const text = await readBodyCapped(result, url, signal);
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
): Promise<any> {
  return fetchJSONImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains);
}

/** ALS-reading replacement for `__internal_fetchJSON`. */
export async function _fetchJSON(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
): Promise<any> {
  const { ctx, stack } = getRuntimeContext();
  return fetchJSONImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains);
}

async function fetchMarkdownImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
): Promise<string> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const signal = ctx.getAbortSignal(stack);
  return await runHttp(async () => {
    const result = await fetch(url, { headers, signal });
    const contentType = result.headers.get("content-type") ?? "";
    const body = await readBodyCapped(result, url, signal);
    if (contentType.includes("text/html")) {
      return htmlToMarkdown(body);
    }
    return body;
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
): Promise<string> {
  return fetchMarkdownImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains);
}

/** ALS-reading replacement for `__internal_fetchMarkdown`. */
export async function _fetchMarkdown(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
): Promise<string> {
  const { ctx, stack } = getRuntimeContext();
  return fetchMarkdownImpl(ctx, stack, baseUrl, urlPath, headers, allowedDomains);
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
