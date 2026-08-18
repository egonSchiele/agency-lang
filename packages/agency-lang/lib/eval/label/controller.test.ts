import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAnnotations, type ChecklistAnnotation } from "@/runDirectory/annotations.js";
import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";

import { readCurrentPointer } from "./checklist.js";
import {
  createLabelingSessionOpener,
  type ControllerDependencies,
  type ControllerFaultPoint,
  type LabelingSessionController,
} from "./controller.js";
import { loadDraftFile } from "./draft.js";

let root: string;
let dir: string;
let checklistFile: string;
const warnings: string[] = [];

/** Deterministic clocks and ids, so every assertion is about behaviour rather
 *  than about what time it happened to be. */
function makeDependencies(over: Partial<ControllerDependencies> = {}): ControllerDependencies {
  let elapsed = 0;
  let questionCount = 0;
  return {
    monotonicClock: { elapsedMs: () => (elapsed += 1000) },
    wallClock: { nowIso: () => "2026-08-03T00:00:00.000Z" },
    ids: { questionId: () => `q_generated${(questionCount += 1)}` },
    ...over,
  };
}

/** A run directory with one finished trace per id, in that order. */
function writeTraces(traceIds: string[]): void {
  fs.rmSync(dir, { recursive: true, force: true });
  writeRunDirectory(
    traceIds.map((traceId) => ({
      traceId,
      test: { id: traceId, input: `input ${traceId}` },
      output: `output ${traceId}`,
    })),
    dir,
  );
}

function writeChecklist(questions: string[]): void {
  fs.writeFileSync(
    checklistFile,
    JSON.stringify(
      {
        name: "news-quality",
        questions: questions.map((text) => ({ text })),
      },
      null,
      2,
    ),
  );
}

async function open(dependencies = makeDependencies()): Promise<LabelingSessionController> {
  return createLabelingSessionOpener(dependencies)({
    dir,
    checklistFile,
    annotator: { kind: "human", id: "adit" },
    reportWarning: (message) => warnings.push(message),
  });
}

function checklistRows(): ChecklistAnnotation[] {
  return readAnnotations(path.join(dir, "annotations.jsonl"), (message) =>
    warnings.push(message),
  ).filter((row): row is ChecklistAnnotation => row.kind === "checklist");
}

function checklistId(): string {
  return JSON.parse(fs.readFileSync(checklistFile, "utf8")).checklistId;
}

function draftsDir(): string {
  return path.join(dir, "checklists", checklistId(), "drafts");
}

function sessionIdOnDisk(): string {
  return fs.readdirSync(draftsDir())[0].replace(".json", "");
}

function draftOnDisk() {
  return loadDraftFile(dir, checklistId(), sessionIdOnDisk());
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "label-controller-"));
  dir = path.join(root, "run");
  checklistFile = path.join(root, "news.json");
  warnings.length = 0;
  writeTraces(["trace-a", "trace-b"]);
  writeChecklist(["Accurate?", "Today?"]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("module import", () => {
  it("has no side effects: importing does not touch the filesystem or terminal", () => {
    // The module was already imported at the top of this file. If it had run a
    // main(), acquired a lock or entered raw mode, these would not hold.
    expect(fs.existsSync(path.join(dir, ".lock"))).toBe(false);
    expect(process.stdin.isRaw).toBeFalsy();
  });
});

describe("opening", () => {
  it("lists the traces, publishes version 1, and binds the draft", async () => {
    const controller = await open();
    const snapshot = controller.snapshot();
    expect(snapshot.items.map((item) => item.traceId)).toEqual(["trace-a", "trace-b"]);
    expect(snapshot.items[0].fields).toEqual({ input: "input trace-a", output: "output trace-a" });
    expect(snapshot.questions).toHaveLength(2);
    expect(readCurrentPointer(dir, checklistId())?.version).toBe(1);
    await controller.close();
  });

  it("writes lineage back into the external checklist", async () => {
    const controller = await open();
    const definition = JSON.parse(fs.readFileSync(checklistFile, "utf8"));
    expect(definition.checklistId).toMatch(/^cl_/);
    expect(definition.version).toBe(1);
    await controller.close();
  });

  it("writes nothing to the annotation log on a second open", async () => {
    await (await open()).close();
    const before = fs.existsSync(path.join(dir, "annotations.jsonl"))
      ? fs.readFileSync(path.join(dir, "annotations.jsonl"), "utf8")
      : "";
    await (await open()).close();
    expect(fs.readFileSync(path.join(dir, "annotations.jsonl"), "utf8")).toBe(before);
  });

  it("releases the lock when opening fails", async () => {
    fs.writeFileSync(checklistFile, "{ not json");
    await expect(open()).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, ".lock"))).toBe(false);
  });

  it("refuses when the directory holds nothing to label", async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    await expect(open()).rejects.toThrow(/nothing to label/i);
    expect(fs.existsSync(path.join(dir, ".lock"))).toBe(false);
  });

  it("treats a reordered directory as a separate session, never a corrupted resume", async () => {
    await (await open()).close();
    writeTraces(["trace-b", "trace-a"]);
    // The same traces in the opposite order hash to a different session id,
    // so the earlier draft is never loaded against them. The draft-level guard
    // is defence in depth for that (see draft.test.ts).
    const controller = await open();
    expect(controller.snapshot().items.map((item) => item.traceId)).toEqual(["trace-b", "trace-a"]);
    await controller.close();
    expect(fs.readdirSync(draftsDir())).toHaveLength(1);
  });
});

describe("dispatch", () => {
  it("toggles an answer and persists it to the draft", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "toggleAnswer" });
    const draft = draftOnDisk();
    const answers = Object.values(draft?.answersByTraceId ?? {})[0];
    expect(Object.values(answers ?? {})).toContain(true);
    await controller.close();
  });

  it("saves a draft on every state-changing dispatch", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "nextItem" });
    expect(draftOnDisk()?.currentIndex).toBe(1);
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
  it("appends one checklist row for the trace, answering every live question", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "toggleAnswer" });
    await controller.dispatch({ kind: "signOff" });

    const rows = checklistRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].traceId).toBe("trace-a");
    expect(rows[0].checklist).toBe(checklistId());
    expect(rows[0].annotator).toEqual({ kind: "human", id: "adit" });
    expect(Object.values(rows[0].answers)).toEqual([true, false]);
    await controller.close();
  });

  it("advances to the next item and clears the pending annotation", async () => {
    const controller = await open();
    const snapshot = await controller.dispatch({ kind: "signOff" });
    expect(snapshot.itemIndex).toBe(1);
    expect(draftOnDisk()?.pendingAnnotation).toBeNull();
    await controller.close();
  });

  it("records accumulated active time", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "toggleAnswer" });
    await controller.dispatch({ kind: "signOff" });
    expect(checklistRows()[0].activeMs).toBeGreaterThan(0);
    await controller.close();
  });

  it("resets the timer for the signed-off trace, so a relabel starts fresh", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "signOff" });
    const draft = draftOnDisk();
    const first = Object.keys(draft?.activeMsByTraceId ?? {})[0];
    expect(draft?.activeMsByTraceId[first]).toBe(0);
    await controller.close();
  });

  it("publishes a staged question as a new revision before the annotation", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "beginQuestion" });
    await controller.dispatch({ kind: "appendEditorText", text: "Sourced?" });
    await controller.dispatch({ kind: "submitEditor" });
    await controller.dispatch({ kind: "signOff" });

    expect(readCurrentPointer(dir, checklistId())?.version).toBe(2);
    const rows = checklistRows();
    expect(rows[0].version).toBe(2);
    expect(Object.keys(rows[0].answers)).toHaveLength(3);
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
    expect(checklistRows()).toHaveLength(0);
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
    expect(checklistRows()).toHaveLength(1);
  });

  it("keeps a second annotator's answers apart from the first's", async () => {
    const first = await open();
    await first.dispatch({ kind: "toggleAnswer" });
    await first.dispatch({ kind: "signOff" });
    await first.close();

    const other = await createLabelingSessionOpener(makeDependencies())({
      dir,
      checklistFile,
      annotator: { kind: "human", id: "sam" },
      reportWarning: (message) => warnings.push(message),
    });
    expect(other.snapshot().progress.reviewed).toBe(0);
    await other.close();
  });
});

/**
 * Interrupt the session at a named durable boundary, then reopen and assert
 * the directory converges. Each row of the recovery table is one case.
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
  // The failed session released the directory; the lock must not be left behind.
  expect(fs.existsSync(path.join(dir, ".lock"))).toBe(false);
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
      controller.dispatch({ kind: "signOff" }),
    );
    expect(checklistRows()).toHaveLength(0);

    const reopened = await open();
    expect(checklistRows()).toHaveLength(1);
    expect(reopened.snapshot().progress.reviewed).toBe(1);
    await reopened.close();
    expect(checklistRows()).toHaveLength(1);
  });

  it("after-annotation-append: the row is replayed, not duplicated", async () => {
    await crashAt("after-annotation-append", (controller) =>
      controller.dispatch({ kind: "signOff" }),
    );
    expect(checklistRows()).toHaveLength(1);

    const reopened = await open();
    expect(checklistRows()).toHaveLength(1);
    expect(reopened.snapshot().progress.reviewed).toBe(1);
    await reopened.close();
  });

  it("after-pending-annotation-save: recovery ALSO advances the cursor and resets the timer", async () => {
    // Appending the row is only half the transition. Stopping there leaves the
    // person back on an item they already judged, with its old time running.
    await crashAt("after-pending-annotation-save", (controller) =>
      controller.dispatch({ kind: "signOff" }),
    );

    const reopened = await open();
    expect(reopened.snapshot().itemIndex).toBe(1);
    const draft = draftOnDisk();
    const signedOff = checklistRows()[0].traceId;
    expect(draft?.activeMsByTraceId[signedOff]).toBe(0);
    expect(draft?.reviewedByTraceId[signedOff]).toHaveLength(2);
    await reopened.close();
  });

  it("after-annotation-commit-save: reopening is a no-op", async () => {
    await crashAt("after-annotation-commit-save", (controller) =>
      controller.dispatch({ kind: "signOff" }),
    );
    expect(checklistRows()).toHaveLength(1);

    const reopened = await open();
    expect(checklistRows()).toHaveLength(1);
    await reopened.close();
  });

  it("after-revision-rename: the revision is replayed and current advances", async () => {
    await crashAt("after-revision-rename", addQuestionAndSignOff, 2);

    const reopened = await open();
    expect(readCurrentPointer(dir, checklistId())?.version).toBe(2);
    expect(reopened.snapshot().questions).toHaveLength(3);
    await reopened.close();
  });

  it("after-current-update: the draft rebinds and the pending revision clears", async () => {
    await crashAt("after-current-update", addQuestionAndSignOff, 2);

    const reopened = await open();
    const draft = draftOnDisk();
    expect(draft?.pendingRevision).toBeNull();
    expect(draft?.binding.checklist).toMatchObject({ kind: "published", version: 2 });
    await reopened.close();
  });

  it("after-external-definition-sync: the external file already matches and stays put", async () => {
    await crashAt("after-external-definition-sync", addQuestionAndSignOff, 2);
    const afterCrash = fs.readFileSync(checklistFile, "utf8");

    const reopened = await open();
    expect(fs.readFileSync(checklistFile, "utf8")).toBe(afterCrash);
    expect(readCurrentPointer(dir, checklistId())?.version).toBe(2);
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
    expect(fs.existsSync(path.join(dir, ".lock"))).toBe(false);
  });

  it("releases the lock on close", async () => {
    const controller = await open();
    await controller.close();
    expect(fs.existsSync(path.join(dir, ".lock"))).toBe(false);
  });
});
