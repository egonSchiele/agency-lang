import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAnnotations, type ChecklistAnnotation } from "@/runDirectory/annotations.js";
import { acquireOwnedFileLock } from "@/runDirectory/lock.js";
import { writeRunGroup } from "@/eval/runDirectoryFixture.js";

import { readCurrentPointer } from "./checklist.js";
import {
  createLabelingSessionOpener,
  type ControllerDependencies,
  type ControllerFaultPoint,
  type LabelingSessionController,
} from "./controller.js";
import { loadDraftFile } from "./draft.js";
import { resolveLabelingGroup } from "./group.js";

let root: string;
/** The group: one run directory per trace, `<dir>/<traceId>/`. */
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

/** A group with one finished run per trace id, at `<dir>/<traceId>/`. */
function writeTraces(traceIds: string[]): void {
  fs.rmSync(dir, { recursive: true, force: true });
  writeRunGroup(
    traceIds.map((traceId) => ({
      traceId,
      test: { id: traceId, input: `input ${traceId}` },
      output: `output ${traceId}`,
    })),
    dir,
  );
}

function runDirs(): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, "statelog.jsonl")))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Every `.lock` anywhere under the group, relative to it. */
function lockFiles(): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".lock")) out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
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

async function open(
  dependencies = makeDependencies(),
  paths: string[] = [dir],
): Promise<LabelingSessionController> {
  return createLabelingSessionOpener(dependencies)({
    group: resolveLabelingGroup(paths, { reportWarning: (message) => warnings.push(message) }),
    checklistFile,
    annotator: { kind: "human", id: "adit" },
    reportWarning: (message) => warnings.push(message),
  });
}

/** Every run's checklist rows, runs in name order. */
function checklistRows(): ChecklistAnnotation[] {
  return runDirs().flatMap((run) =>
    readAnnotations(path.join(run, "annotations.jsonl"), (message) =>
      warnings.push(message),
    ).filter((row): row is ChecklistAnnotation => row.kind === "checklist"),
  );
}

function checklistId(): string {
  return JSON.parse(fs.readFileSync(checklistFile, "utf8")).checklistId;
}

function draftsDir(): string {
  return path.join(dir, "checklists", checklistId(), "drafts");
}

function sessionIdOnDisk(): string {
  return fs
    .readdirSync(draftsDir())
    .filter((name) => name.endsWith(".json"))[0]
    .replace(".json", "");
}

function draftOnDisk() {
  return loadDraftFile(dir, checklistId(), sessionIdOnDisk());
}

/** The draft of one annotator, when several sessions have drafts in the group. */
function draftOf(annotatorId: string) {
  return fs
    .readdirSync(draftsDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => loadDraftFile(dir, checklistId(), name.replace(".json", "")))
    .find((draft) => draft?.binding.annotator.id === annotatorId);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "label-controller-"));
  dir = path.join(root, "runs");
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
    expect(lockFiles()).toEqual([]);
    expect(process.stdin.isRaw).toBeFalsy();
  });
});

describe("opening", () => {
  it("lists the runs, publishes version 1 in the group, and binds the draft", async () => {
    const controller = await open();
    const snapshot = controller.snapshot();
    expect(snapshot.items.map((item) => item.traceId)).toEqual(["trace-a", "trace-b"]);
    expect(snapshot.items.map((item) => item.runDir)).toEqual(
      runDirs().map((run) => fs.realpathSync(run)),
    );
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

  it("writes nothing to any annotation log on a second open", async () => {
    await (await open()).close();
    const before = runDirs().map((run) =>
      fs.readFileSync(path.join(run, "annotations.jsonl"), "utf8"),
    );
    await (await open()).close();
    expect(
      runDirs().map((run) => fs.readFileSync(path.join(run, "annotations.jsonl"), "utf8")),
    ).toEqual(before);
  });

  it("leaves no lock when opening fails", async () => {
    fs.writeFileSync(checklistFile, "{ not json");
    await expect(open()).rejects.toThrow();
    expect(lockFiles()).toEqual([]);
  });

  it("refuses when no run in the group has a trace", async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "silent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "silent", "statelog.jsonl"), "");
    await expect(open()).rejects.toThrow(/nothing to label/i);
    expect(lockFiles()).toEqual([]);
  });

  it("treats the same runs in another order as a separate session, never a corrupted resume", async () => {
    await (await open()).close();
    // The same runs listed in the opposite order hash to a different session
    // id, so the earlier draft is never loaded against them. The draft-level
    // guard is defence in depth for that (see draft.test.ts).
    const controller = await open(makeDependencies(), [
      path.join(dir, "trace-b"),
      path.join(dir, "trace-a"),
    ]);
    expect(controller.snapshot().items.map((item) => item.traceId)).toEqual(["trace-b", "trace-a"]);
    await controller.close();
    expect(fs.readdirSync(draftsDir()).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });
});

describe("concurrent openers", () => {
  it("two first opens of an id-less checklist share one lineage: the second adopts the ids the first wrote", async () => {
    // Simulate the other opener finishing between this opener's parse and its
    // id allocation: at that fault point, write a fully identified copy of the
    // file, as `allocateChecklistIds` in another process would have.
    const otherIds = {
      checklistId: "cl_other",
      questions: [
        { id: "q_other1", text: "Accurate?" },
        { id: "q_other2", text: "Today?" },
      ],
    };
    const dependencies = makeDependencies({
      fault: (point) => {
        if (point === "before-checklist-id-allocation") {
          const parsed = JSON.parse(fs.readFileSync(checklistFile, "utf8"));
          fs.writeFileSync(
            checklistFile,
            JSON.stringify({
              ...parsed,
              checklistId: otherIds.checklistId,
              questions: otherIds.questions,
            }),
          );
        }
      },
    });
    const controller = await open(dependencies);
    expect(checklistId()).toBe("cl_other");
    expect(controller.snapshot().questions.map((question) => question.id)).toEqual([
      "q_other1",
      "q_other2",
    ]);
    await controller.close();
    expect(fs.readdirSync(path.join(dir, "checklists")).filter((n) => n.startsWith("cl_"))).toEqual(
      ["cl_other"],
    );
  });

  it("refuses, clearly, while another session is allocating ids for the same group", async () => {
    const held = acquireOwnedFileLock({
      lockFile: path.join(dir, "checklists", ".definition.lock"),
      reportWarning: () => {},
    });
    try {
      await expect(open()).rejects.toThrow(/giving .*news\.json its ids right now/);
    } finally {
      held.release();
    }
    expect(lockFiles()).toEqual([]);
  });
});

describe("losing a publication race", () => {
  it("a draft whose pending revision is stale is rebased on reopen: both sessions' questions survive", async () => {
    // Session one stages a question but crashes before publishing it.
    await crashAt("after-pending-revision-save", addQuestionAndSignOff, 2);
    expect(draftOf("adit")?.pendingRevision?.revision.version).toBe(2);

    // Session two (another annotator) publishes version 2 with a different question first.
    const other = await createLabelingSessionOpener(
      makeDependencies({ ids: { questionId: () => "q_sam1" } }),
    )({
      group: resolveLabelingGroup([dir], { reportWarning: (message) => warnings.push(message) }),
      checklistFile,
      annotator: { kind: "human", id: "sam" },
      reportWarning: (message) => warnings.push(message),
    });
    await other.dispatch({ kind: "beginQuestion" });
    await other.dispatch({ kind: "appendEditorText", text: "Cited?" });
    await other.dispatch({ kind: "submitEditor" });
    await other.dispatch({ kind: "signOff" });
    await other.close();
    expect(readCurrentPointer(dir, checklistId())?.version).toBe(2);

    // Session one reopens: its pending revision expects parent 1, the lineage
    // is at 2. It rebases (Sourced? on top of Cited?) and publishes 3.
    const reopened = await open();
    const texts = reopened.snapshot().questions.map((question) => question.text);
    expect(texts).toEqual(["Accurate?", "Today?", "Cited?", "Sourced?"]);
    expect(readCurrentPointer(dir, checklistId())?.version).toBe(3);
    expect(draftOf("adit")?.pendingRevision).toBeNull();
    await reopened.close();
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
  it("appends one checklist row for the trace, in its own run directory, answering every live question", async () => {
    const controller = await open();
    await controller.dispatch({ kind: "toggleAnswer" });
    await controller.dispatch({ kind: "signOff" });

    const rows = checklistRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].traceId).toBe("trace-a");
    const inA = readAnnotations(path.join(dir, "trace-a", "annotations.jsonl"), () => {});
    expect(inA.some((row) => row.kind === "checklist")).toBe(true);
    const inB = readAnnotations(path.join(dir, "trace-b", "annotations.jsonl"), () => {});
    expect(inB.some((row) => row.kind === "checklist")).toBe(false);
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
      group: resolveLabelingGroup([dir], { reportWarning: (message) => warnings.push(message) }),
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
  // The failed session released its locks; none may be left behind.
  expect(lockFiles()).toEqual([]);
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
    expect(lockFiles()).toEqual([]);
  });

  it("releases the lock on close", async () => {
    const controller = await open();
    await controller.close();
    expect(lockFiles()).toEqual([]);
  });
});
