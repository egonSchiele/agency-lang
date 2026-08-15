import { describe, expect, it } from "vitest";

import { effectiveAnswers, itemStatus, latestNote, score } from "./annotations.js";
import type { AnnotationRow, ChecklistQuestion, ChecklistRevision } from "./types.js";

const OUTPUT_ID = `out_${"a".repeat(64)}`;
const OTHER_OUTPUT_ID = `out_${"b".repeat(64)}`;
const HASH = `sha256:${"0".repeat(64)}`;

const key = {
  outputId: OUTPUT_ID,
  checklistId: "cl_news",
  annotator: { kind: "human" as const, id: "adit" },
};

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

function annotation(over: Partial<AnnotationRow> = {}): AnnotationRow {
  return {
    schemaVersion: 1,
    annotationId: "ann_one",
    outputId: OUTPUT_ID,
    annotator: { kind: "human", id: "adit" },
    checklistId: "cl_news",
    checklistVersion: 1,
    checklistHash: HASH,
    createdAt: "2026-08-03T00:00:00.000Z",
    activeMs: 0,
    coveredQuestionIds: [],
    answers: {},
    note: "",
    ...over,
  };
}

describe("effectiveAnswers", () => {
  it("takes the later row for a question both rows covered", () => {
    const rows = [
      annotation({ annotationId: "ann_1", coveredQuestionIds: ["q_a"], answers: { q_a: true } }),
      annotation({ annotationId: "ann_2", coveredQuestionIds: ["q_a"], answers: { q_a: false } }),
    ];
    expect(effectiveAnswers(rows, key).q_a).toBe(false);
  });

  it("uses append order, not createdAt, when a later row carries an earlier timestamp", () => {
    // Clocks are not monotonic across a machine sleeping or an NTP step. The
    // log's own order is what actually happened.
    const rows = [
      annotation({
        annotationId: "ann_1",
        createdAt: "2026-08-03T10:00:00.000Z",
        coveredQuestionIds: ["q_a"],
        answers: { q_a: true },
      }),
      annotation({
        annotationId: "ann_2",
        createdAt: "2026-08-03T09:00:00.000Z",
        coveredQuestionIds: ["q_a"],
        answers: { q_a: false },
      }),
    ];
    expect(effectiveAnswers(rows, key).q_a).toBe(false);
  });

  it("resolves tied timestamps by append order", () => {
    const rows = [
      annotation({ annotationId: "ann_1", coveredQuestionIds: ["q_a"], answers: { q_a: true } }),
      annotation({ annotationId: "ann_2", coveredQuestionIds: ["q_a"], answers: { q_a: false } }),
    ];
    expect(effectiveAnswers(rows, key).q_a).toBe(false);
  });

  it("KEEPS an answer a later row did not cover, which is the soft-delete guarantee", () => {
    const rows = [
      annotation({
        annotationId: "ann_1",
        coveredQuestionIds: ["q_a", "q_sourced"],
        answers: { q_a: true, q_sourced: true },
      }),
      annotation({ annotationId: "ann_2", coveredQuestionIds: ["q_a"], answers: { q_a: true } }),
    ];
    expect(effectiveAnswers(rows, key).q_sourced).toBe(true);
  });

  it("ignores a different output", () => {
    const rows = [
      annotation({
        outputId: OTHER_OUTPUT_ID,
        coveredQuestionIds: ["q_a"],
        answers: { q_a: false },
      }),
    ];
    expect(effectiveAnswers(rows, key).q_a).toBeUndefined();
  });

  it("ignores a different annotator id", () => {
    const rows = [
      annotation({
        annotator: { kind: "human", id: "someone-else" },
        coveredQuestionIds: ["q_a"],
        answers: { q_a: false },
      }),
    ];
    expect(effectiveAnswers(rows, key).q_a).toBeUndefined();
  });

  it("ignores a machine judge sharing the human's id", () => {
    const rows = [
      annotation({
        annotator: { kind: "llm", id: "adit" },
        coveredQuestionIds: ["q_a"],
        answers: { q_a: false },
      }),
    ];
    expect(effectiveAnswers(rows, key).q_a).toBeUndefined();
  });

  it("ignores a different checklist lineage", () => {
    const rows = [
      annotation({ checklistId: "cl_other", coveredQuestionIds: ["q_a"], answers: { q_a: false } }),
    ];
    expect(effectiveAnswers(rows, key).q_a).toBeUndefined();
  });
});

describe("itemStatus", () => {
  it("is untouched with no annotations", () => {
    expect(itemStatus({ answers: {}, revision: revision([question("q_a")]) })).toBe("untouched");
  });

  it("is reviewed when every live question has an answer", () => {
    const answers = effectiveAnswers(
      [annotation({ coveredQuestionIds: ["q_a"], answers: { q_a: true } })],
      key,
    );
    expect(itemStatus({ answers, revision: revision([question("q_a")]) })).toBe("reviewed");
  });

  it("is REVIEWED, not untouched, when every question was answered no", () => {
    // "untouched" means nobody judged this. A `false` is a judgement, and the
    // fold records it explicitly rather than omitting it, so failing every
    // question is a reviewed item with score 0.
    const answers = effectiveAnswers(
      [
        annotation({
          coveredQuestionIds: ["q_a", "q_b"],
          answers: { q_a: false, q_b: false },
        }),
      ],
      key,
    );
    const both = revision([question("q_a"), question("q_b")]);
    expect(itemStatus({ answers, revision: both })).toBe("reviewed");
    expect(score({ answers, revision: both })).toBe(0);
  });

  it("is stale when a live question has no answer", () => {
    const answers = effectiveAnswers(
      [annotation({ coveredQuestionIds: ["q_a"], answers: { q_a: true } })],
      key,
    );
    expect(itemStatus({ answers, revision: revision([question("q_a"), question("q_b")]) })).toBe(
      "stale",
    );
  });

  it("is not stale when the only unanswered question is deleted", () => {
    const answers = effectiveAnswers(
      [annotation({ coveredQuestionIds: ["q_a"], answers: { q_a: true } })],
      key,
    );
    const withDeleted = revision([question("q_a"), question("q_b", { deleted: true })]);
    expect(itemStatus({ answers, revision: withDeleted })).toBe("reviewed");
  });

  it("restores reviewed status when a deleted question with a prior answer comes back", () => {
    const answers = effectiveAnswers(
      [
        annotation({
          coveredQuestionIds: ["q_a", "q_b"],
          answers: { q_a: true, q_b: false },
        }),
      ],
      key,
    );
    expect(itemStatus({ answers, revision: revision([question("q_a"), question("q_b")]) })).toBe(
      "reviewed",
    );
  });
});

describe("score", () => {
  it("is null for a stale item rather than a confident low number", () => {
    const answers = effectiveAnswers(
      [annotation({ coveredQuestionIds: ["q_a"], answers: { q_a: true } })],
      key,
    );
    expect(score({ answers, revision: revision([question("q_a"), question("q_b")]) })).toBeNull();
  });

  it("is null when there are no live questions", () => {
    expect(
      score({ answers: {}, revision: revision([question("q_a", { deleted: true })]) }),
    ).toBeNull();
  });

  it("weights questions", () => {
    const answers = effectiveAnswers(
      [
        annotation({
          coveredQuestionIds: ["q_a", "q_b"],
          answers: { q_a: true, q_b: false },
        }),
      ],
      key,
    );
    const weighted = revision([question("q_a", { weight: 3 }), question("q_b", { weight: 1 })]);
    expect(score({ answers, revision: weighted })).toBe(0.75);
  });

  it("excludes a deleted question from both sides of the fraction", () => {
    const answers = effectiveAnswers(
      [
        annotation({
          coveredQuestionIds: ["q_a", "q_b"],
          answers: { q_a: true, q_b: false },
        }),
      ],
      key,
    );
    const withDeleted = revision([question("q_a"), question("q_b", { deleted: true })]);
    expect(score({ answers, revision: withDeleted })).toBe(1);
  });

  it("is 0 when every live question is unticked but all were judged", () => {
    const answers = effectiveAnswers(
      [annotation({ coveredQuestionIds: ["q_a"], answers: { q_a: false } })],
      key,
    );
    expect(score({ answers, revision: revision([question("q_a")]) })).toBe(0);
  });
});

describe("latestNote", () => {
  it("returns the note from the last matching row in append order", () => {
    const rows = [
      annotation({ annotationId: "ann_1", note: "first" }),
      annotation({ annotationId: "ann_2", note: "second" }),
    ];
    expect(latestNote(rows, key)).toBe("second");
  });

  it("returns an empty string when nothing matches", () => {
    expect(latestNote([annotation({ outputId: OTHER_OUTPUT_ID, note: "x" })], key)).toBe("");
  });

  it("does not fall back to another annotator's note", () => {
    const rows = [annotation({ annotator: { kind: "human", id: "other" }, note: "theirs" })];
    expect(latestNote(rows, key)).toBe("");
  });
});
