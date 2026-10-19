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
import { toolStatusText, type StoryRow } from "./story.js";
import { roundsOf } from "./timeline/rounds.js";
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
  const events = row.node.event
    ? [row.node.event]
    : row.node.children.flatMap((child) => (child.event ? [child.event] : []));
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
      events,
      comments: [...threads],
    },
  };
}

/** The one-line summary of where a row sits, new here: the viewer spreads
 *  these facts over the outline and the token line. */
function headerLine(row: StoryRow, trace: TreeNode): string {
  switch (row.kind) {
    case "round": {
      const total = roundsOf(trace).length;
      return [
        `Thread · ${row.round.threadLabel ?? "unnamed"}`,
        `LLM call ${row.round.index + 1} of ${total}`,
        row.round.model,
        fmtDuration(row.round.durationMs, { minutes: true }),
        fmtUsd(row.round.costUsd),
      ].join(" · ");
    }
    case "user":
      return `User turn · ${row.text.split("\n")[0]}`;
    case "tool":
      return [
        `Tool · ${row.name}`,
        toolStatusText({ status: row.status, work: row.work }),
        fmtDuration(row.durationMs, { minutes: true }),
      ].join(" · ");
    case "interrupt":
      return `Interrupt · ${row.interrupt.effect} · ${row.interrupt.outcome}`;
    case "error":
      return `Error · ${row.message.split("\n")[0]}`;
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
