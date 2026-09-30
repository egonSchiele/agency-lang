import { type ColorFunction } from "../utils/termcolors.js";
import { LOCAL_IMAGE_FIELDS } from "../stdlib/localImageInputs.js";
import { VISION_TASKS, type VisionTaskRow } from "../stdlib/vision.js";

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
  /** Every byte pushed, whether kept or not. An audio reply is logged by
   *  this count. */
  total: number;
};

/** Collects up to `limit` bytes of a reply as it streams to the client. It
 *  never changes what the client gets; it only keeps a copy. */
export function createCapture(limit: number = CAPTURE_LIMIT): Capture {
  const parts: Buffer[] = [];
  let kept = 0;
  const capture: Capture = {
    truncated: false,
    total: 0,
    push: (chunk) => {
      capture.total += chunk.length;
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
  /** Set for an audio reply, whose bytes are never logged: how many there were. */
  audioBytes?: number;
  /** Set for a successful image reply, whose base64 is never logged: how
   *  many bytes the reply had, and the format the request asked for. */
  image?: { bytes: number; format: string };
  /** Set for a successful vision reply: what it was, counted. */
  vision?: string;
};

/** One reply as it went out: the status, the body the capture kept, its
 *  content type, whether the capture was cut short, and how many bytes
 *  there were in all. */
export type Reply = {
  status: number;
  body: string;
  contentType: string | undefined;
  truncated: boolean;
  totalBytes: number;
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

/** The request fields that carry an image as base64: the image server's
 *  input images, and the one image a vision request sends. The log shows
 *  each as a note of its size. */
const IMAGE_REQUEST_FIELDS = [...Object.keys(LOCAL_IMAGE_FIELDS), "image"];

/** The request body for the log: the JSON that was forwarded, indented so a
 *  long messages array is readable. An input image is shown as a note of
 *  its count and size, never as its base64. */
export function describeRequest(body: Record<string, unknown>): string | null {
  if (Object.keys(body).length === 0) {
    return null;
  }
  const shown = { ...body };
  for (const field of IMAGE_REQUEST_FIELDS) {
    if (field in shown) {
      shown[field] = imageNote(shown[field]);
    }
  }
  return JSON.stringify(shown, null, 2);
}

/** What the log shows in place of an image field's base64: how many images
 *  and their decoded size, such as `<3 images, 4.2 MB>`. */
function imageNote(value: unknown): string {
  const images = Array.isArray(value) ? value : [value];
  const bytes = images.reduce<number>((sum, image) => sum + decodedBytes(image), 0);
  const count = images.length === 1 ? "1 image" : `${images.length} images`;
  return `<${count}, ${megabytes(bytes)}>`;
}

/** The size of the bytes a base64 string holds, from its length alone. */
function decodedBytes(image: unknown): number {
  if (typeof image !== "string") {
    return 0;
  }
  const padding = image.length - image.replace(/=+$/, "").length;
  return Math.max(0, Math.floor((image.length * 3) / 4) - padding);
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

/** Whether a content type is audio, whose bytes do not belong in a terminal.
 *  The speech server sends raw PCM as application/octet-stream. */
function isAudio(contentType: string | undefined): boolean {
  return (
    contentType !== undefined &&
    (contentType.startsWith("audio/") || contentType === "application/octet-stream")
  );
}

/** Where image servers answer. A reply there holds about a megabyte of
 *  base64, which does not belong in a terminal. */
export const IMAGES_PATH = "/v1/images/generations";

/** The vision task a path is for, from `VISION_TASKS`, or undefined. A
 *  reply there is logged by its count. */
function visionTaskAt(requestPath: string): VisionTaskRow | undefined {
  return Object.values(VISION_TASKS).find((row) => `/v1${row.route}` === requestPath);
}

/** Where vision servers answer. */
export const VISION_PATHS = Object.values(VISION_TASKS).map((row) => `/v1${row.route}`);

/** What the log knows about the request a reply answers. */
export type RequestFacts = { path: string; outputFormat?: string };

/** One reply, kept whole for the log. A body that is a single JSON object is
 *  indented; a stream of `data:` frames is left exactly as it came, since the
 *  framing is often what you are debugging. Audio is summarized by its size.
 *  A successful image reply is summarized from the request and the byte
 *  count alone, never parsed, so a capture cut short makes no difference.
 *  An image server returns one image per request. */
export function describeReply(reply: Reply, request?: RequestFacts): ReplySummary {
  const { body, contentType, truncated } = reply;
  if (isAudio(contentType)) {
    return { body: "", streamed: false, truncated: false, audioBytes: reply.totalBytes };
  }
  if (request?.path === IMAGES_PATH && reply.status >= 200 && reply.status < 300) {
    return {
      body: `<image reply, ${megabytes(reply.totalBytes)}>`,
      streamed: false,
      truncated: false,
      image: { bytes: reply.totalBytes, format: request.outputFormat ?? "png" },
    };
  }
  const streamed = contentType !== undefined && contentType.includes("text/event-stream");
  if (streamed) {
    return { body, streamed, truncated, ...streamedUsage(body) };
  }
  const parsed = parseObject(body);
  const visionTask = request === undefined ? undefined : visionTaskAt(request.path);
  if (visionTask !== undefined && reply.status >= 200 && reply.status < 300 && parsed !== null) {
    const count = describeVision(parsed, visionTask);
    return {
      body: visionTask.logBody ? JSON.stringify(parsed, null, 2) : `<${count}>`,
      streamed: false,
      truncated,
      vision: count,
    };
  }
  return {
    body: parsed === null ? body : JSON.stringify(parsed, null, 2),
    streamed,
    truncated,
    ...(parsed === null ? {} : usageOf(parsed)),
  };
}

/** A vision reply in a few words: `3 detections`, `24 tags`, `1 caption`.
 *  A reply field that is a list counts its items; any other counts as
 *  one. */
function describeVision(parsed: Record<string, unknown>, row: VisionTaskRow): string {
  const answer = parsed[row.replyField];
  if (answer === undefined) {
    return "vision reply";
  }
  const count = Array.isArray(answer) ? answer.length : 1;
  return `${count} ${row.logNoun}${count === 1 ? "" : "s"}`;
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

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** The counts after a reply: its audio or image size, or its token counts. */
function replyCounts(reply: ReplySummary | null): string | null {
  if (reply?.audioBytes !== undefined) {
    return `${reply.audioBytes.toLocaleString("en-US")} bytes of audio`;
  }
  if (reply?.image !== undefined) {
    return `1 image, ${megabytes(reply.image.bytes)} ${oneLine(reply.image.format)}`;
  }
  return tokenCounts(reply);
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
    options.verbose ? null : replyCounts(entry.reply),
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
  const counts = replyCounts(entry.reply);
  if (counts !== null) {
    lines.push(`  ${paint.dim(counts)}`);
  }
  return lines;
}
