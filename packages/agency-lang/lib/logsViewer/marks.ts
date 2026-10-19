// Comment marks: what the screens need to draw a `✎` or `⚑` beside a row and
// list its comments under the payload. Built by the shell from the comments
// store and handed to every view as data through `setMarks`, the way trace
// annotations are, so no painter knows where a comment comes from. Pure.
import { type Anchor, type CommentThread, type FoldedComments } from "../runDirectory/comments.js";
import type { StoryRow } from "./story.js";

/** The comment threads on one row. */
export type RowMarkSet = { threads: CommentThread[] };
/** Row id → its marks, for one trace. */
export type TraceMarks = Record<string, RowMarkSet>;
/** Trace id → its rows' marks. Row ids are only unique inside a trace. */
export type RowMarks = Record<string, TraceMarks>;

export type MarkOptions = {
  /** Show an agent's own notes. A reply to a person's comment is always
   *  shown under it; the toggle hides only the notes nobody asked for. */
  showAgentNotes: boolean;
};

export const HUMAN_MARK = "✎";
export const AGENT_MARK = "⚑";

/** Ids come from logs and comment files, so the dictionaries have no
 *  prototype: a trace named `__proto__` or a row named `constructor` is
 *  just a key. */
export function emptyMarks(): RowMarks {
  return Object.create(null) as RowMarks;
}

export function marksFrom(folded: FoldedComments, options: MarkOptions): RowMarks {
  const marks = emptyMarks();
  for (const thread of folded.threads) {
    if (!options.showAgentNotes && !hasHumanWords(thread)) {
      continue;
    }
    const { traceId, rowId } = thread.comment;
    marks[traceId] ??= Object.create(null) as TraceMarks;
    marks[traceId][rowId] ??= { threads: [] };
    marks[traceId][rowId].threads.push(thread);
  }
  return marks;
}

/** A thread the person took part in stays visible while agent notes are
 *  hidden: hiding the agent's note must not hide the person's own reply
 *  under it. */
function hasHumanWords(thread: CommentThread): boolean {
  return (
    thread.comment.author.kind === "human" ||
    thread.replies.some((reply) => reply.author.kind === "human")
  );
}

export function marksForRow(marks: RowMarks, traceId: string, rowId: string): RowMarkSet {
  if (!Object.hasOwn(marks, traceId) || !Object.hasOwn(marks[traceId], rowId)) {
    return { threads: [] };
  }
  return marks[traceId][rowId];
}

/** The gutter text for a row: `✎` when a person commented, `⚑` when an agent
 *  left a note of its own, both when both, empty when neither. */
export function markGlyphs(set: RowMarkSet): string {
  const human = set.threads.some((thread) => thread.comment.author.kind === "human");
  const agent = set.threads.some((thread) => thread.comment.author.kind === "agent");
  return `${human ? HUMAN_MARK : ""}${agent ? AGENT_MARK : ""}`;
}

/** Comments on a trace, for the picker's `N comments`. Counts every thread
 *  the marks hold, so it follows the agent-notes toggle. */
export function commentCount(marks: RowMarks, traceId: string): number {
  if (!Object.hasOwn(marks, traceId)) {
    return 0;
  }
  return Object.values(marks[traceId]).reduce((sum, set) => sum + set.threads.length, 0);
}

/** A leaf row's own event time, else the earliest time under its span. */
function rowTime(row: StoryRow): string | undefined {
  const stamp = row.node.event?.data.timestamp;
  if (typeof stamp === "string") {
    return stamp;
  }
  return row.node.firstTs === undefined ? undefined : new Date(row.node.firstTs).toISOString();
}

/** The facts about a row a comment keeps beside its id, so a reader can say
 *  what it was about if the id stops resolving. */
export function anchorFor(row: StoryRow): Anchor {
  const at = rowTime(row);
  switch (row.kind) {
    case "round":
      return { at, thread: row.round.threadLabel, name: row.round.model };
    case "user":
      return { at, name: "user turn" };
    case "tool":
      return { at, name: row.name };
    case "interrupt":
      return { at, name: row.interrupt.effect };
    case "llmGroup":
      return { at, thread: row.label };
    case "subagent":
      return { at, name: row.label };
    default:
      return { at, name: row.kind };
  }
}
