import * as path from "path";
import { expandPath } from "./expandPath.js";

/**
 * Media-path scanner backing the agent's `detectAttachments`
 * (`lib/agents/agency-agent/lib/attachments.agency`). Pure string work —
 * no filesystem access — so the Agency side keeps only the stateful
 * stages (agent-cwd resolution, dedupe, stat, read).
 *
 * Lives in TS rather than Agency for speed: detection runs on EVERY user
 * message, and an Agency per-character loop pays the Runner step
 * machinery per iteration. This is one JS pass.
 *
 * Not a tarsec grammar on purpose: this is span-extraction from
 * arbitrary prose, not a structured parse. Quote handling needs boundary
 * + content guards (an apostrophe in "here's" must not open a quote; a
 * quoted span only counts when it is its own whitespace-delimited token
 * AND its content ends in a media extension), which is regex-with-
 * anchors territory — a combinator version would be a hand-rolled
 * backtracking scanner wearing tarsec types.
 */

export type MediaPathCandidate = { path: string; mime: string };

/** extension (lowercase, with dot) -> MIME type. Media-only by design:
 *  code/text paths stay with the agent's read tool. */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Cheap bail-out probe so text-only messages (the overwhelming majority)
 *  cost one regex test, not a tokenize pass. */
const MEDIA_EXT_HINT = /\.(png|jpe?g|gif|webp|pdf)/i;

/** A quoted span is only a token when the quote opens at a token boundary
 *  (start-of-string or after whitespace — terminal drag-drop inserts
 *  `'path'` as its own token), the closing quote is followed by a
 *  boundary, and the content ends in a media extension. Anything else
 *  (apostrophes in prose, quoted non-media text) falls through to plain
 *  word tokenization. Content excludes quotes and newlines. */
const QUOTED_MEDIA_SPAN =
  /(?:^|(?<=\s))(['"])([^'"\n]+?\.(?:png|jpe?g|gif|webp|pdf))\1(?=\s|$)/gi;

/** Sentinel standing in for a backslash-escaped space inside an unquoted token
 *  (`my\ file.png`) so it survives whitespace splitting; NUL cannot
 *  appear in terminal line input. */
const ESCAPED_SPACE = "\u0000";

function pushWords(segment: string, out: string[]): void {
  const words = segment.replace(/\\ /g, ESCAPED_SPACE).split(/\s+/);
  for (const word of words) {
    if (word !== "") {
      out.push(word.split(ESCAPED_SPACE).join(" "));
    }
  }
}

/** Trim trailing punctuation typed right after a path (`, . ? :` plus a
 *  stray quote from a partially-recognized quoted span), then expand a
 *  leading tilde. `expandPath` is the stdlib's single owner of path-
 *  shorthand policy; it throws on `~user/...`, which is not a media
 *  mention worth failing detection over — leave those tokens as-is (the
 *  Agency side drops them at the stat gate). */
function normalizeToken(token: string): string {
  let normalized = token;
  while (normalized.length > 0 && /[,.?:'"]$/.test(normalized)) {
    normalized = normalized.slice(0, normalized.length - 1);
  }
  if (normalized === "~" || normalized.startsWith("~/")) {
    normalized = expandPath(normalized);
  }
  return normalized;
}

/** Scan a user message for media-file mentions (drag-dropped quoted
 *  paths, escaped-space paths, plain path tokens) and return them in
 *  message order as `{ path, mime }` candidates. Purely lexical: paths
 *  are NOT resolved or checked for existence here. */
export function _scanMediaPaths(msg: string): MediaPathCandidate[] {
  if (!MEDIA_EXT_HINT.test(msg)) {
    return [];
  }
  // Single ordered pass: quoted media spans are lifted out whole; the
  // gaps between them tokenize as words.
  const tokens: string[] = [];
  let last = 0;
  for (const match of msg.matchAll(QUOTED_MEDIA_SPAN)) {
    pushWords(msg.slice(last, match.index), tokens);
    tokens.push(match[2]);
    last = match.index + match[0].length;
  }
  pushWords(msg.slice(last), tokens);

  const candidates: MediaPathCandidate[] = [];
  for (const token of tokens) {
    const normalized = normalizeToken(token);
    const mime = MIME_TYPES[path.extname(normalized).toLowerCase()];
    if (mime !== undefined) {
      candidates.push({ path: normalized, mime });
    }
  }
  return candidates;
}
