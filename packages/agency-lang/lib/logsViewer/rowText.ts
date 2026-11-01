// One row of one trace, expanded for a reader outside the viewer: what the
// person dictates by hand today ("the fourth LLM call on the reviewer
// thread, where it calls readFile…"). The text comes from the viewer's own
// payload functions, so the agent reads what the person reads.
import type { CommentThread } from "../runDirectory/comments.js";
import { formatAddress } from "./address.js";
import { findRow } from "./detailTarget.js";
import { fmtUsd } from "./format.js";
import { anchorFor } from "./marks.js";
import { payloadFor } from "./payload.js";
import { payloadText } from "./payloadText.js";
import { fmtDuration } from "./spanText.js";
import { rowEvents, toolStatusText, type StoryRow } from "./story.js";
import { modelText, roundsOf } from "./timeline/rounds.js";
import type { EventEnvelope, TreeNode } from "./types.js";

export type ExpandedRow = {
  address: string;
  kind: StoryRow["kind"];
  /** `Thread · reviewer · LLM call 4 of 9 · gpt-5 · 2.1s · $0.004` */
  header: string;
  text: string;
  json: {
    address: string;
    kind: StoryRow["kind"];
    header: string;
    anchor: ReturnType<typeof anchorFor>;
    events: EventEnvelope[];
    /** A hosted call's own items from the provider; it has no events. */
    providerItems?: unknown[];
    comments: CommentThread[];
  };
};

export function expandRow(
  trace: TreeNode,
  rowId: string,
  threads: readonly CommentThread[] = [],
): ExpandedRow | undefined {
  const row = findRow(trace, rowId);
  if (row === undefined) {
    return undefined;
  }
  const address = formatAddress(trace.traceId, rowId);
  const header = headerLine(row, trace);
  const body = payloadText(payloadFor(row, { raw: false, trace, comments: [...threads] }));
  const text = [address, `  ${header}`, ...body.split("\n").map((line) => `  ${line}`)].join("\n");
  return {
    address,
    kind: row.kind,
    header,
    text,
    json: {
      address,
      kind: row.kind,
      header,
      anchor: anchorFor(row),
      events: rowEvents(row),
      ...(row.kind === "hosted" ? { providerItems: row.call.raw } : {}),
      comments: [...threads],
    },
  };
}

/** The one-line summary of where a row sits: the viewer spreads these
 *  facts over the outline and the token line. `session show` prints it
 *  whole; `agency logs outline` and `search` cut it to a width. */
export function headerLine(row: StoryRow, trace: TreeNode): string {
  switch (row.kind) {
    case "round": {
      const total = roundsOf(trace).length;
      return [
        `Thread · ${row.round.threadLabel ?? "unnamed"}`,
        `LLM call ${row.round.index + 1} of ${total}`,
        modelText(row.round),
        fmtDuration(row.round.durationMs, { minutes: true }),
        fmtUsd(row.round.costUsd),
      ].join(" · ");
    }
    case "user":
      return `User turn · ${firstLine(row.text)}`;
    case "tool":
      return [
        `Tool · ${row.name}`,
        toolStatusText({ status: row.status, work: row.work }),
        fmtDuration(row.durationMs, { minutes: true }),
      ].join(" · ");
    case "hosted":
      return [
        `Hosted tool call · ${row.call.tool}`,
        row.call.status ?? "status not recorded",
        `inside LLM call ${row.round.index + 1}`,
      ].join(" · ");
    case "interrupt":
      return `Interrupt · ${row.interrupt.effect} · ${row.interrupt.outcome}`;
    case "error":
      return `Error · ${firstLine(row.message)}`;
    case "llmGroup":
      return row.title;
    case "subagent":
      return `Subagent · ${row.label}`;
    case "pause":
      return row.resumed ? "Paused, then resumed" : "Paused";
    case "machinery":
      return row.text;
  }
}

/** The first line with text on it: a prompt often opens with a blank line. */
function firstLine(text: string): string {
  return text.trim().split("\n")[0];
}

/** A thread whose row no longer resolves is listed by its anchor and marked
 *  re-anchored, replies included, never dropped. */
export function unresolvedCommentText(thread: CommentThread): string {
  const { comment } = thread;
  const where = [comment.anchor.thread, comment.anchor.name, comment.anchor.at]
    .filter((part) => part !== undefined)
    .join(" · ");
  return [
    `${formatAddress(comment.traceId, comment.rowId)} (re-anchored: the row id no longer resolves)`,
    `  ${where.length === 0 ? "no anchor recorded" : where}`,
    `  ${comment.id} ${comment.author.id}: ${comment.text}`,
    ...thread.replies.map((reply) => `    ${reply.id} ${reply.author.id}: ${reply.text}`),
  ].join("\n");
}
