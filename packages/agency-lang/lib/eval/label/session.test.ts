import { describe, expect, it } from "vitest";

import {
  currentQuestion,
  initSession,
  reduceSession,
  sessionSnapshot,
  signOffPayload,
  type SessionState,
} from "./session.js";
import type { AnnotationRow, ChecklistRevision, CorpusRow } from "./types.js";

const HASH = `sha256:${"0".repeat(64)}`;
const OUT_A = `out_${"a".repeat(64)}`;
const OUT_B = `out_${"b".repeat(64)}`;
const annotator = { kind: "human" as const, id: "adit" };

const revision: ChecklistRevision = {
  schemaVersion: 1,
  checklistId: "cl_news",
  name: "news",
  version: 1,
  parentVersion: null,
  createdAt: "2026-08-03T00:00:00.000Z",
  hash: HASH,
  questions: [
    { id: "q_accurate", text: "Accurate?", weight: 1, deleted: false },
    { id: "q_today", text: "Today?", weight: 1, deleted: false },
  ],
};

function corpusRow(outputId: string, output: string): CorpusRow {
  return {
    schemaVersion: 2,
    outputId,
    capturedAt: "2026-08-03T00:00:00.000Z",
    fields: { task: "a task", output },
  };
}

const corpus = [corpusRow(OUT_A, "first output"), corpusRow(OUT_B, "second output")];

function start(annotations: AnnotationRow[] = []): SessionState {
  return initSession({ corpus, revision, annotations, annotator });
}

function annotation(over: Partial<AnnotationRow> = {}): AnnotationRow {
  return {
    schemaVersion: 1,
    annotationId: "ann_one",
    outputId: OUT_A,
    annotator,
    checklistId: "cl_news",
    checklistVersion: 1,
    checklistHash: HASH,
    createdAt: "2026-08-03T00:00:00.000Z",
    activeMs: 0,
    coveredQuestionIds: ["q_accurate", "q_today"],
    answers: { q_accurate: true, q_today: false },
    note: "",
    ...over,
  };
}

describe("navigation", () => {
  it("moves between items and resets the question cursor", () => {
    let state = start();
    state = reduceSession(state, { kind: "nextQuestion" });
    state = reduceSession(state, { kind: "nextItem" });
    expect(state.itemIndex).toBe(1);
    expect(state.questionIndex).toBe(0);
  });

  it("clamps at both ends rather than wrapping", () => {
    let state = start();
    state = reduceSession(state, { kind: "previousItem" });
    expect(state.itemIndex).toBe(0);
    state = reduceSession(state, { kind: "nextItem" });
    state = reduceSession(state, { kind: "nextItem" });
    expect(state.itemIndex).toBe(1);
  });

  it("focuses a specific item by its output id", () => {
    const state = reduceSession(start(), { kind: "focusItem", outputId: OUT_B });
    expect(state.itemIndex).toBe(1);
  });

  it("leaves the state unchanged when focusing an unknown output id", () => {
    const state = start();
    expect(reduceSession(state, { kind: "focusItem", outputId: "out_nope" })).toBe(state);
  });

  it("preserves answers when focusing another item", () => {
    let state = reduceSession(start(), { kind: "toggleAnswer" });
    const answersBefore = state.answersByOutputId[OUT_A];
    state = reduceSession(state, { kind: "focusItem", outputId: OUT_B });
    expect(state.itemIndex).toBe(1);
    expect(state.answersByOutputId[OUT_A]).toEqual(answersBefore);
  });
});

describe("toggling", () => {
  it("ticks the focused question and advances", () => {
    const state = reduceSession(start(), { kind: "toggleAnswer" });
    expect(state.answersByOutputId[OUT_A].q_accurate).toBe(true);
    expect(currentQuestion(state)?.id).toBe("q_today");
  });

  it("unticks on a second toggle", () => {
    let state = reduceSession(start(), { kind: "toggleAnswer" });
    state = reduceSession(state, { kind: "previousQuestion" });
    state = reduceSession(state, { kind: "toggleAnswer" });
    expect(state.answersByOutputId[OUT_A].q_accurate).toBe(false);
  });

  it("refuses to tick a deleted question", () => {
    let state = start();
    state = reduceSession(state, { kind: "toggleQuestionDeleted" });
    state = reduceSession(state, { kind: "toggleAnswer" });
    expect(state.answersByOutputId[OUT_A]?.q_accurate).toBeUndefined();
  });
});

describe("staged question edits", () => {
  it("stages an added question without touching the published revision", () => {
    const question = { id: "q_new", text: "Sourced?", weight: 1, deleted: false };
    const state = reduceSession(start(), { kind: "questionAdded", question });
    expect(state.stagedQuestions).toHaveLength(3);
    expect(state.revision.questions).toHaveLength(2);
  });

  it("stages a soft delete rather than dropping the question", () => {
    const state = reduceSession(start(), { kind: "toggleQuestionDeleted" });
    expect(state.stagedQuestions).toHaveLength(2);
    expect(state.stagedQuestions?.[0].deleted).toBe(true);
  });

  it("clears staged edits when a revision is adopted", () => {
    let state = reduceSession(start(), { kind: "toggleQuestionDeleted" });
    const published: ChecklistRevision = {
      ...revision,
      version: 2,
      parentVersion: 1,
      questions: [{ ...revision.questions[0], deleted: true }, revision.questions[1]],
    };
    state = reduceSession(state, { kind: "revisionAdopted", revision: published });
    expect(state.stagedQuestions).toBeNull();
    expect(state.revision.version).toBe(2);
  });
});

describe("editor", () => {
  it("accumulates and backspaces draft text", () => {
    let state = reduceSession(start(), { kind: "beginQuestion" });
    state = reduceSession(state, { kind: "appendEditorText", text: "ab" });
    state = reduceSession(state, { kind: "backspaceEditor" });
    expect(state.editor).toEqual({ kind: "question", draft: "a" });
  });

  it("cancels back to no editor", () => {
    let state = reduceSession(start(), { kind: "beginNote" });
    state = reduceSession(state, { kind: "cancelEditor" });
    expect(state.editor).toEqual({ kind: "none" });
  });

  it("seeds the note editor with the existing note", () => {
    let state = reduceSession(start(), { kind: "noteSaved", outputId: OUT_A, note: "prior" });
    state = reduceSession(state, { kind: "beginNote" });
    expect(state.editor).toEqual({ kind: "note", draft: "prior" });
  });
});

describe("signOffPayload", () => {
  it("covers every live question with an explicit boolean", () => {
    const state = reduceSession(start(), { kind: "toggleAnswer" });
    expect(signOffPayload(state)).toMatchObject({
      outputId: OUT_A,
      coveredQuestionIds: ["q_accurate", "q_today"],
      answers: { q_accurate: true, q_today: false },
    });
  });

  it("excludes a staged-deleted question from coverage", () => {
    const state = reduceSession(start(), { kind: "toggleQuestionDeleted" });
    expect(signOffPayload(state)?.coveredQuestionIds).toEqual(["q_today"]);
  });
});

describe("annotationCommitted", () => {
  it("marks reviewed and advances", () => {
    const state = reduceSession(start(), { kind: "annotationCommitted", row: annotation() });
    expect(state.reviewedByOutputId[OUT_A]).toEqual(["q_accurate", "q_today"]);
    expect(state.itemIndex).toBe(1);
  });

  it("adopts the recorded answers, not unsaved screen state", () => {
    let state = reduceSession(start(), { kind: "toggleAnswer" });
    state = reduceSession(state, {
      kind: "annotationCommitted",
      row: annotation({ answers: { q_accurate: false, q_today: true } }),
    });
    expect(state.answersByOutputId[OUT_A]).toMatchObject({ q_accurate: false, q_today: true });
  });
});

describe("resume from completed annotations", () => {
  it("seeds answers and counts the item as reviewed", () => {
    const state = start([annotation()]);
    expect(state.answersByOutputId[OUT_A].q_accurate).toBe(true);
    expect(sessionSnapshot(state).progress.reviewed).toBe(1);
  });

  it("seeds the note", () => {
    const state = start([annotation({ note: "missed the big one" })]);
    expect(sessionSnapshot(state).note).toBe("missed the big one");
  });

  it("shows an item as stale once a question is staged that it never covered", () => {
    let state = start([annotation()]);
    state = reduceSession(state, {
      kind: "questionAdded",
      question: { id: "q_new", text: "Sourced?", weight: 1, deleted: false },
    });
    expect(sessionSnapshot(state).statuses[OUT_A]).toBe("stale");
  });

  it("scores a stale item as null rather than a low number", () => {
    let state = start([annotation()]);
    state = reduceSession(state, {
      kind: "questionAdded",
      question: { id: "q_new", text: "Sourced?", weight: 1, deleted: false },
    });
    expect(sessionSnapshot(state).scores[OUT_A]).toBeNull();
  });

  it("scores a fully reviewed item from its live questions", () => {
    const state = start([annotation()]);
    expect(sessionSnapshot(state).scores[OUT_A]).toBe(0.5);
  });
});

describe("sessionSnapshot", () => {
  it("carries everything a renderer needs without exposing internals", () => {
    const snapshot = sessionSnapshot(start());
    expect(Object.keys(snapshot).sort()).toEqual([
      "answers",
      "canSignOff",
      "currentItem",
      "currentQuestion",
      "editor",
      "hasStagedQuestions",
      "itemIndex",
      "items",
      "note",
      "progress",
      "questionIndex",
      "questions",
      "scores",
      "statuses",
    ]);
  });

  it("reports an empty corpus as unable to sign off", () => {
    const empty = initSession({ corpus: [], revision, annotations: [], annotator });
    expect(sessionSnapshot(empty).canSignOff).toBe(false);
  });
});
