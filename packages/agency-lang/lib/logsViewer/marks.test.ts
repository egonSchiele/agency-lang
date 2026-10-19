import { describe, expect, it } from "vitest";

import { foldComments, type Comment } from "../runDirectory/comments.js";
import { anchorFor, commentCount, markGlyphs, marksForRow, marksFrom } from "./marks.js";
import { outlineRows } from "./story.js";
import { agentLoopTrace } from "./storyFixture.js";

function comment(id: string, extra: Partial<Comment> = {}): Comment {
  return {
    v: 1,
    id,
    traceId: "T",
    rowId: "round:L:0",
    anchor: {},
    author: { kind: "human", id: "adit" },
    text: id,
    created: "2026-10-19T14:30:02.000Z",
    ...extra,
  };
}

describe("marksFrom", () => {
  const folded = foldComments([
    comment("question"),
    comment("answer", { author: { kind: "agent", id: "claude" }, replyTo: "question" }),
    comment("aside", { author: { kind: "agent", id: "claude" }, rowId: "span-9" }),
    comment("elsewhere", { traceId: "U" }),
  ]);

  it("keeps a reply under the person's comment and hides the agent's own notes by default", () => {
    const marks = marksFrom(folded, { showAgentNotes: false });
    const row = marksForRow(marks, "T", "round:L:0");
    expect(row.threads.map((thread) => thread.comment.id)).toEqual(["question"]);
    expect(row.threads[0].replies.map((reply) => reply.id)).toEqual(["answer"]);
    expect(marksForRow(marks, "T", "span-9").threads).toEqual([]);
    expect(markGlyphs(row)).toBe("✎");
    expect(commentCount(marks, "T")).toBe(1);
    expect(commentCount(marks, "U")).toBe(1);
  });

  it("shows the agent's own notes when asked, with their own glyph", () => {
    const marks = marksFrom(folded, { showAgentNotes: true });
    const aside = marksForRow(marks, "T", "span-9");
    expect(aside.threads.map((thread) => thread.comment.id)).toEqual(["aside"]);
    expect(markGlyphs(aside)).toBe("⚑");
    expect(commentCount(marks, "T")).toBe(2);
  });

  it("keeps an agent note the person replied to while agent notes are hidden", () => {
    const replied = foldComments([
      comment("note", { author: { kind: "agent", id: "claude" }, rowId: "span-9" }),
      comment("still wrong", { replyTo: "note", rowId: "span-9" }),
      comment("aside", { author: { kind: "agent", id: "claude" }, rowId: "span-10" }),
    ]);
    const marks = marksFrom(replied, { showAgentNotes: false });
    const row = marksForRow(marks, "T", "span-9");
    expect(row.threads.map((thread) => thread.comment.id)).toEqual(["note"]);
    expect(row.threads[0].replies.map((reply) => reply.id)).toEqual(["still wrong"]);
    expect(marksForRow(marks, "T", "span-10").threads).toEqual([]);
    expect(commentCount(marks, "T")).toBe(1);
  });

  it("keeps row ids apart by trace", () => {
    const marks = marksFrom(folded, { showAgentNotes: false });
    expect(marksForRow(marks, "U", "round:L:0").threads.map((t) => t.comment.id)).toEqual([
      "elsewhere",
    ]);
    expect(markGlyphs(marksForRow(marks, "V", "round:L:0"))).toBe("");
  });
});

describe("anchorFor", () => {
  it("names a round by its thread and model, and a tool by its name", () => {
    const rows = outlineRows(agentLoopTrace(), { machinery: false, admin: false });
    const round = rows.find((row) => row.kind === "round");
    const tool = rows.find((row) => row.kind === "tool");
    expect(round).toBeDefined();
    expect(tool).toBeDefined();
    const roundAnchor = anchorFor(round!);
    expect(typeof roundAnchor.name).toBe("string");
    expect(roundAnchor.at).toMatch(/^\d{4}-/);
    expect(anchorFor(tool!).name).toBe(tool!.kind === "tool" ? tool!.name : "");
  });
});
