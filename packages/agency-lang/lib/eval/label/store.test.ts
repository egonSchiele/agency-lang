import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeDefinition, prepareRevision, publishPendingRevision } from "./checklist.js";
import { checklistHashOf, makeOccurrenceId, makeOutputId } from "./ids.js";
import type { LoadedBatch } from "./load/types.js";
import { acquireStoreLock } from "./lock.js";
import { openStore, StoreValidationError, StoreVersionError } from "./store.js";
import type { AnnotationRow, ChecklistRevision, CorpusRow } from "./types.js";

let storeDir: string;
let definitionPath: string;
const warnings: string[] = [];

const DEFAULT_FIELDS = { task: "t", output: "v" };
/** The id the store will derive for DEFAULT_FIELDS. Computed rather than
 *  written down, because a hand-written id is exactly what open-time validation
 *  now rejects. */
const OUTPUT_ID = makeOutputId(DEFAULT_FIELDS);
/** A well-formed id that is NOT the hash of any record here. */
const UNGROUNDED_OUTPUT_ID = `out_${"a".repeat(64)}`;
const SESSION_ID = `session_${"c".repeat(64)}`;
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
  const fields = over.fields ?? DEFAULT_FIELDS;
  return {
    schemaVersion: 2,
    // Derived, so a row built here is one the store would accept: the open-time
    // check recomputes this and refuses anything that does not match.
    outputId: makeOutputId(fields),
    capturedAt: "2026-08-03T00:00:00.000Z",
    fields,
    ...over,
  };
}

/** One loaded candidate, as a loader would hand it to the store. */
function batchOf(fields = DEFAULT_FIELDS, source = "agent-v1"): LoadedBatch {
  return {
    occurrences: [{
      fields,
      source,
      origin: { kind: "file", itemKey: "a.txt" },
    }],
    skips: [],
    discoveredFieldNames: Object.keys(fields),
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


/** Write a revision file with a correctly recomputed hash, so tests exercise
 *  the invariant under test rather than tripping the hash check. */
function writeRevisionFile(revision: ChecklistRevision): void {
  const sealed = {
    ...revision,
    hash: checklistHashOf({
      checklistId: revision.checklistId,
      version: revision.version,
      questions: revision.questions,
    }),
  };
  const dir = path.join(storeDir, "checklists", revision.checklistId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${revision.version}.json`), JSON.stringify(sealed));
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
    expect(store.readSession(SESSION_ID).annotations).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(storeDir, "manifest.json"), "utf8")))
      .toEqual({ schemaVersion: 2, fieldOrder: [] });
    store.close();
  });

  it("refuses a manifest from a newer schema rather than risking the dataset", () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "manifest.json"), JSON.stringify({ schemaVersion: 3 }));
    expect(() => open()).toThrow(StoreVersionError);
  });

  it("refuses a version 1 store and names the migrate command", () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "manifest.json"), JSON.stringify({ schemaVersion: 1 }));
    expect(() => open()).toThrow(/agency eval label-migrate/);
  });

  it("checks the manifest BEFORE parsing any log", () => {
    // A version 1 corpus line would produce a confusing deep validation error
    // if the version gate ran second.
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "manifest.json"), JSON.stringify({ schemaVersion: 1 }));
    fs.writeFileSync(path.join(storeDir, "outputs.jsonl"), '{"schemaVersion":1,"nonsense":true}\n');
    expect(() => open()).toThrow(/agency eval label-migrate/);
  });

  it("refuses a manifest with unknown keys", () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 2, fieldOrder: [], extra: true }));
    expect(() => open()).toThrow(StoreValidationError);
  });

  it("refuses a corpus row whose id is not the hash of its own fields", () => {
    appendRaw("outputs.jsonl", { ...corpusRow(), outputId: UNGROUNDED_OUTPUT_ID });
    expect(() => open()).toThrow(/does not match the hash of its own fields/);
  });

  it("refuses an occurrence referencing a record nobody stored", () => {
    appendRaw("occurrences.jsonl", {
      schemaVersion: 1,
      occurrenceId: makeOccurrenceId({
        outputId: UNGROUNDED_OUTPUT_ID, source: "s", origin: { kind: "file", itemKey: "a.txt" },
      }),
      outputId: UNGROUNDED_OUTPUT_ID,
      source: "s",
      firstObservedAt: "2026-08-03T00:00:00.000Z",
      origin: { kind: "file", itemKey: "a.txt" },
    });
    expect(() => open()).toThrow(/is not in the corpus/);
  });

  it("refuses a manifest listing a field twice", () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 2, fieldOrder: ["output", "output"] }));
    expect(() => open()).toThrow(/more than once/);
  });

  it("releases the lock on close", () => {
    open().close();
    expect(fs.existsSync(path.join(storeDir, ".lock"))).toBe(false);
  });

  it("rejects a duplicate output id in the corpus", () => {
    appendRaw("outputs.jsonl", corpusRow());
    appendRaw("outputs.jsonl", { ...corpusRow(), capturedAt: "2026-08-04T00:00:00.000Z" });
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

  it("TOLERATES a current pointer that lags, because that is an interrupted publication", () => {
    // Refusing here would make the state permanently unrepairable: recovery
    // runs after the store opens. It warns instead, and a session completes it.
    const revision = publishChecklist();
    writeRevisionFile({ ...revision, version: 2, parentVersion: 1 });
    const store = open();
    expect(warnings.join(" ")).toMatch(/publication was interrupted/i);
    store.close();
  });

  it("rejects a current pointer naming a revision that does not exist", () => {
    const revision = publishChecklist();
    fs.writeFileSync(
      path.join(storeDir, "checklists", revision.checklistId, "current.json"),
      JSON.stringify({ schemaVersion: 1, checklistId: revision.checklistId, version: 9, hash: revision.hash }),
    );
    expect(() => open()).toThrow(/has no stored revision/i);
  });

  it("rejects a broken parent chain", () => {
    const revision = publishChecklist();
    writeRevisionFile({ ...revision, parentVersion: 5 });
    expect(() => open()).toThrow(/records parent/i);
  });

  it("rejects a gap in the revision chain", () => {
    const revision = publishChecklist();
    writeRevisionFile({ ...revision, version: 3, parentVersion: 1 });
    expect(() => open()).toThrow(/missing revision 2/i);
  });

  it("rejects a revision edited in place, because annotations bind to its hash", () => {
    const revision = publishChecklist();
    const edited = {
      ...revision,
      questions: [{ ...revision.questions[0], text: "Silently rewritten?" }],
    };
    // Keeps the ORIGINAL hash, which is what an in-place edit looks like.
    fs.writeFileSync(
      path.join(storeDir, "checklists", revision.checklistId, "1.json"),
      JSON.stringify(edited),
    );
    expect(() => open()).toThrow(/has been edited/i);
  });

  it("rejects a text edit introduced between two revisions", () => {
    const revision = publishChecklist();
    writeRevisionFile({
      ...revision,
      version: 2,
      parentVersion: 1,
      questions: [{ ...revision.questions[0], text: "Changed meaning?" }],
    });
    expect(() => open()).toThrow(/changed text/i);
  });
});

describe("appendAnnotation", () => {
  it("appends a grounded annotation", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    const store = open();
    expect(store.appendAnnotation(annotationRow(revision))).toBe("appended");
    expect(store.readSession(SESSION_ID).annotations).toHaveLength(1);
    store.close();
  });

  it("replays an identical annotation instead of duplicating it", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    const store = open();
    store.appendAnnotation(annotationRow(revision));
    expect(store.appendAnnotation(annotationRow(revision))).toBe("replayed");
    expect(store.readSession(SESSION_ID).annotations).toHaveLength(1);
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
    expect(() => store.readSession(SESSION_ID).annotations).toThrow(/closed/i);
  });
});

describe("readSession and saveDraft", () => {
  function draftFor(sessionId: string) {
    return {
      schemaVersion: 1 as const,
      sessionId,
      binding: {
        outputIds: [OUTPUT_ID],
        checklistId: "cl_news",
        checklist: { kind: "published" as const, version: 1, hash: HASH_ZERO },
        annotator: { kind: "human" as const, id: "adit" },
      },
      currentIndex: 0,
      answersByOutputId: {},
      notesByOutputId: {},
      reviewedByOutputId: {},
      stagedQuestions: null,
      pendingRevision: null,
      pendingAnnotation: null,
      activeMsByOutputId: {},
    };
  }

  it("reports no draft for a session that has none", () => {
    const store = open();
    expect(store.readSession(SESSION_ID).draft).toBeNull();
    store.close();
  });

  it("round-trips a draft through the facade", () => {
    const store = open();
    store.saveDraft(draftFor(SESSION_ID));
    expect(store.readSession(SESSION_ID).draft?.currentIndex).toBe(0);
    store.close();
  });

  it("returns a frozen projection, not a mutable internal reference", () => {
    const store = open();
    const snapshot = store.readSession(SESSION_ID);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.annotationIds)).toBe(true);
    store.close();
  });

  it("indexes annotation ids for O(1) replay checks", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    const store = open();
    store.appendAnnotation(annotationRow(revision));
    expect(store.readSession(SESSION_ID).annotationIds).toEqual({ ann_one: true });
    store.close();
  });

  it("validates a draft before writing it", () => {
    const store = open();
    const invalid = { ...draftFor(SESSION_ID), currentIndex: -1 };
    expect(() => store.saveDraft(invalid)).toThrow();
    store.close();
  });
});
