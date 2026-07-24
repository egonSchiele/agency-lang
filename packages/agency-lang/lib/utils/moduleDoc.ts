import type { AgencyMultiLineComment } from "../types.js";

/**
 * Module doc-comment text extraction, shared by `agency doc` (index cards
 * and page headers) and `std::agency`'s `describe` (the `ModuleInfo.
 * description` field) so "the module's summary" means the same thing
 * everywhere it appears.
 */

/** Split an `@summary` override line off a module doc comment's content. */
export function extractSummaryOverride(content: string): {
  override: string | null;
  body: string;
} {
  const lines = content.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return { override: null, body: content };
  const first = lines[firstIdx].trim();
  if (/^@summary(\s+|$)/.test(first)) {
    const text = first.slice("@summary".length).trim();
    const rest = lines.slice(0, firstIdx).concat(lines.slice(firstIdx + 1));
    return {
      override: text === "" ? null : text,
      body: rest.join("\n"),
    };
  }
  return { override: null, body: content };
}

export function firstParagraph(body: string): string {
  const lines = body.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line !== "");
  if (start === -1) return "";
  const afterLead = lines.slice(start);
  const end = afterLead.findIndex(
    (line) => line === "" || line.startsWith("```"),
  );
  const paragraph = end === -1 ? afterLead : afterLead.slice(0, end);
  return paragraph.join(" ").replace(/\s+/g, " ").trim();
}

export function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  return match ? match[0] : text;
}

export function sanitizeDescription(raw: string): string {
  return raw
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

/** The module's one-line summary: the `@summary` override if present,
 *  else the first sentence of the first paragraph, sanitized. */
export function moduleDescription(
  comment: AgencyMultiLineComment | undefined,
): string | null {
  if (!comment) return null;
  const { override, body } = extractSummaryOverride(comment.content);
  const raw = override ?? firstSentence(firstParagraph(body));
  if (!raw) return null;
  const value = sanitizeDescription(raw);
  return value === "" ? null : value;
}
