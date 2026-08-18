import * as fs from "fs";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeDefinition,
  prepareRevision,
  publishPendingRevision,
} from "@/eval/label/checklist.js";
import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";

import { completeAnnotation } from "./annotations.js";
import { appendDurably } from "./durableWrite.js";
import { humanFeedbackFor } from "./humanFeedback.js";
import { recordNote } from "./mutations.js";
import { readRunDirectory } from "./runDir.js";

let dir: string;

beforeEach(() => {
  dir = writeRunDirectory([
    { traceId: "t1", test: { id: "a", input: "poem" }, output: "roses" },
    { traceId: "t2", test: { id: "b", input: "haiku" }, output: "leaves" },
  ]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Publish a two-question checklist into the directory and return its ids. */
function publishChecklist(): {
  checklistId: string;
  version: number;
  hash: string;
  qIds: string[];
} {
  const definition = normalizeDefinition({
    name: "quality",
    questions: [{ text: "Is it accurate?" }, { text: "Is it on time?" }],
  });
  const prepared = prepareRevision({ definition, current: undefined });
  if (prepared.kind !== "publish") throw new Error(prepared.kind);
  const definitionPath = path.join(dir, "quality.json");
  fs.writeFileSync(definitionPath, JSON.stringify(definition));
  const { revision } = publishPendingRevision({ dir, pending: prepared.pending, definitionPath });
  return {
    checklistId: revision.checklistId,
    version: revision.version,
    hash: revision.hash,
    qIds: revision.questions.map((question) => question.id),
  };
}

function snapshot() {
  return readRunDirectory(dir, { reportWarning: () => {} });
}

describe("humanFeedbackFor", () => {
  it("is empty for a trace nobody annotated", () => {
    expect(humanFeedbackFor(snapshot(), "t1")).toEqual({ notes: [], checked: [], unchecked: [] });
  });

  it("collects notes in append order", () => {
    recordNote({ dir, traceId: "t1", annotator: { kind: "human", id: "adit" }, text: "too slow" });
    recordNote({ dir, traceId: "t1", annotator: { kind: "human", id: "sam" }, text: "wrong tone" });
    expect(humanFeedbackFor(snapshot(), "t1").notes).toEqual(["too slow", "wrong tone"]);
    expect(humanFeedbackFor(snapshot(), "t2").notes).toEqual([]);
  });

  it("names the checklist questions answered yes and no, by their text", () => {
    const checklist = publishChecklist();
    const row = completeAnnotation(
      {
        traceId: "t1",
        annotator: { kind: "human", id: "adit" },
        kind: "checklist",
        checklist: checklist.checklistId,
        version: checklist.version,
        hash: checklist.hash,
        answers: { [checklist.qIds[0]]: true, [checklist.qIds[1]]: false },
        note: "late by a day",
      },
      "2026-08-18T00:00:00.000Z",
    );
    appendDurably(path.join(dir, "annotations.jsonl"), JSON.stringify(row) + "\n");
    expect(humanFeedbackFor(snapshot(), "t1")).toEqual({
      notes: ["late by a day"],
      checked: ["Is it accurate?"],
      unchecked: ["Is it on time?"],
    });
  });

  it("yields no question texts when the checklist lineage is not in this directory", () => {
    const row = completeAnnotation(
      {
        traceId: "t1",
        annotator: { kind: "human", id: "adit" },
        kind: "checklist",
        checklist: "cl_elsewhere",
        version: 1,
        hash: `sha256:${"0".repeat(64)}`,
        answers: { q_x: false },
        note: "",
      },
      "2026-08-18T00:00:00.000Z",
    );
    appendDurably(path.join(dir, "annotations.jsonl"), JSON.stringify(row) + "\n");
    expect(humanFeedbackFor(snapshot(), "t1").unchecked).toEqual([]);
  });
});
