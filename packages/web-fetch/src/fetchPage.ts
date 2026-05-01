import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export type FetchPageResult = {
  title: string;
  content: string;
  excerpt: string;
  siteName: string;
  url: string;
};

export type FetchPageOptions = {
  maxChars?: number;
  timeout?: number;
};

export async function fetchPage(
  url: string,
  options?: FetchPageOptions,
): Promise<FetchPageResult> {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html",
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`Fetch error (${response.status}): ${body}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new Error(`Expected HTML but got ${contentType.split(";")[0].trim()}`);
  }

  const html = await response.text();
  const { document } = parseHTML(html);

  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  if (!article) {
    throw new Error(`Could not extract content from ${url}: no extractable content`);
  }

  let content = htmlToMarkdown(article.content);
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
  }

  return {
    title: article.title ?? "",
    content,
    excerpt: article.excerpt ?? "",
    siteName: article.siteName ?? "",
    url: response.url,
  };
}

function htmlToMarkdown(html: string): string {
  let s = html;

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
  s = s.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m] ?? m);
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
