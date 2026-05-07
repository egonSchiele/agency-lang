const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function readBodyCapped(response: Response, url: string): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let total = 0;
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

export async function _fetch(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
): Promise<string> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const result = await fetch(url, { headers });
  try {
    return await readBodyCapped(result, url);
  } catch (e) {
    throw new Error(`Failed to get text from ${url}: ${e}`);
  }
}

export async function _fetchJSON(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
): Promise<any> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const result = await fetch(url, { headers });
  const text = await readBodyCapped(result, url);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse JSON from ${url}: ${e}`);
  }
}

export async function _webfetch(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
): Promise<string> {
  const url = validateUrl(baseUrl, urlPath, allowedDomains);
  const result = await fetch(url, { headers });
  const contentType = result.headers.get("content-type") ?? "";
  const body = await readBodyCapped(result, url);
  if (contentType.includes("text/html")) {
    return htmlToMarkdown(body);
  }
  return body;
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
