import { modelSupportsInputModality, type ImagePart, type FilePart } from "smoltalk";
import { MAX_REPLY_ATTACHMENTS_PER_CALL, MAX_REPLY_ATTACHMENT_BYTES } from "../config/config.js";
import { success, failure, isSuccess, type ResultValue } from "./result.js";

/**
 * Reply attachments: the channel by which a TOOL hands images back to the
 * model. `attachToReply` (std::thread) queues onto the calling tool
 * invocation's branch-local stack via `StateStack.queueReplyAttachment`
 * (serialized — survives a mid-round interrupt); the tool loop drains the
 * branch queue at invocation completion, harvests it here into the prompt's
 * `runnerState` (per-llm()-call, serialized, fork-safe), and appends a
 * marker to that tool's result text; after the full tool round the loop
 * injects ONE labeled user message built here. See
 * docs/superpowers/specs/2026-07-02-tool-reply-attachments-design.md and
 * docs/dev/agents/reply-attachments.md.
 *
 * The marker strings below are MODEL-FACING API — tests pin them; do not
 * reword casually. (They contain em-dashes, not hyphens.)
 */

/** A tool-produced attachment is exactly a smoltalk user-content image or
 *  file part — the same shapes `image()` / `file()` (std::thread) build. */
export type ReplyAttachmentPart = ImagePart | FilePart;

export type HarvestedReplyAttachment = {
  id: string;
  toolName: string;
  part: ReplyAttachmentPart;
};

/** The runnerState key the harvested attachments wait under until the
 *  round boundary delivers them. */
export const BUFFER_KEY = "replyAttachments";
const COUNTER_KEY = "replyAttachmentCounter";

/** Decoded size estimate: base64 length * 3/4 for inline data, which is
 *  what a path source became when it was queued. URLs and provider refs
 *  are unknowable pre-fetch and pass through (documented limitation —
 *  mirrors user-supplied URL attachments). */
function estimatedBytes(part: ReplyAttachmentPart): number | null {
  if (part.source.kind === "base64") {
    return Math.floor((part.source.base64.length * 3) / 4);
  }
  return null;
}

/** Pure gate: decide whether one queued part may attach, given how many
 *  survivors this llm() call already has. A failure's `error` is the skip
 *  REASON (the text after "skipped: " in the marker) so gating logic and
 *  marker wording stay separable — adding a gate never touches the harvest
 *  loop. Passing `model` straight through to smoltalk is deliberate: it is
 *  exactly what smoltalk's own send-time gate does with `config.model`, so
 *  this pre-check can never disagree with send. */
function gateReplyAttachment(
  part: ReplyAttachmentPart,
  acceptedSoFar: number,
  model: unknown,
): ResultValue {
  const modality = part.type === "image" ? "image" : "pdf";
  const modalityWord = part.type === "image" ? "image" : "PDF";
  // Tri-state on purpose: only an explicit catalog `false` drops the
  // attachment — unknown models attach optimistically, matching
  // smoltalk's own send-time gate.
  if (modelSupportsInputModality(model as any, modality) === false) {
    return failure(`the current model has no ${modalityWord} input`);
  }
  if (part.source.kind === "path") {
    // The bridge reads a path source when the tool queues it and queues
    // the bytes; a path still here is one it could not read. Caught at
    // harvest so the tool result carries an honest skip marker.
    return failure("file not found");
  }
  const bytes = estimatedBytes(part);
  if (bytes !== null && bytes > MAX_REPLY_ATTACHMENT_BYTES) {
    return failure("too large to attach (over 20 MB)");
  }
  if (acceptedSoFar >= MAX_REPLY_ATTACHMENTS_PER_CALL) {
    return failure(
      `too many attachments for this llm() call (limit ${MAX_REPLY_ATTACHMENTS_PER_CALL})`,
    );
  }
  return success(undefined);
}

/** Gate each drained entry, move survivors into `runnerState[BUFFER_KEY]`,
 *  and return the marker text to append to that tool's result (empty string
 *  when nothing was queued). Runs inside the idempotent per-tool invoke step
 *  of the tool loop, so it executes exactly once per tool call, including
 *  across interrupt/resume. */
export function harvestReplyAttachments(args: {
  queued: ReplyAttachmentPart[];
  runnerState: Record<string, any>;
  model: unknown;
  toolName: string;
}): string {
  const { queued, runnerState, model, toolName } = args;
  if (queued.length === 0) {
    return "";
  }

  runnerState[BUFFER_KEY] ??= [];
  runnerState[COUNTER_KEY] ??= 0;
  const buffer = runnerState[BUFFER_KEY] as HarvestedReplyAttachment[];

  const lines: string[] = [];
  for (const part of queued) {
    const id = `img_${++runnerState[COUNTER_KEY]}`;
    const gate = gateReplyAttachment(part, buffer.length, model);
    if (isSuccess(gate)) {
      buffer.push({ id, toolName, part });
      lines.push(`[attached ${id} — delivered in the user message following these tool results]`);
    } else {
      lines.push(`[attachment ${id} skipped: ${gate.error}]`);
    }
  }
  return `\n\n${lines.join("\n")}`;
}

/** Append the harvest marker to a (possibly non-string) capped tool
 *  result. Kept here so the "" no-marker sentinel never leaks decisions
 *  into prompt.ts — the caller composes unconditionally. */
export function appendReplyMarker(
  cappedResult: unknown,
  marker: string,
  stringify: (value: unknown) => string,
): unknown {
  if (marker === "") {
    return cappedResult;
  }
  if (typeof cappedResult === "string") {
    return `${cappedResult}${marker}`;
  }
  return `${stringify(cappedResult)}${marker}`;
}

/** Build the parts array for the injected user message: one label text part
 *  immediately before each attachment part. A path source was read into
 *  base64 when the tool queued it, so the persistent thread never re-reads
 *  a file that may later be deleted or edited; url/base64/provider sources
 *  pass through. Never throws: a path harvest let through (it cannot) is
 *  reported as a text part. */
export function buildReplyUserMessage(harvested: HarvestedReplyAttachment[]): unknown[] {
  const parts: unknown[] = [];
  for (const entry of harvested) {
    const kindWord = entry.part.type === "image" ? "image" : "file";
    const label = `[${entry.id} — ${kindWord} output of tool ${entry.toolName}]`;
    if (entry.part.source.kind === "path") {
      parts.push({ type: "text", text: `[${entry.id} could not be read: file not found]` });
    } else {
      parts.push({ type: "text", text: label });
      parts.push(entry.part);
    }
  }
  return parts;
}
