import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLabelingSessionOpener,
  type ControllerDependencies,
  type ControllerFaultPoint,
  type LabelingSessionController,
} from "./controller.js";
import { loadDraftFile } from "./draft.js";
import { writeRunFixture } from "./runFixture.js";
import { loadBatch } from "./load/index.js";
import { DEFAULT_MAX_INGEST_BYTES } from "./load/types.js";
import { acquireStoreLock } from "./lock.js";
import { openDataset } from "./dataset.js";
import { readCurrentPointer } from "./checklist.js";
import type { AnnotationRow } from "./types.js";

let root: string;
let storeDir: string;
let sourceDir: string;
let checklistFile: string;
const warnings: string[] = [];

/** Deterministic clocks and ids, so every assertion is about behaviour rather
 *  than about what time it happened to be. */
function makeDependencies(over: Partial<ControllerDependencies> = {}): ControllerDependencies {
  let elapsed = 0;
  let questionCount = 0;
  let annotationCount = 0;
  return {
    monotonicClock: { elapsedMs: () => (elapsed += 1000) },
    wallClock: { nowIso: () => "2026-08-03T00:00:00.000Z" },
    ids: {
      questionId: () => `q_generated${(questionCount += 1)}`,
      annotationId: () => `ann_generated${(annotationCount += 1)}`,
    },
    ...over,
  };
}

function writeSource(inputIds: string[], traceId = "trace-1"): void {
  writeRunFixture({
    dir: sourceDir,
    inputs: inputIds.map((inputId) => ({ inputId, traceId, task: `task ${inputId}` })),
  });
}

function writeChecklist(questions: string[]): void {
  fs.writeFileSync(checklistFile, JSON.stringify({
    name: "news-quality", questions: questions.map((text) => ({ text })),
  }, null, 2));
}

/**
 * Ingest the run into the store, the way the CLI does.
 *
 * Separate from opening a session: the controller labels what the store holds
 * and no longer ingests anything itself.
 */
function ingestRun(source = "agent-v1"): void {
  const batch = loadBatch({
    source: { path: sourceDir, requestedFormat: "run", includeTaskField: true, recursive: false },
    sourceName: source,
    constantFields: {},
    maxBytes: DEFAULT_MAX_INGEST_BYTES,
    selection: { kind: "none" },
    reportWarning: (message) => warnings.push(message),
  });
  const lock = acquireStoreLock({
    storeDir,
    reportWarning: (message) => warnings.push(message),
  });
  const store = openDataset({
    storeDir,
    lock,
    reportWarning: (message) => warnings.push(message),
  });
  try {
    store.ingest(batch);
  } finally {
    store.close();
    lock.release();
  }
}

/** Ingest, then open — the order the CLI uses. Tests that need an empty store
 *  call `openOnly` instead. */
async function open(dependencies = makeDependencies()): Promise<LabelingSessionController> {
  ingestRun();
  return openOnly(dependencies);
}

async function openOnly(
  dependencies = makeDependencies(),
): Promise<LabelingSessionController> {
  return createLabelingSessionOpener(dependencies)({
    storeDir,
    checklistFile,
    annotator: { kind: "human", id: "adit" },
    reportWarning: (message) => warnings.push(message),
  });
}

function readAnnotations(): AnnotationRow[] {
  const file = path.join(storeDir, "labels.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function checklistId(): string {
  return JSON.parse(fs.readFileSync(checklistFile, "utf8")).checklistId;
}

function sessionIdOnDisk(): string {
  const dir = path.join(storeDir, "drafts");
  return fs.readdirSync(dir)[0].replace(".json", "");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "label-controller-"));
  storeDir = path.join(root, "labels");
  sourceDir = path.join(root, "run");
  checklistFile = path.join(root, "news.json");
  warnings.length = 0;
  writeSource(["a", "b"]);
  writeChecklist(["Accurate?", "Today?"]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("module import", () => {
  it("has no side effects: importing does not touch the filesystem or terminal", () => {
    // The module was already imported at the top of this file. If it had run a
    // main(), acquired a lock or entered raw mode, these would not hold.
    expect(fs.existsSync(storeDir)).toBe(false);
    expect(process.stdin.isRaw).toBeFalsy();
  });
});

describe("opening", () => {
  it("captures the source, publishes version 1, and binds the draft", async () => {
    const controller = await open();
    const snapshot = controller.snapshot();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.questions).toHaveLength(2);
    expect(readCurrentPointer(storeDir, checklistId())?.version).toBe(1);
    await controller.close();
  });

  it("writes lineage back into the external checklist", async () => {
    const controller = await open();
    const definition = JSON.parse(fs.readFileSync(checklistFile, "utf8"));
    expect(definition.checklistId).toMatch(/^cl_/);
    expect(definition.version).toBe(1);
    await controller.close();
  });

  it("captures nothing new on a second open", async () => {
    await (await open()).close();
    const before = fs.readFileSync(path.join(storeDir, "outputs.jsonl"), "utf8");
    await (await open()).close();
    expect(fs.readFileSync(path.join(storeDir, "outputs.jsonl"), "utf8")).toBe(before);
  });

  it("releases the lock when opening fails", async () => {
    fs.writeFileSync(checklistFile, "{ not json");
    await expect(open()).rejects.toThrow();
    expect(fs.existsSync(path.join(storeDir, ".lock"))).toBe(false);
  });

  it("refuses when the store holds nothing to label", async () => {
    await expect(openOnly()).rejects.toThrow(/nothing to label/i);
    expect(fs.existsSync(path.join(storeDir, ".lock"))).toBe(false);
  });

  it("treats a reordered source as a separate session, never a corrupted resume", async () => {
    await (await open()).close();
    writeSource(["b", "a"], "trace-1");
    // The same outputs in the opposite order hash to a different session id,
    // so the earlier draft is never loaded against them. The draft-level guard
    // is defence in depth for that (see draft.test.ts).
    const controller = await open();
    // Records are content-identified, so a reordered source produces the same
    // two records; the session id changes because the ORDER changed.
    expect(controller.snapshot().items.map((item) => item.fields.task).slice().sort())
      .toEqual(["task a", "task b"]);
    await controller.close();
    expect(fs.readdirSync(path.join(storeDir, "drafts"))).toHaveLength(1);
  });
});

describe("dispatch", () => {
  it("toggles an answer and persists it to the draft", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "toggleAnswer" });
    const draft = loadDraftFile(storeDir, sessionIdOnDisk());
    const answers = Object.values(draft?.answersByOutputId ?? {})[0];
    expect(Object.values(answers ?? {})).toContain(true);
    await controller.close();
  });

  it("saves a draft on every state-changing dispatch", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "nextItem" });
    expect(loadDraftFile(storeDir, sessionIdOnDisk())?.currentIndex).toBe(1);
    await controller.close();
  });

  it("allocates the question id outside the reducer", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "beginQuestion" });
    for (const character of "Sourced?") {
      await controller.dispatch({ kind: "appendEditorText", text: character });
    }
    const snapshot = await controller.dispatch({ kind: "submitEditor" });
    expect(snapshot.questions).toHaveLength(3);
    expect(snapshot.questions[2].id).toBe("q_generated1");
    await controller.close();
  });

  it("ignores an empty new question", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "beginQuestion" });
    const snapshot = await controller.dispatch({ kind: "submitEditor" });
    expect(snapshot.questions).toHaveLength(2);
    await controller.close();
  });
});

describe("sign-off", () => {
  it("appends one annotation covering every live question", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "toggleAnswer" });
    await controller.dispatch({ kind: "signOff" });

    const rows = readAnnotations();
    expect(rows).toHaveLength(1);
    expect(rows[0].coveredQuestionIds).toHaveLength(2);
    expect(Object.values(rows[0].answers)).toEqual([true, false]);
    await controller.close();
  });

  it("advances to the next item and clears the pending annotation", async () => {
    const controller = await open();
    const snapshot = await controller.dispatch({ kind: "signOff" });
    expect(snapshot.itemIndex).toBe(1);
    expect(loadDraftFile(storeDir, sessionIdOnDisk())?.pendingAnnotation).toBeNull();
    await controller.close();
  });

  it("records accumulated active time", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "toggleAnswer" });
    await controller.dispatch({ kind: "signOff" });
    expect(readAnnotations()[0].activeMs).toBeGreaterThan(0);
    await controller.close();
  });

  it("resets the timer for the signed-off output, so a relabel starts fresh", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "signOff" });
    const draft = loadDraftFile(storeDir, sessionIdOnDisk());
    const first = Object.keys(draft?.activeMsByOutputId ?? {})[0];
    expect(draft?.activeMsByOutputId[first]).toBe(0);
    await controller.close();
  });

  it("publishes a staged question as a new revision before the annotation", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "beginQuestion" });
    await controller.dispatch({ kind: "appendEditorText", text: "Sourced?" });
    await controller.dispatch({ kind: "submitEditor" });
    await controller.dispatch({ kind: "signOff" });

    expect(readCurrentPointer(storeDir, checklistId())?.version).toBe(2);
    const rows = readAnnotations();
    expect(rows[0].checklistVersion).toBe(2);
    expect(rows[0].coveredQuestionIds).toHaveLength(3);
    await controller.close();
  });

  it("marks earlier items stale once a question is added", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "signOff" });
    await controller.dispatch({ kind: "beginQuestion" });
    await controller.dispatch({ kind: "appendEditorText", text: "Sourced?" });
    const snapshot = await controller.dispatch({ kind: "submitEditor" });
    expect(snapshot.progress.stale).toBe(1);
    await controller.close();
  });
});

describe("an all-deleted checklist", () => {
  it("refuses to sign off, rather than writing an annotation that undoes itself", async () => {
    const controller = await open();
    // Delete every question, so nothing is live.
    await controller.dispatch({ kind: "toggleQuestionDeleted" });
    await controller.dispatch({ kind: "nextQuestion" });
    await controller.dispatch({ kind: "toggleQuestionDeleted" });
    expect(controller.snapshot().canSignOff).toBe(false);

    await controller.dispatch({ kind: "signOff" });
    expect(readAnnotations()).toHaveLength(0);
    await controller.close();

    // And nothing claims to be reviewed after a reopen.
    const reopened = await open();
    expect(reopened.snapshot().progress.reviewed).toBe(0);
    await reopened.close();
  });
});

describe("resume", () => {
  it("restores answers and reviewed state", async () => {
    const first = await open();
    await first.dispatch({ kind: "toggleAnswer" });
    await first.dispatch({ kind: "signOff" });
    await first.close();

    const second = await open();
    const snapshot = second.snapshot();
    expect(snapshot.progress.reviewed).toBe(1);
    await second.close();
  });

  it("does not duplicate the annotation on reopen", async () => {
    const first = await open();
    await first.dispatch({ kind: "signOff" });
    await first.close();
    const second = await open();
    await second.close();
    expect(readAnnotations()).toHaveLength(1);
  });
});

/**
 * Interrupt the session at a named durable boundary, then reopen and assert
 * the store converges. Each row of the plan's recovery table is one case.
 *
 * `occurrence` matters for the revision boundaries: opening a brand-new
 * lineage publishes version 1, so a fault on the first hit would fire during
 * `open()` rather than during the sign-off under test.
 */
async function crashAt(
  point: ControllerFaultPoint,
  drive: (controller: LabelingSessionController) => Promise<unknown>,
  occurrence = 1,
) {
  let seen = 0;
  const dependencies = makeDependencies({
    fault: (reached) => {
      if (reached !== point) {
        return;
      }
      seen += 1;
      if (seen === occurrence) {
        throw new Error(`injected crash at ${point}`);
      }
    },
  });
  const controller = await open(dependencies);
  await expect(drive(controller)).rejects.toThrow(/injected crash/);
  // The failed session released the store; the lock must not be left behind.
  expect(fs.existsSync(path.join(storeDir, ".lock"))).toBe(false);
}

/** Drive a session that adds a question and signs off, which is the path that
 *  publishes a second revision. */
async function addQuestionAndSignOff(controller: LabelingSessionController): Promise<void> {
  await controller.dispatch({ kind: "beginQuestion" });
  await controller.dispatch({ kind: "appendEditorText", text: "Sourced?" });
  await controller.dispatch({ kind: "submitEditor" });
  await controller.dispatch({ kind: "signOff" });
}

describe("crash recovery", () => {
  it("after-pending-annotation-save: the annotation lands exactly once on reopen", async () => {
    await crashAt("after-pending-annotation-save", (controller) =>
      controller.dispatch({ kind: "signOff" }));
    expect(readAnnotations()).toHaveLength(0);

    const reopened = await open();
    expect(readAnnotations()).toHaveLength(1);
    expect(reopened.snapshot().progress.reviewed).toBe(1);
    await reopened.close();
    expect(readAnnotations()).toHaveLength(1);
  });

  it("after-annotation-append: the row is replayed, not duplicated", async () => {
    await crashAt("after-annotation-append", (controller) =>
      controller.dispatch({ kind: "signOff" }));
    expect(readAnnotations()).toHaveLength(1);

    const reopened = await open();
    expect(readAnnotations()).toHaveLength(1);
    expect(reopened.snapshot().progress.reviewed).toBe(1);
    await reopened.close();
  });

  it("after-pending-annotation-save: recovery ALSO advances the cursor and resets the timer", async () => {
    // Appending the row is only half the transition. Stopping there leaves the
    // person back on an item they already judged, with its old time running.
    await crashAt("after-pending-annotation-save", (controller) =>
      controller.dispatch({ kind: "signOff" }));

    const reopened = await open();
    expect(reopened.snapshot().itemIndex).toBe(1);
    const draft = loadDraftFile(storeDir, sessionIdOnDisk());
    const signedOff = readAnnotations()[0].outputId;
    expect(draft?.activeMsByOutputId[signedOff]).toBe(0);
    expect(draft?.reviewedByOutputId[signedOff]).toHaveLength(2);
    await reopened.close();
  });

  it("after-annotation-commit-save: reopening is a no-op", async () => {
    await crashAt("after-annotation-commit-save", (controller) =>
      controller.dispatch({ kind: "signOff" }));
    expect(readAnnotations()).toHaveLength(1);

    const reopened = await open();
    expect(readAnnotations()).toHaveLength(1);
    await reopened.close();
  });

  it("after-revision-rename: the revision is replayed and current advances", async () => {
    await crashAt("after-revision-rename", addQuestionAndSignOff, 2);

    const reopened = await open();
    expect(readCurrentPointer(storeDir, checklistId())?.version).toBe(2);
    expect(reopened.snapshot().questions).toHaveLength(3);
    await reopened.close();
  });

  it("after-current-update: the draft rebinds and the pending revision clears", async () => {
    await crashAt("after-current-update", addQuestionAndSignOff, 2);

    const reopened = await open();
    const draft = loadDraftFile(storeDir, sessionIdOnDisk());
    expect(draft?.pendingRevision).toBeNull();
    expect(draft?.binding.checklist).toMatchObject({ kind: "published", version: 2 });
    await reopened.close();
  });

  it("after-external-definition-sync: the external file already matches and stays put", async () => {
    await crashAt("after-external-definition-sync", addQuestionAndSignOff, 2);
    const afterCrash = fs.readFileSync(checklistFile, "utf8");

    const reopened = await open();
    expect(fs.readFileSync(checklistFile, "utf8")).toBe(afterCrash);
    expect(readCurrentPointer(storeDir, checklistId())?.version).toBe(2);
    await reopened.close();
  });
});

describe("lifecycle", () => {
  it("rejects dispatch after close", async () => {
    const controller = await open();
    await controller.close();
    await expect(controller.dispatch({ kind: "nextItem" })).rejects.toThrow(/closed/i);
  });

  it("is idempotent on repeated close", async () => {
    const controller = await open();
    await controller.close();
    await expect(controller.close()).resolves.toBeUndefined();
  });

  it("rejects dispatch after a failure and leaves no lock", async () => {
    const dependencies = makeDependencies({
      fault: (point) => {
        if (point === "after-pending-annotation-save") {
          throw new Error("injected");
        }
      },
    });
    const controller = await open(dependencies);
    await expect(controller.dispatch({ kind: "signOff" })).rejects.toThrow(/injected/);
    await expect(controller.dispatch({ kind: "nextItem" })).rejects.toThrow(/failed/i);
    expect(fs.existsSync(path.join(storeDir, ".lock"))).toBe(false);
  });

  it("releases the lock on close", async () => {
    const controller = await open();
    await controller.close();
    expect(fs.existsSync(path.join(storeDir, ".lock"))).toBe(false);
  });
});
