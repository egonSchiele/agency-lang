import { describe, expect, it } from "vitest";

import {
  commentWithAnchor,
  foldComments,
  parseCommentsJsonl,
  threadsForTrace,
  type Comment,
} from "./comments.js";

function row(id: string, extra: Partial<Comment> = {}): Comment {
  return {
    v: 1,
    id,
    traceId: "k3Pq9abc",
    rowId: "round:span-7f3a:2",
    anchor: { at: "2026-10-19T14:02:11.408Z", thread: "reviewer", name: "gpt-5" },
    author: { kind: "human", id: "adit" },
    text: "why does it read the config a second time here?",
    created: "2026-10-19T14:30:02.000Z",
    ...extra,
  };
}

describe("parseCommentsJsonl", () => {
  it("reads rows, reports a bad line and skips it, and ignores a torn final line", () => {
    const text =
      JSON.stringify(row("c1")) +
      "\n" +
      "not json\n" +
      JSON.stringify({ v: 1, id: "c3" }) +
      "\n" +
      JSON.stringify(row("c4")) +
      "\n" +
      JSON.stringify(row("c5")).slice(0, 20);
    const parsed = parseCommentsJsonl(text);
    expect(parsed.rows.map((comment) => comment.id)).toEqual(["c1", "c4"]);
    expect(parsed.errors).toEqual([
      { line: 2, detail: "malformed comment row" },
      { line: 3, detail: "malformed comment row" },
    ]);
  });
});

describe("foldComments", () => {
  it("groups replies under the comment they answer, in file order", () => {
    const rows = [
      row("c1"),
      row("c2", { rowId: "span-9c01", text: "and this?" }),
      row("c3", { author: { kind: "agent", id: "claude" }, text: "it retries", replyTo: "c1" }),
      row("c4", { replyTo: "c1", text: "makes sense" }),
    ];
    const folded = foldComments(rows);
    expect(folded.threads.map((thread) => thread.comment.id)).toEqual(["c1", "c2"]);
    expect(folded.threads[0].replies.map((reply) => reply.id)).toEqual(["c3", "c4"]);
    expect(folded.threads[1].replies).toEqual([]);
  });

  it("keeps a reply to a reply in the thread it started from", () => {
    const folded = foldComments([
      row("c1"),
      row("c2", { replyTo: "c1" }),
      row("c3", { replyTo: "c2", text: "and again" }),
    ]);
    expect(folded.threads.map((thread) => thread.comment.id)).toEqual(["c1"]);
    expect(folded.threads[0].replies.map((reply) => reply.id)).toEqual(["c2", "c3"]);
  });

  it("keeps a reply whose parent is missing, as a comment of its own", () => {
    const folded = foldComments([row("c9", { replyTo: "gone" })]);
    expect(folded.threads.map((thread) => thread.comment.id)).toEqual(["c9"]);
  });

  it("filters threads by trace", () => {
    const folded = foldComments([row("c1"), row("c2", { traceId: "other" })]);
    expect(threadsForTrace(folded, "other").map((thread) => thread.comment.id)).toEqual(["c2"]);
  });
});

describe("commentWithAnchor", () => {
  it("words a comment by its thread and name, for a reader who cannot look the row up", () => {
    expect(commentWithAnchor(row("c1"))).toBe(
      "reviewer · gpt-5: why does it read the config a second time here?",
    );
    expect(commentWithAnchor(row("c2", { anchor: {} }))).toBe(
      "why does it read the config a second time here?",
    );
  });
});
