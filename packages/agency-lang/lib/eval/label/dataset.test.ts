import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeDefinition, prepareRevision, publishPendingRevision } from "./checklist.js";
import { corpusPath } from "./corpus.js";
import { checklistHashOf, makeOccurrenceId, makeOutputId } from "./ids.js";
import type { LoadedBatch } from "./load/types.js";
import { acquireDatasetLock } from "./lock.js";
import { openDataset, DatasetValidationError, DatasetVersionError } from "./dataset.js";
import { CorpusRowSchema } from "./types.js";
import type { AnnotationRow, ChecklistRevision, CorpusRow } from "./types.js";

// The rename from "dataset" to "dataset" is a TypeScript-symbol change ONLY. This
// guard fails loudly if a durable name ever drifts: ids keep the `out_` prefix,
// corpus rows keep `outputId`, and the corpus file stays `outputs.jsonl`.
describe("durable vocabulary is preserved across the dataset rename", () => {
  it("keeps the version 2 durable vocabulary", () => {
    const fields = { output: "answer" };
    const outputId = makeOutputId(fields);

    expect(outputId).toMatch(/^out_[a-f0-9]{64}$/);
    expect(
      CorpusRowSchema.parse({
        schemaVersion: 2,
        outputId,
        capturedAt: "2026-08-15T00:00:00.000Z",
        fields,
      }).outputId,
    ).toBe(outputId);
    expect(path.basename(corpusPath("labels"))).toBe("outputs.jsonl");
  });
});

let datasetDir: string;
let definitionPath: string;
const warnings: string[] = [];

const DEFAULT_FIELDS = { task: "t", output: "v" };
/** The id the dataset will derive for DEFAULT_FIELDS. Computed rather than
 *  written down, because a hand-written id is exactly what open-time validation
 *  now rejects. */
const OUTPUT_ID = makeOutputId(DEFAULT_FIELDS);
/** A well-formed id that is NOT the hash of any record here. */
const UNGROUNDED_OUTPUT_ID = `out_${"a".repeat(64)}`;
const SESSION_ID = `session_${"c".repeat(64)}`;
const HASH_ZERO = `sha256:${"0".repeat(64)}`;

beforeEach(() => {
  datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), "label-dataset-"));
  definitionPath = path.join(datasetDir, "news.json");
  warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(datasetDir, { recursive: true, force: true });
});

function open() {
  const lock = acquireDatasetLock({ datasetDir, reportWarning: (m) => warnings.push(m) });
  return openDataset({ datasetDir, lock, reportWarning: (m) => warnings.push(m) });
}

function corpusRow(over: Partial<CorpusRow> = {}): CorpusRow {
  const fields = over.fields ?? DEFAULT_FIELDS;
  return {
    schemaVersion: 2,
    // Derived, so a row built here is one the dataset would accept: the open-time
    // check recomputes this and refuses anything that does not match.
    outputId: makeOutputId(fields),
    capturedAt: "2026-08-03T00:00:00.000Z",
    fields,
    ...over,
  };
}

/** One loaded candidate, as a loader would hand it to the dataset. */
function batchOf(fields = DEFAULT_FIELDS, source = "agent-v1"): LoadedBatch {
  return {
    occurrences: [
      {
        fields,
        source,
        origin: { kind: "file", itemKey: "a.txt" },
      },
    ],
    skips: [],
  };
}

function appendRaw(file: string, row: unknown): void {
  fs.mkdirSync(datasetDir, { recursive: true });
  fs.appendFileSync(path.join(datasetDir, file), `${JSON.stringify(row)}\n`);
}

/** Publish a one-question checklist and return its revision. */
function publishChecklist(): ChecklistRevision {
  const normalized = normalizeDefinition({ name: "news", questions: [{ text: "Accurate?" }] });
  const prepared = prepareRevision({ definition: normalized, current: undefined });
  if (prepared.kind !== "publish") throw new Error("expected publish");
  return publishPendingRevision({ datasetDir, pending: prepared.pending, definitionPath }).revision;
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
  const dir = path.join(datasetDir, "checklists", revision.checklistId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${revision.version}.json`), JSON.stringify(sealed));
}

function annotationRow(
  revision: ChecklistRevision,
  over: Partial<AnnotationRow> = {},
): AnnotationRow {
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

describe("openDataset", () => {
  it("opens an empty dataset and writes a manifest", () => {
    const dataset = open();
    expect(dataset.readSession(SESSION_ID).annotations).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(datasetDir, "manifest.json"), "utf8"))).toEqual({
      schemaVersion: 2,
      fieldOrder: [],
    });
    dataset.close();
  });

  it("refuses a manifest from a newer schema rather than risking the dataset", () => {
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(path.join(datasetDir, "manifest.json"), JSON.stringify({ schemaVersion: 3 }));
    expect(() => open()).toThrow(DatasetVersionError);
  });

  it("refuses a version 1 dataset and says how to rebuild it", () => {
    // There is no migration, deliberately: a label dataset is derived data, and
    // the eval runs it came from are still on disk.
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(path.join(datasetDir, "manifest.json"), JSON.stringify({ schemaVersion: 1 }));
    // One call, then assert on its message. Calling open() twice leaves the
    // first lock held, so the second failure is about the lock and any further
    // assertion passes or fails for the wrong reason.
    expect(() => open()).toThrow(/predates content-derived record ids[\s\S]*agency label ingest/);
  });

  it("checks the manifest BEFORE parsing any log", () => {
    // A version 1 corpus line would produce a confusing deep validation error
    // if the version gate ran second.
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(path.join(datasetDir, "manifest.json"), JSON.stringify({ schemaVersion: 1 }));
    fs.writeFileSync(
      path.join(datasetDir, "outputs.jsonl"),
      '{"schemaVersion":1,"nonsense":true}\n',
    );
    expect(() => open()).toThrow(/predates content-derived record ids/);
  });

  it("refuses a manifest with unknown keys", () => {
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(
      path.join(datasetDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 2, fieldOrder: [], extra: true }),
    );
    expect(() => open()).toThrow(DatasetValidationError);
  });

  it("refuses a corpus row whose id is not the hash of its own fields", () => {
    appendRaw("outputs.jsonl", { ...corpusRow(), outputId: UNGROUNDED_OUTPUT_ID });
    expect(() => open()).toThrow(/does not match the hash of its own fields/);
  });

  it("refuses an occurrence referencing a record nobody stored", () => {
    appendRaw("occurrences.jsonl", {
      schemaVersion: 1,
      occurrenceId: makeOccurrenceId({
        outputId: UNGROUNDED_OUTPUT_ID,
        source: "s",
        origin: { kind: "file", itemKey: "a.txt" },
      }),
      outputId: UNGROUNDED_OUTPUT_ID,
      source: "s",
      firstObservedAt: "2026-08-03T00:00:00.000Z",
      origin: { kind: "file", itemKey: "a.txt" },
    });
    expect(() => open()).toThrow(/is not in the corpus/);
  });

  it("refuses a manifest listing a field twice", () => {
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(
      path.join(datasetDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 2, fieldOrder: ["output", "output"] }),
    );
    expect(() => open()).toThrow(/more than once/);
  });

  it("releases the lock on close", () => {
    open().close();
    expect(fs.existsSync(path.join(datasetDir, ".lock"))).toBe(false);
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
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(path.join(datasetDir, "outputs.jsonl"), JSON.stringify(corpusRow()));
    expect(() => open()).toThrow(/newline/i);
  });
});

describe("dataset invariants across files", () => {
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
    appendRaw(
      "labels.jsonl",
      annotationRow(revision, {
        coveredQuestionIds: ["q_unknown"],
        answers: { q_unknown: true },
      }),
    );
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
    appendRaw(
      "labels.jsonl",
      annotationRow(revision, {
        coveredQuestionIds: [],
        answers: { [revision.questions[0].id]: true },
      }),
    );
    expect(() => open()).toThrow(/without covering/i);
  });

  it("TOLERATES a current pointer that lags, because that is an interrupted publication", () => {
    // Refusing here would make the state permanently unrepairable: recovery
    // runs after the dataset opens. It warns instead, and a session completes it.
    const revision = publishChecklist();
    writeRevisionFile({ ...revision, version: 2, parentVersion: 1 });
    const dataset = open();
    expect(warnings.join(" ")).toMatch(/publication was interrupted/i);
    dataset.close();
  });

  it("rejects a current pointer naming a revision that does not exist", () => {
    const revision = publishChecklist();
    fs.writeFileSync(
      path.join(datasetDir, "checklists", revision.checklistId, "current.json"),
      JSON.stringify({
        schemaVersion: 1,
        checklistId: revision.checklistId,
        version: 9,
        hash: revision.hash,
      }),
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
      path.join(datasetDir, "checklists", revision.checklistId, "1.json"),
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
    const dataset = open();
    expect(dataset.appendAnnotation(annotationRow(revision))).toBe("appended");
    expect(dataset.readSession(SESSION_ID).annotations).toHaveLength(1);
    dataset.close();
  });

  it("replays an identical annotation instead of duplicating it", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    const dataset = open();
    dataset.appendAnnotation(annotationRow(revision));
    expect(dataset.appendAnnotation(annotationRow(revision))).toBe("replayed");
    expect(dataset.readSession(SESSION_ID).annotations).toHaveLength(1);
    dataset.close();
  });

  it("refuses an annotation whose output was never captured", () => {
    const revision = publishChecklist();
    const dataset = open();
    expect(() => dataset.appendAnnotation(annotationRow(revision))).toThrow(/not in the corpus/i);
    dataset.close();
  });

  it("refuses a second annotation reusing an id with different content", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    const dataset = open();
    dataset.appendAnnotation(annotationRow(revision));
    expect(() => dataset.appendAnnotation(annotationRow(revision, { note: "changed" }))).toThrow(
      /different content/i,
    );
    dataset.close();
  });

  it("refuses every operation after close", () => {
    const dataset = open();
    dataset.close();
    expect(() => dataset.readSession(SESSION_ID).annotations).toThrow(/closed/i);
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
    const dataset = open();
    expect(dataset.readSession(SESSION_ID).draft).toBeNull();
    dataset.close();
  });

  it("round-trips a draft through the facade", () => {
    const dataset = open();
    dataset.saveDraft(draftFor(SESSION_ID));
    expect(dataset.readSession(SESSION_ID).draft?.currentIndex).toBe(0);
    dataset.close();
  });

  it("returns a frozen projection, not a mutable internal reference", () => {
    const dataset = open();
    const snapshot = dataset.readSession(SESSION_ID);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.annotationIds)).toBe(true);
    dataset.close();
  });

  it("indexes annotation ids for O(1) replay checks", () => {
    const revision = publishChecklist();
    appendRaw("outputs.jsonl", corpusRow());
    const dataset = open();
    dataset.appendAnnotation(annotationRow(revision));
    expect(dataset.readSession(SESSION_ID).annotationIds).toEqual({ ann_one: true });
    dataset.close();
  });

  it("validates a draft before writing it", () => {
    const dataset = open();
    const invalid = { ...draftFor(SESSION_ID), currentIndex: -1 };
    expect(() => dataset.saveDraft(invalid)).toThrow();
    dataset.close();
  });
});

describe("dataset format advice", () => {
  it("tells you to upgrade, not migrate, when the dataset is NEWER", () => {
    // Migration only moves a dataset forwards, so pointing at it would be a dead
    // end.
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(path.join(datasetDir, "manifest.json"), JSON.stringify({ schemaVersion: 99 }));
    let message = "";
    try {
      open();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Upgrade Agency/);
    // Rebuilding cannot help a dataset from the FUTURE, so it must not be
    // suggested. Asserted on the captured message: a second open() would fail
    // on the still-held lock and pass this vacuously.
    expect(message).not.toMatch(/agency label ingest/);
  });
});
