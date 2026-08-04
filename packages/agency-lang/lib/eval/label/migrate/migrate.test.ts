import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHash } from "crypto";

import { canonicalize } from "@/utils/canonicalize.js";

import { checklistHashOf } from "../ids.js";
import type { AnnotationRow, CorpusRow, OccurrenceRow } from "../types.js";

import { migrateStore, MigrationTargetError } from "./migrate.js";
import { MigrationBlockedError, MigrationConflictError } from "./plan.js";

let root: string;
let sourceDir: string;
let destDir: string;

const HASH = `sha256:${"0".repeat(64)}`;
const CHECKLIST_ID = "cl_news";

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "label-migrate-")));
  sourceDir = path.join(root, "old-labels");
  destDir = path.join(root, "new-labels");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

type V1Row = {
  task: unknown;
  value: unknown;
  capturedAt?: string;
  traceId?: string;
  inputId?: string;
};

/** The version 1 id formula. Fixtures must use real ids now that migration
 *  recomputes them: a hand-written one is exactly what it refuses. */
function v1OutputId(traceId: string, inputId: string, finalOutputIndex = 0): string {
  const digest = createHash("sha256")
    .update(canonicalize({ traceId, inputId, finalOutputIndex }))
    .digest("hex");
  return `out_${digest}`;
}

function v1Row(row: V1Row): unknown {
  const traceId = row.traceId ?? "t-1";
  const inputId = row.inputId ?? "a";
  return {
    schemaVersion: 1,
    outputId: v1OutputId(traceId, inputId),
    contentHash: HASH,
    capturedAt: row.capturedAt ?? "2026-08-03T00:00:00.000Z",
    execution: { traceId, inputId, finalOutputIndex: 0 },
    input: { inputId, task: row.task },
    value: row.value,
    text: typeof row.value === "string" ? row.value : JSON.stringify(row.value),
    provenance: {
      runStartedAtMs: 1000,
      agent: { kind: "file", entry: "news.agency" },
      models: ["gpt-4o"],
    },
  };
}

function annotation(over: Partial<AnnotationRow> & { outputId: string }): AnnotationRow {
  return {
    schemaVersion: 1,
    annotationId: `ann_${over.outputId.slice(4, 12)}`,
    annotator: { kind: "human", id: "adit" },
    checklistId: CHECKLIST_ID,
    checklistVersion: 1,
    checklistHash: HASH,
    createdAt: "2026-08-03T00:00:00.000Z",
    activeMs: 10,
    coveredQuestionIds: ["q_accurate"],
    answers: { q_accurate: true },
    note: "",
    ...over,
  } as AnnotationRow;
}

function writeV1Store(rows: unknown[], annotations: AnnotationRow[] = []): void {
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({ schemaVersion: 1 }));
  fs.writeFileSync(
    path.join(sourceDir, "outputs.jsonl"),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  if (annotations.length > 0) {
    fs.writeFileSync(
      path.join(sourceDir, "labels.jsonl"),
      annotations.map((row) => `${JSON.stringify(row)}\n`).join(""),
    );
  }
  writeChecklist();
}

function writeChecklist(): void {
  const questions = [{ id: "q_accurate", text: "Accurate?", weight: 1, deleted: false }];
  const hash = checklistHashOf({ checklistId: CHECKLIST_ID, version: 1, questions });
  const dir = path.join(sourceDir, "checklists", CHECKLIST_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({
    schemaVersion: 1,
    checklistId: CHECKLIST_ID,
    name: "news-quality",
    version: 1,
    parentVersion: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    hash,
    questions,
  }));
  fs.writeFileSync(path.join(dir, "current.json"), JSON.stringify({
    schemaVersion: 1, checklistId: CHECKLIST_ID, version: 1, hash,
  }));
}

/** Annotations must record the hash of the revision they were made against, so
 *  the migrated store passes its own open-time validation. */
function checklistHash(): string {
  const questions = [{ id: "q_accurate", text: "Accurate?", weight: 1, deleted: false }];
  return checklistHashOf({ checklistId: CHECKLIST_ID, version: 1, questions });
}

function readJsonl<Row>(file: string): Row[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, "utf8").trim().split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Row);
}

function records(): CorpusRow[] {
  return readJsonl<CorpusRow>(path.join(destDir, "outputs.jsonl"));
}

function occurrences(): OccurrenceRow[] {
  return readJsonl<OccurrenceRow>(path.join(destDir, "occurrences.jsonl"));
}

function migratedAnnotations(): AnnotationRow[] {
  return readJsonl<AnnotationRow>(path.join(destDir, "labels.jsonl"));
}

/** Run a migration that dies right after claiming its staging directory. */
function interruptAfterClaim(): void {
  expect(() => migrateStore({
    sourceDir,
    destDir,
    faultBeforePublish: () => {
      throw new Error("interrupted");
    },
  })).toThrow("interrupted");
}

const OUT_A = v1OutputId("t-1", "a");
const OUT_B = v1OutputId("t-2", "a");
const OUT_C = v1OutputId("t-3", "a");

describe("migrateStore", () => {
  it("rewrites every record with a content-derived id", () => {
    writeV1Store([v1Row({ task: "Summarize", value: "Done" })]);
    migrateStore({ sourceDir, destDir });
    expect(records()).toHaveLength(1);
    expect(records()[0].fields).toEqual({ task: "Summarize", output: "Done" });
    expect(records()[0].outputId).not.toBe(OUT_A);
  });

  it("maps every annotation onto the record holding the same text", () => {
    writeV1Store(
      [v1Row({ task: "Summarize", value: "Done" })],
      [annotation({ outputId: OUT_A, checklistHash: checklistHash() })],
    );
    migrateStore({ sourceDir, destDir });
    expect(migratedAnnotations()[0].outputId).toBe(records()[0].outputId);
  });

  it("projects a structured task and output through the shared rule", () => {
    writeV1Store([v1Row({ task: { topic: "news" }, value: { s: 1 } })]);
    migrateStore({ sourceDir, destDir });
    expect(records()[0].fields).toEqual({ task: '{"topic":"news"}', output: '{"s":1}' });
  });

  it("writes one record per distinct field map and one occurrence per old row", () => {
    writeV1Store([
      v1Row({ task: "Summarize", value: "Done" }),
      v1Row({ traceId: "t-2", task: "Summarize", value: "Done" }),
      v1Row({ traceId: "t-3", task: "Summarize", value: "Different" }),
    ]);
    const result = migrateStore({ sourceDir, destDir });
    expect(records()).toHaveLength(2);
    expect(occurrences()).toHaveLength(3);
    expect(result.mergedGroups).toBe(1);
  });

  it("marks migrated occurrences legacy rather than inventing a source name", () => {
    writeV1Store([v1Row({ task: "Summarize", value: "Done" })]);
    migrateStore({ sourceDir, destDir });
    expect(occurrences().every((row) => row.source === "legacy")).toBe(true);
    expect(occurrences().every((row) => row.origin.kind === "legacy")).toBe(true);
  });

  it("preserves raw values and every existing provenance field", () => {
    writeV1Store([v1Row({ task: { topic: "news" }, value: { s: 1 } })]);
    migrateStore({ sourceDir, destDir });
    expect(occurrences()[0].origin).toMatchObject({
      kind: "legacy",
      traceId: "t-1",
      runStartedAtMs: 1000,
      models: ["gpt-4o"],
      agent: { kind: "file", entry: "news.agency" },
      rawTask: { topic: "news" },
      rawValue: { s: 1 },
    });
  });

  it("collapses two merged rows whose effective answers agree", () => {
    writeV1Store([
      v1Row({ task: "Summarize", value: "Done" }),
      v1Row({ traceId: "t-2", task: "Summarize", value: "Done" }),
    ], [
      annotation({ outputId: OUT_A, annotationId: "ann_one", checklistHash: checklistHash() }),
      annotation({ outputId: OUT_B, annotationId: "ann_two", checklistHash: checklistHash() }),
    ]);
    migrateStore({ sourceDir, destDir });
    expect(records()).toHaveLength(1);
    // Both annotations survive: the fold makes them one effective judgement,
    // and discarding either would lose the history of who judged what when.
    expect(migratedAnnotations()).toHaveLength(2);
  });

  it("REFUSES when merged rows disagree, naming the old ids and the question", () => {
    writeV1Store([
      v1Row({ task: "Summarize", value: "Done" }),
      v1Row({ traceId: "t-2", task: "Summarize", value: "Done" }),
    ], [
      annotation({ outputId: OUT_A, annotationId: "ann_one", answers: { q_accurate: true } }),
      annotation({ outputId: OUT_B, annotationId: "ann_two", answers: { q_accurate: false } }),
    ]);
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(MigrationConflictError);
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/q_accurate/);
  });

  it("refuses when merged rows carry different notes", () => {
    writeV1Store([
      v1Row({ task: "Summarize", value: "Done" }),
      v1Row({ traceId: "t-2", task: "Summarize", value: "Done" }),
    ], [
      annotation({ outputId: OUT_A, annotationId: "ann_one", note: "looks fine" }),
      annotation({ outputId: OUT_B, annotationId: "ann_two", note: "actually wrong" }),
    ]);
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/notes also differ/);
  });

  it("writes nothing when it refuses, so there is no partial store to clean up", () => {
    writeV1Store([
      v1Row({ task: "Summarize", value: "Done" }),
      v1Row({ traceId: "t-2", task: "Summarize", value: "Done" }),
    ], [
      annotation({ outputId: OUT_A, annotationId: "ann_one", answers: { q_accurate: true } }),
      annotation({ outputId: OUT_B, annotationId: "ann_two", answers: { q_accurate: false } }),
    ]);
    expect(() => migrateStore({ sourceDir, destDir })).toThrow();
    expect(fs.existsSync(destDir)).toBe(false);
    expect(fs.existsSync(`${destDir}.migrating`)).toBe(false);
  });

  it("does not treat two rows judged by DIFFERENT people as a conflict", () => {
    writeV1Store([
      v1Row({ task: "Summarize", value: "Done" }),
      v1Row({ traceId: "t-2", task: "Summarize", value: "Done" }),
    ], [
      annotation({
        outputId: OUT_A, annotationId: "ann_one", checklistHash: checklistHash(),
        answers: { q_accurate: true },
      }),
      annotation({
        outputId: OUT_B, annotationId: "ann_two", checklistHash: checklistHash(),
        annotator: { kind: "human", id: "sam" }, answers: { q_accurate: false },
      }),
    ]);
    expect(() => migrateStore({ sourceDir, destDir })).not.toThrow();
  });

  it("uses the earliest capturedAt of a merged group, so order does not matter", () => {
    writeV1Store([
      v1Row({ task: "S", value: "D", capturedAt: "2026-08-05T00:00:00.000Z" }),
      v1Row({ traceId: "t-2", task: "S", value: "D", capturedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    migrateStore({ sourceDir, destDir });
    expect(records()[0].capturedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("keeps annotations in their original append order, because the fold depends on it", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })], [
      annotation({ outputId: OUT_A, annotationId: "ann_first", checklistHash: checklistHash() }),
      annotation({
        outputId: OUT_A, annotationId: "ann_second", checklistHash: checklistHash(),
        answers: { q_accurate: false },
      }),
    ]);
    migrateStore({ sourceDir, destDir });
    expect(migratedAnnotations().map((row) => row.annotationId))
      .toEqual(["ann_first", "ann_second"]);
  });

  it("refuses while a draft exists in the source store", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    fs.mkdirSync(path.join(sourceDir, "drafts"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "drafts", "session_x.json"), "{}");
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(MigrationBlockedError);
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/Finish or discard/);
  });

  it("copies checklists unchanged, since nothing about them is keyed by output", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    const before = fs.readFileSync(
      path.join(sourceDir, "checklists", CHECKLIST_ID, "1.json"), "utf8");
    migrateStore({ sourceDir, destDir });
    expect(fs.readFileSync(path.join(destDir, "checklists", CHECKLIST_ID, "1.json"), "utf8"))
      .toBe(before);
  });

  it("leaves the source store untouched", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    const before = fs.readFileSync(path.join(sourceDir, "outputs.jsonl"), "utf8");
    migrateStore({ sourceDir, destDir });
    expect(fs.readFileSync(path.join(sourceDir, "outputs.jsonl"), "utf8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(path.join(sourceDir, "manifest.json"), "utf8")))
      .toEqual({ schemaVersion: 1 });
  });

  it("produces a store the ordinary read path can open", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })],
      [annotation({ outputId: OUT_A, checklistHash: checklistHash() })]);
    // migrateStore validates this itself before publishing; asserting it here
    // pins the guarantee rather than trusting the implementation to keep it.
    expect(() => migrateStore({ sourceDir, destDir })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(destDir, "manifest.json"), "utf8")))
      .toEqual({ schemaVersion: 2, fieldOrder: ["task", "output"] });
  });

  it("leaves no usable destination if interrupted before the manifest write", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    interruptAfterClaim();
    expect(fs.existsSync(destDir)).toBe(false);
  });

  it("writes the marker before copying, so an early crash is still reclaimable", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    interruptAfterClaim();
    expect(fs.existsSync(path.join(`${destDir}.migrating`, ".migration.json"))).toBe(true);
  });

  it("recovers from an interrupted run on the next attempt", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    interruptAfterClaim();
    // The leftover staging directory must not make the retry refuse.
    expect(() => migrateStore({ sourceDir, destDir })).not.toThrow();
    expect(records()).toHaveLength(1);
  });

  it("never deletes through a symlink in a leftover stage", () => {
    // cpSync preserves symlinks, so a staged `checklists/shared -> /elsewhere`
    // once let cleanup delete files OUTSIDE the staging directory entirely.
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    const external = path.join(root, "external");
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "precious.txt"), "DO NOT DELETE");

    const stage = `${destDir}.migrating`;
    fs.mkdirSync(path.join(stage, "checklists"), { recursive: true });
    fs.symlinkSync(external, path.join(stage, "checklists", "shared"));
    fs.writeFileSync(path.join(stage, ".migration.json"), JSON.stringify({
      purpose: "agency-eval-label-migrate",
      sourceDir: fs.realpathSync(sourceDir),
      destDir: path.resolve(destDir),
      entries: [
        { path: "checklists", type: "dir" },
        { path: "checklists/shared", type: "dir" },
      ],
    }));

    migrateStore({ sourceDir, destDir });
    expect(fs.readFileSync(path.join(external, "precious.txt"), "utf8")).toBe("DO NOT DELETE");
  });

  it("refuses a source checklist that is a symlink, rather than copying a link", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    const external = path.join(root, "external");
    fs.mkdirSync(external, { recursive: true });
    fs.symlinkSync(external, path.join(sourceDir, "checklists", "shared"));
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/symbolic link/);
  });

  it("refuses to delete a staging path it did not create", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    fs.mkdirSync(`${destDir}.migrating`, { recursive: true });
    fs.writeFileSync(path.join(`${destDir}.migrating`, "someone-elses-file"), "important");
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/does not recognise/);
  });

  it("refuses an existing destination rather than merging into it", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    fs.mkdirSync(destDir, { recursive: true });
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(MigrationTargetError);
  });

  it("reports a missing source store", () => {
    expect(() => migrateStore({ sourceDir: path.join(root, "nope"), destDir }))
      .toThrow(/Source store not found/);
  });

  it("refuses a store that is not version 1", () => {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 2, fieldOrder: [] }));
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/not a version 1 label store/);
  });

  it("reports counts a person can check against their old store", () => {
    writeV1Store([
      v1Row({ task: "S", value: "D" }),
      v1Row({ traceId: "t-2", task: "S", value: "D" }),
    ], [annotation({ outputId: OUT_A, checklistHash: checklistHash() })]);
    expect(migrateStore({ sourceDir, destDir })).toMatchObject({
      oldRecords: 2,
      newRecords: 1,
      mergedGroups: 1,
      occurrences: 2,
      annotations: 1,
    });
  });
});

describe("migrateStore refuses a corpus it cannot move faithfully", () => {
  it("refuses two rows sharing an output id", () => {
    // Both annotations for that id would land on whichever row was read last.
    const row = v1Row({ task: "S", value: "D" });
    writeV1Store([row, row]);
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/share output id/);
  });

  it("refuses a row whose id does not match its own execution", () => {
    const row = v1Row({ task: "S", value: "D" }) as Record<string, unknown>;
    writeV1Store([{ ...row, outputId: `out_${"f".repeat(64)}` }]);
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/hashes to/);
  });

  it("writes nothing when it refuses on identity grounds", () => {
    const row = v1Row({ task: "S", value: "D" });
    writeV1Store([row, row]);
    expect(() => migrateStore({ sourceDir, destDir })).toThrow();
    expect(fs.existsSync(destDir)).toBe(false);
  });
});

describe("migrateStore publication", () => {
  it("leaves no ownership marker in the published store", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    migrateStore({ sourceDir, destDir });
    expect(fs.existsSync(path.join(destDir, ".migration.json"))).toBe(false);
  });

  it("finishes a publication interrupted between the rename and the marker removal", () => {
    // The store is already complete; refusing would strand it.
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    migrateStore({ sourceDir, destDir });
    fs.writeFileSync(path.join(destDir, ".migration.json"), JSON.stringify({
      purpose: "agency-eval-label-migrate",
      sourceDir: fs.realpathSync(sourceDir),
      destDir: fs.realpathSync(destDir),
      entries: [],
    }));
    const result = migrateStore({ sourceDir, destDir });
    expect(result.completedEarlierRun).toBe(true);
    expect(fs.existsSync(path.join(destDir, ".migration.json"))).toBe(false);
    expect(records()).toHaveLength(1);
  });

  it("still refuses a destination carrying a marker it cannot open", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, ".migration.json"), JSON.stringify({
      purpose: "agency-eval-label-migrate",
      sourceDir: fs.realpathSync(sourceDir),
      destDir: fs.realpathSync(destDir),
      entries: [],
    }));
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/already exists/);
  });

  it("keeps the marker until AFTER the rename, so an interrupted publish is reclaimable", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    interruptAfterClaim();
    expect(fs.existsSync(path.join(`${destDir}.migrating`, ".migration.json"))).toBe(true);
    expect(() => migrateStore({ sourceDir, destDir })).not.toThrow();
  });

  it("leaves an unexpected file in a leftover stage alone, and says so", () => {
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    interruptAfterClaim();
    const stage = `${destDir}.migrating`;
    fs.mkdirSync(path.join(stage, "checklists"), { recursive: true });
    const intruder = path.join(stage, "checklists", "not-ours.txt");
    fs.writeFileSync(intruder, "important");
    expect(() => migrateStore({ sourceDir, destDir })).toThrow(/did not write/);
    expect(fs.readFileSync(intruder, "utf8")).toBe("important");
  });

  it("reclaims a staged path the source no longer has", () => {
    // The source is unlocked between a crash and the retry. Deriving ownership
    // from the live source would leave a staged copy of a since-deleted
    // checklist permanently unreclaimable, blocking every future attempt.
    writeV1Store([v1Row({ task: "S", value: "D" })]);
    const stage = `${destDir}.migrating`;
    fs.mkdirSync(path.join(stage, "checklists", "cl_deleted"), { recursive: true });
    fs.writeFileSync(path.join(stage, "checklists", "cl_deleted", "1.json"), "{}");
    fs.writeFileSync(path.join(stage, ".migration.json"), JSON.stringify({
      purpose: "agency-eval-label-migrate",
      sourceDir: fs.realpathSync(sourceDir),
      destDir: path.resolve(destDir),
      entries: [
        { path: "checklists", type: "dir" },
        { path: "checklists/cl_deleted", type: "dir" },
        { path: "checklists/cl_deleted/1.json", type: "file" },
      ],
    }));

    expect(() => migrateStore({ sourceDir, destDir })).not.toThrow();
    expect(fs.existsSync(path.join(destDir, "checklists", "cl_deleted"))).toBe(false);
  });
});
