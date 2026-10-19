import { describe, expect, it } from "vitest";

import type { Comment } from "../runDirectory/comments.js";
import { expandRow, unresolvedCommentText } from "./rowText.js";
import { outlineRows } from "./story.js";
import { agentLoopTrace } from "./storyFixture.js";

describe("expandRow", () => {
  const trace = agentLoopTrace();
  const rows = outlineRows(trace, { machinery: false, admin: false });

  it("expands a round with its address, a header line, and the payload text", () => {
    const round = rows.find((row) => row.kind === "round")!;
    const expanded = expandRow(trace, round.id)!;
    expect(expanded.address).toBe(`${trace.traceId}/${round.id}`);
    expect(expanded.header).toMatch(/^Thread · .* · LLM call \d+ of \d+ · /);
    expect(expanded.text.split("\n")[0]).toBe(expanded.address);
    expect(expanded.text).toContain(`  ${expanded.header}`);
    expect(expanded.json.events.length).toBeGreaterThan(0);
    expect(expanded.json.kind).toBe("round");
  });

  it("expands a tool with its name and status, and lists comments after the payload", () => {
    const tool = rows.find((row) => row.kind === "tool")!;
    const comment: Comment = {
      v: 1,
      id: "c1",
      traceId: trace.traceId,
      rowId: tool.id,
      anchor: {},
      author: { kind: "human", id: "adit" },
      text: "why this tool?",
      created: "2026-10-19T14:30:02.000Z",
    };
    const expanded = expandRow(trace, tool.id, [{ comment, replies: [] }])!;
    expect(expanded.header).toMatch(/^Tool · /);
    expect(expanded.text).toContain("COMMENTS · 1");
    expect(expanded.text).toContain("why this tool?");
    expect(expanded.json.comments).toHaveLength(1);
  });

  it("is undefined for an unknown row", () => {
    expect(expandRow(trace, "nope")).toBeUndefined();
  });
});

describe("unresolvedCommentText", () => {
  it("lists a thread by its anchor, replies included, and says it was re-anchored", () => {
    const comment: Comment = {
      v: 1,
      id: "c1",
      traceId: "T",
      rowId: "round:gone:3",
      anchor: { thread: "reviewer", name: "gpt-5", at: "2026-10-19T14:02:11.408Z" },
      author: { kind: "human", id: "adit" },
      text: "why?",
      created: "2026-10-19T14:30:02.000Z",
    };
    const reply: Comment = {
      ...comment,
      id: "c2",
      author: { kind: "agent", id: "claude" },
      text: "it retries",
      replyTo: "c1",
    };
    const text = unresolvedCommentText({ comment, replies: [reply] });
    expect(text).toContain("T/round:gone:3 (re-anchored");
    expect(text).toContain("reviewer · gpt-5 · 2026-10-19T14:02:11.408Z");
    expect(text).toContain("c1 adit: why?");
    expect(text).toContain("c2 claude: it retries");
  });
});
