import { describe, expect, it } from "vitest";

import { itemStatus, score } from "./judgement.js";
import type { ChecklistQuestion, ChecklistRevision } from "./types.js";

const HASH = `sha256:${"0".repeat(64)}`;

function question(id: string, over: Partial<ChecklistQuestion> = {}): ChecklistQuestion {
  return { id, text: id, weight: 1, deleted: false, ...over };
}

function revision(questions: ChecklistQuestion[]): ChecklistRevision {
  return {
    schemaVersion: 1,
    checklistId: "cl_news",
    name: "news",
    version: 1,
    parentVersion: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    hash: HASH,
    questions,
  };
}

describe("itemStatus", () => {
  it("is untouched with no answers", () => {
    expect(itemStatus({ answers: {}, revision: revision([question("q_a")]) })).toBe("untouched");
  });

  it("is reviewed when every live question has an answer", () => {
    expect(itemStatus({ answers: { q_a: true }, revision: revision([question("q_a")]) })).toBe(
      "reviewed",
    );
  });

  it("is REVIEWED, not untouched, when every question was answered no", () => {
    // "untouched" means nobody judged this. A `false` is a judgement, so
    // failing every question is a reviewed item with score 0.
    const both = revision([question("q_a"), question("q_b")]);
    const answers = { q_a: false, q_b: false };
    expect(itemStatus({ answers, revision: both })).toBe("reviewed");
    expect(score({ answers, revision: both })).toBe(0);
  });

  it("is stale when a live question has no answer", () => {
    expect(
      itemStatus({
        answers: { q_a: true },
        revision: revision([question("q_a"), question("q_b")]),
      }),
    ).toBe("stale");
  });

  it("is not stale when the only unanswered question is deleted", () => {
    const withDeleted = revision([question("q_a"), question("q_b", { deleted: true })]);
    expect(itemStatus({ answers: { q_a: true }, revision: withDeleted })).toBe("reviewed");
  });

  it("restores reviewed status when a deleted question with a prior answer comes back", () => {
    // The fold keeps the answer a later sign-off did not cover; once the
    // question is live again the item is complete without relabeling.
    expect(
      itemStatus({
        answers: { q_a: true, q_b: false },
        revision: revision([question("q_a"), question("q_b")]),
      }),
    ).toBe("reviewed");
  });
});

describe("score", () => {
  it("is null for a stale item rather than a confident low number", () => {
    expect(
      score({ answers: { q_a: true }, revision: revision([question("q_a"), question("q_b")]) }),
    ).toBeNull();
  });

  it("is null when there are no live questions", () => {
    expect(
      score({ answers: {}, revision: revision([question("q_a", { deleted: true })]) }),
    ).toBeNull();
  });

  it("weights questions", () => {
    const weighted = revision([question("q_a", { weight: 3 }), question("q_b", { weight: 1 })]);
    expect(score({ answers: { q_a: true, q_b: false }, revision: weighted })).toBe(0.75);
  });

  it("excludes a deleted question from both sides of the fraction", () => {
    const withDeleted = revision([question("q_a"), question("q_b", { deleted: true })]);
    expect(score({ answers: { q_a: true, q_b: false }, revision: withDeleted })).toBe(1);
  });

  it("is 0 when every live question is unticked but all were judged", () => {
    expect(score({ answers: { q_a: false }, revision: revision([question("q_a")]) })).toBe(0);
  });
});
