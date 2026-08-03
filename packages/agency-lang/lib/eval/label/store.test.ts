import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeDefinition, prepareRevision, publishPendingRevision } from "./checklist.js";
import { acquireStoreLock } from "./lock.js";
import { openStore, StoreValidationError } from "./store.js";
import type { AnnotationRow, ChecklistRevision, CorpusRow } from "./types.js";

let storeDir: string;
let definitionPath: string;
const warnings: string[] = [];

const OUTPUT_ID = `out_${"a".repeat(64)}`;
const HASH_ZERO = `sha256:${"0".repeat(64)}`;

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "label-store-"));
  definitionPath = path.join(storeDir, "news.json");
  warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(storeDir, { recursive: true, force: true });
});

function open() {
  const lock = acquireStoreLock({ storeDir, reportWarning: (m) => warnings.push(m) });
  return openStore({ storeDir, lock, reportWarning: (m) => warnings.push(m) });
}

function corpusRow(over: Partial<CorpusRow> = {}): CorpusRow {
  return {
    schemaVersion: 1,
    outputId: OUTPUT_ID,
    contentHash: HASH_ZERO,
    capturedAt: "2026-08-03T00:00:00.000Z",
    execution: { traceId: "t", inputId: "a", finalOutputIndex: 0 },
    input: { inputId: "a", task: "t" },
    value: "v",
    text: "v",
    provenance: { runStartedAtMs: null, agent: null, models: [] },
    ...over,
  };
}

function appendRaw(file: string, row: unknown): void {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.appendFileSync(path.join(storeDir, file), `${JSON.stringify(row)}\n`);
}

/** Publish a one-question checklist and return its revision. */
function publishChecklist(): ChecklistRevision {
  const normalized = normalizeDefinition({ name: "news", questions: [{ text: "Accurate?" }] });
  const prepared = prepareRevision({ definition: normalized, current: undefined });
  if (prepared.kind !== "publish") throw new Error("expected publish");
  return publishPendingRevision({ storeDir, pending: prepared.pending, definitionPath }).revision;
}

function annotationRow(revision: ChecklistRevision, over: Partial<AnnotationRow> = {}): AnnotationRow {
  const questionId = revision.questions[0].id;
  return {
    schemaVersion: 1,
    annotationId: "ann_one",
    outputId: OUTPUT_ID,
    annotator: { kind: "human", id: "adit" },
    checklistId: revision.checklistId,
    checklistVersion: revision.version,
    checklistHash: revision.hash,
    createdAt: "2026-08-03T00:00:00.000Z",
    activeMs: 0,
    coveredQuestionIds: [questionId],
    answers: { [questionId]: true },
    note: "",
    ...over,
  };
}

describe("openStore", () => {
  it("opens an empty store and writes a manifest", () => {
    const store = open();
    expect(store.annotationSnapshot()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(storeDir, "manifest.json"), "utf8")))
      .toEqual({ schemaVersion: 1 });
    store.close();
  });

  it("refuses a manifest from a newer schema rather than risking the dataset", () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "manifest.json"), JSON.stringify({ schemaVersion: 2 }));
    expect(() => open()).toThrow(StoreValidationError);
  });

  it("refuses a manifest with unknown keys", () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, extra: true }));
    expect(() => open()).toThrow(StoreValidationError);
  });

  it("releases the lock on close", () => {
    open().close();
    expect(fs.existsSync(path.join(storeDir, ".lock"))).toBe(false);
  });

  it("rejects a duplicate output id in the corpus", () => {
    appendRaw("outputs.jsonl", corpusRow());
    appendRaw("outputs.jsonl", corpusRow({ text: "different" }));
    expect(() => open()).toThrow(/different content/i);
  });

  it("rejects a corpus row that fails its schema", () => {
    appendRaw("outputs.jsonl", { ...corpusRow(), outputId: "nope" });
    expect(() => open()).toThrow(/line 1/);
  });

  it("rejects a JSONL tail with no terminating newline", () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "outputs.jsonl"), JSON.stringify(corpusRow()));
    expect(() => open()).toThrow(/newline/i);
  });
});

describe("store invariants across files", () => {
  it("rejects an annotation whose output is not in the corpus", () => {
    const revision = publishChecklist();
    appendRaw("labels.jsonl", annotationRow(revision));
    expect(() => open()).toThrow(/not in the corpus/i);
  });

  it("rejects an annotation referring to a missing checklist revision", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    appendRaw("labels.jsonl", annotationRow(revision, { checklistVersion: 7 }));
    expect(() => open()).toThrow(/missing|not found/i);
  });

  it("rejects an annotation whose recorded checklist hash does not match", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    appendRaw("labels.jsonl", annotationRow(revision, { checklistHash: HASH_ZERO }));
    expect(() => open()).toThrow(/hash/i);
  });

  it("rejects an annotation covering a question the revision does not define", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    appendRaw("labels.jsonl", annotationRow(revision, {
      coveredQuestionIds: ["q_unknown"], answers: { q_unknown: true },
    }));
    expect(() => open()).toThrow(/does not define/i);
  });

  it("rejects a covered question with no recorded answer", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    appendRaw("labels.jsonl", annotationRow(revision, { answers: {} }));
    expect(() => open()).toThrow(/records no answer/i);
  });

  it("rejects an answer for a question that was not covered", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    appendRaw("labels.jsonl", annotationRow(revision, {
      coveredQuestionIds: [], answers: { [revision.questions[0].id]: true },
    }));
    expect(() => open()).toThrow(/without covering/i);
  });

  it("rejects a current pointer that lags the newest revision", () => {
    const revision = publishChecklist();
    fs.writeFileSync(
      path.join(storeDir, "checklists", revision.checklistId, "2.json"),
      JSON.stringify({ ...revision, version: 2, parentVersion: 1 }),
    );
    expect(() => open()).toThrow(/current points at/i);
  });

  it("rejects a broken parent chain", () => {
    const revision = publishChecklist();
    const dir = path.join(storeDir, "checklists", revision.checklistId);
    fs.writeFileSync(path.join(dir, "1.json"),
      JSON.stringify({ ...revision, parentVersion: 5 }));
    expect(() => open()).toThrow(/records parent/i);
  });
});

describe("appendAnnotation", () => {
  it("appends a grounded annotation", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    const store = open();
    expect(store.appendAnnotation(annotationRow(revision))).toBe("appended");
    expect(store.annotationSnapshot()).toHaveLength(1);
    store.close();
  });

  it("replays an identical annotation instead of duplicating it", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    const store = open();
    store.appendAnnotation(annotationRow(revision));
    expect(store.appendAnnotation(annotationRow(revision))).toBe("replayed");
    expect(store.annotationSnapshot()).toHaveLength(1);
    store.close();
  });

  it("refuses an annotation whose output was never captured", () => {
    const revision = publishChecklist();
    const store = open();
    expect(() => store.appendAnnotation(annotationRow(revision))).toThrow(/not in the corpus/i);
    store.close();
  });

  it("refuses a second annotation reusing an id with different content", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    const store = open();
    store.appendAnnotation(annotationRow(revision));
    expect(() => store.appendAnnotation(annotationRow(revision, { note: "changed" })))
      .toThrow(/different content/i);
    store.close();
  });

  it("refuses every operation after close", () => {
    const store = open();
    store.close();
    expect(() => store.annotationSnapshot()).toThrow(/closed/i);
  });
});
