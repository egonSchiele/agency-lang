import { z } from "zod";

/**
 * Comments: a note a person or an agent leaves on ONE ROW of a trace, in the
 * `agency logs` viewer or through `agency logs session comment add`. They are
 * not annotations: an annotation is an opinion about a trace as a whole with
 * a content-derived id and a fold that decides effective scores, while a
 * comment is about one row, has no score, and needs its own id. One
 * append-only `comments.jsonl` per run directory (or `<file>.comments.jsonl`
 * beside a loose statelog); this module owns the row shape, the parse, and
 * the pure fold from rows to top-level comments with their replies. It does
 * no I/O: `commentsStore.ts` reads and `mutations.ts` writes.
 */

export type CommentAuthor = { kind: "human" | "agent"; id: string };

/** Facts about the row that do not depend on the row-id format, so a comment
 *  can still say what it was about if the id stops resolving: the row's
 *  time, its thread, and the tool or model it names. */
export type Anchor = { at?: string; thread?: string; name?: string };

export type Comment = {
  v: 1;
  id: string;
  traceId: string;
  rowId: string;
  anchor: Anchor;
  author: CommentAuthor;
  text: string;
  created: string;
  /** The comment this one answers; an agent's reply to a person's question. */
  replyTo?: string;
};

export type CommentDraft = Omit<Comment, "v" | "id" | "created">;

const CommentAuthorSchema = z.object({ kind: z.enum(["human", "agent"]), id: z.string().min(1) });
const AnchorSchema = z.object({
  at: z.string().optional(),
  thread: z.string().optional(),
  name: z.string().optional(),
});
export const CommentSchema = z
  .object({
    v: z.literal(1),
    id: z.string().min(1),
    traceId: z.string().min(1),
    rowId: z.string().min(1),
    anchor: AnchorSchema,
    author: CommentAuthorSchema,
    text: z.string(),
    created: z.string(),
    replyTo: z.string().min(1).optional(),
  })
  .strict();

export type CommentParseError = { line: number; detail: string };

/** Tolerant, like `readAnnotations`: a bad line is reported and skipped, and a
 *  final line without its newline is a torn write and is ignored. */
export function parseCommentsJsonl(text: string): { rows: Comment[]; errors: CommentParseError[] } {
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const rows: Comment[] = [];
  const errors: CommentParseError[] = [];
  complete.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") {
      return;
    }
    const parsed = parseRow(raw);
    if (parsed === undefined) {
      errors.push({ line: index + 1, detail: "malformed comment row" });
      return;
    }
    rows.push(parsed);
  });
  return { rows, errors };
}

function parseRow(raw: string): Comment | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = CommentSchema.safeParse(value);
  return result.success ? (result.data as Comment) : undefined;
}

/** A top-level comment with the replies that answer it, in file order. */
export type CommentThread = { comment: Comment; replies: Comment[] };

export type FoldedComments = {
  /** In file order. A reply whose parent is not in the file is listed on
   *  its own, so nothing anyone wrote disappears. */
  threads: CommentThread[];
};

export function foldComments(rows: readonly Comment[]): FoldedComments {
  const ids = rows.map((row) => row.id);
  const topLevel = rows.filter((row) => row.replyTo === undefined || !ids.includes(row.replyTo));
  return {
    threads: topLevel.map((comment) => ({
      comment,
      replies: rows.filter((row) => row.replyTo === comment.id),
    })),
  };
}

export function threadsForTrace(folded: FoldedComments, traceId: string): CommentThread[] {
  return folded.threads.filter((thread) => thread.comment.traceId === traceId);
}

/** How a comment reads to someone (or a model) who cannot look the row up:
 *  `reviewer · gpt-5 call: why does it read the config a second time?`. */
export function anchorText(anchor: Anchor): string {
  return [anchor.thread, anchor.name].filter((part) => part !== undefined).join(" · ");
}

export function commentWithAnchor(comment: Comment): string {
  const where = anchorText(comment.anchor);
  return where.length === 0 ? comment.text : `${where}: ${comment.text}`;
}
