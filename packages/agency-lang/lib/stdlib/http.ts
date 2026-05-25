import { AgencyCancelledError, isAbortError } from "../runtime/errors.js";
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
 * runtime's `AgencyCancelledError`. Without this translation a
 * cancelled fetch surfaces as a `DOMException("AbortError")` or
 * `TypeError("fetch failed")`, which the agency `try` wrapper
 * would silently convert into a `Failure` value — defeating the
 * whole point of cancellation propagation. By throwing
 * `AgencyCancelledError`, `__tryCall` (which re-throws it like
 * `GuardExceededError`) lets the cancellation reach the runner.
 */
async function runHttp<T>(fn: () => Promise<T>, url: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isAbortError(e)) {
      throw new AgencyCancelledError(`fetch ${url} cancelled`);
    }
    throw e;
  }
}

export async function __internal_fetch(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
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

export async function __internal_fetchJSON(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
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

export async function __internal_fetchMarkdown(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
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
