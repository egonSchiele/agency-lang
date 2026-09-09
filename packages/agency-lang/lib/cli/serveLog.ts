import { type ColorFunction } from "../utils/termcolors.js";

/** What `agency local serve` prints about one request that reached its front
 *  door. The front door times the request and collects the reply; everything
 *  here is formatting, so it can be tested without a server. */

/** How much of a reply body is kept for the log. A long generation is worth
 *  reading; a whole context window pasted back is not, and the cap keeps a
 *  runaway reply from growing memory. */
export const CAPTURE_LIMIT = 1024 * 1024;

export type Capture = {
  push: (chunk: Buffer) => void;
  text: () => string;
  /** True once a chunk arrived that did not fit. */
  truncated: boolean;
};

/** Collects up to `limit` bytes of a reply as it streams to the client. It
 *  never changes what the client gets; it only keeps a copy. */
export function createCapture(limit: number = CAPTURE_LIMIT): Capture {
  const parts: Buffer[] = [];
  let kept = 0;
  const capture: Capture = {
    truncated: false,
    push: (chunk) => {
      const room = limit - kept;
      if (room <= 0) {
        capture.truncated = true;
        return;
      }
      if (chunk.length > room) {
        parts.push(chunk.subarray(0, room));
        kept = limit;
        capture.truncated = true;
        return;
      }
      parts.push(chunk);
      kept += chunk.length;
    },
    text: () => Buffer.concat(parts).toString("utf8"),
  };
  return capture;
}

export type ReplySummary = {
  /** The reply body as the client received it, for the verbose block: one
   *  JSON object, or the whole `data:` stream. */
  body: string;
  /** Whether the body is a stream of frames rather than one JSON object. */
  streamed: boolean;
  promptTokens?: number;
  completionTokens?: number;
  truncated: boolean;
};

export type LogEntry = {
  method: string;
  path: string;
  /** The model the request named, or null when it named none. */
  model: string | null;
  status: number;
  durationMs: number;
  /** The request body as it arrived, for the verbose block. */
  request: string | null;
  reply: ReplySummary | null;
};

export type LogOptions = { verbose: boolean; color: ColorFunction };

/** The request body for the log: the JSON that was forwarded, indented so a
 *  long messages array is readable. */
export function describeRequest(body: Record<string, unknown>): string | null {
  if (Object.keys(body).length === 0) {
    return null;
  }
  return JSON.stringify(body, null, 2);
}

type Usage = { prompt_tokens?: unknown; completion_tokens?: unknown };

function usageOf(parsed: { usage?: unknown }): Partial<ReplySummary> {
  const usage = parsed.usage as Usage | undefined;
  if (usage === undefined) {
    return {};
  }
  const out: Partial<ReplySummary> = {};
  if (typeof usage.prompt_tokens === "number") {
    out.promptTokens = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number") {
    out.completionTokens = usage.completion_tokens;
  }
  return out;
}

function parseObject(text: string): { usage?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as { usage?: unknown }) : null;
  } catch {
    // Not JSON: an error page, or a capture cut short. The body still goes
    // in the log; only the token counts are lost.
    return null;
  }
}

/** The token counts a stream reports, which arrive in whichever frame carries
 *  `usage` — the last one. Frames that do not parse are skipped, since a
 *  capture that hit its limit ends mid-frame. */
function streamedUsage(body: string): Partial<ReplySummary> {
  let usage: Partial<ReplySummary> = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") {
      continue;
    }
    const parsed = parseObject(payload);
    if (parsed !== null) {
      usage = { ...usage, ...usageOf(parsed) };
    }
  }
  return usage;
}

/** One reply, kept whole for the log. A body that is a single JSON object is
 *  indented; a stream of `data:` frames is left exactly as it came, since the
 *  framing is often what you are debugging. */
export function describeReply(
  body: string,
  contentType: string | undefined,
  truncated: boolean,
): ReplySummary {
  const streamed = contentType !== undefined && contentType.includes("text/event-stream");
  if (streamed) {
    return { body, streamed, truncated, ...streamedUsage(body) };
  }
  const parsed = parseObject(body);
  return {
    body: parsed === null ? body : JSON.stringify(parsed, null, 2),
    streamed,
    truncated,
    ...(parsed === null ? {} : usageOf(parsed)),
  };
}

/** Milliseconds as something quick to read: under a second in whole
 *  milliseconds, above it in tenths of a second. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One line's worth of text from a request: control characters escaped, so a
 *  model name carrying a newline or an ANSI sequence cannot forge log lines or
 *  drive the terminal. */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /[\x00-\x1f\x7f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function statusColor(status: number, paint: ColorFunction): string {
  const text = String(status);
  if (status >= 500) {
    return paint.red(text);
  }
  if (status >= 400) {
    return paint.yellow(text);
  }
  return paint.green(text);
}

function tokenCounts(reply: ReplySummary | null): string | null {
  if (reply?.promptTokens === undefined || reply.completionTokens === undefined) {
    return null;
  }
  return `${reply.promptTokens}→${reply.completionTokens} tok`;
}

/** Every line but the first of a multi-line block gets the same indent, so a
 *  reply with newlines in it still reads as one entry. */
function block(marker: string, text: string, paint: ColorFunction): string[] {
  const lines = text.split("\n");
  return lines.map((line, index) =>
    index === 0 ? `  ${paint.dim(marker)} ${line}` : `    ${line}`,
  );
}

/** The lines to print for one request: a summary always, and the prompt and
 *  the reply under it when verbose. */
export function serveLogLines(entry: LogEntry, options: LogOptions): string[] {
  const paint = options.color;
  const parts = [
    paint.dim(oneLine(`${entry.method} ${entry.path}`)),
    entry.model === null ? null : paint.cyan(oneLine(entry.model)),
    statusColor(entry.status, paint),
    paint.dim(formatDuration(entry.durationMs)),
    options.verbose ? null : tokenCounts(entry.reply),
  ];
  const lines = [parts.filter((p) => p !== null).join("  ")];
  if (!options.verbose) {
    return lines;
  }
  if (entry.request !== null) {
    lines.push(...block("→", entry.request, paint));
  }
  if (entry.reply === null) {
    return lines;
  }
  // A reply that was cut off still gets a block, even when no bytes of it
  // were captured, or nothing would say that it ended early.
  const marker = entry.reply.truncated ? "… (truncated)" : "";
  const answer = [entry.reply.body, marker].filter((part) => part !== "").join("\n");
  if (answer !== "") {
    lines.push(...block("←", answer, paint));
  }
  const counts = tokenCounts(entry.reply);
  if (counts !== null) {
    lines.push(`  ${paint.dim(counts)}`);
  }
  return lines;
}
