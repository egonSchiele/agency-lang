import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeDefinition,
  prepareRevision,
  publishPendingRevision,
  readCurrentPointer,
  readRevision,
  revisionFromDefinition,
  syncChecklistDefinition,
  type NormalizedDefinition,
} from "./checklist.js";
import type { ChecklistDefinition, ChecklistRevision } from "./types.js";

let datasetDir: string;
let definitionPath: string;

beforeEach(() => {
  datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), "label-checklist-"));
  definitionPath = path.join(datasetDir, "news.json");
});

afterEach(() => {
  fs.rmSync(datasetDir, { recursive: true, force: true });
});

const rawDefinition: ChecklistDefinition = {
  name: "news-quality",
  questions: [{ text: "Accurate?" }, { text: "Today?" }],
};

/** Normalize, publish version 1, and return the published state. */
function publishFirst(): { definition: NormalizedDefinition; revision: ChecklistRevision } {
  const normalized = normalizeDefinition(rawDefinition);
  fs.writeFileSync(definitionPath, JSON.stringify(normalized, null, 2));
  const prepared = prepareRevision({ definition: normalized, current: undefined });
  if (prepared.kind !== "publish") {
    throw new Error(`expected publish, got ${prepared.kind}`);
  }
  const published = publishPendingRevision({ datasetDir, pending: prepared.pending, definitionPath });
  return { definition: readDefinition(), revision: published.revision };
}

/** The definition file after publication has written lineage into it, so it
 *  is always normalized by the time a test reads it back. */
function readDefinition(): NormalizedDefinition {
  return normalizeDefinition(JSON.parse(fs.readFileSync(definitionPath, "utf8")));
}

function currentRevision(checklistId: string): ChecklistRevision {
  const pointer = readCurrentPointer(datasetDir, checklistId);
  if (pointer === undefined) {
    throw new Error("no current pointer");
  }
  return readRevision(datasetDir, checklistId, pointer.version);
}

describe("normalizeDefinition", () => {
  it("allocates a checklist id and question ids", () => {
    const normalized = normalizeDefinition(rawDefinition);
    expect(normalized.checklistId).toMatch(/^cl_/);
    expect(normalized.questions[0].id).toMatch(/^q_/);
    expect(normalized.questions[0].id).not.toBe(normalized.questions[1].id);
  });

  it("defaults weight to 1 and deleted to false", () => {
    const normalized = normalizeDefinition(rawDefinition);
    expect(normalized.questions[0].weight).toBe(1);
    expect(normalized.questions[0].deleted).toBe(false);
  });

  it("keeps ids that are already allocated", () => {
    const once = normalizeDefinition(rawDefinition);
    expect(normalizeDefinition(once).checklistId).toBe(once.checklistId);
    expect(normalizeDefinition(once).questions[0].id).toBe(once.questions[0].id);
  });

  it("rejects duplicate question ids", () => {
    const duplicated: ChecklistDefinition = {
      name: "n",
      checklistId: "cl_x",
      questions: [{ id: "q_a", text: "one" }, { id: "q_a", text: "two" }],
    };
    expect(() => normalizeDefinition(duplicated)).toThrow(/unique|duplicate/i);
  });
});

describe("first publication", () => {
  it("writes version 1 with a null parent", () => {
    const { revision } = publishFirst();
    expect(revision.version).toBe(1);
    expect(revision.parentVersion).toBeNull();
  });

  it("writes an immutable revision file and a current pointer", () => {
    const { revision } = publishFirst();
    const dir = path.join(datasetDir, "checklists", revision.checklistId);
    expect(fs.existsSync(path.join(dir, "1.json"))).toBe(true);
    expect(readCurrentPointer(datasetDir, revision.checklistId)).toEqual({
      schemaVersion: 1, checklistId: revision.checklistId, version: 1, hash: revision.hash,
    });
  });

  it("writes lineage back into the external definition", () => {
    const { revision } = publishFirst();
    const definition = readDefinition();
    expect(definition.checklistId).toBe(revision.checklistId);
    expect(definition.version).toBe(1);
    expect(definition.hash).toBe(revision.hash);
  });

  it("leaves no publication temp file behind", () => {
    const { revision } = publishFirst();
    const dir = path.join(datasetDir, "checklists", revision.checklistId);
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});

describe("prepareRevision against an existing lineage", () => {
  it("reports an unchanged definition as current", () => {
    const { definition, revision } = publishFirst();
    expect(prepareRevision({ definition, current: revision }).kind).toBe("current");
  });

  it("prepares one next revision when a question is added", () => {
    const { definition, revision } = publishFirst();
    const edited: ChecklistDefinition = {
      ...definition,
      questions: [...definition.questions, { text: "Sourced?" }],
    };
    const prepared = prepareRevision({ definition: normalizeDefinition(edited), current: revision });
    expect(prepared.kind).toBe("publish");
    if (prepared.kind !== "publish") return;
    expect(prepared.pending.revision.version).toBe(2);
    expect(prepared.pending.expectedParentVersion).toBe(1);
    expect(prepared.pending.expectedParentHash).toBe(revision.hash);
  });

  it("prepares a next revision for a soft delete", () => {
    const { definition, revision } = publishFirst();
    const edited = {
      ...definition,
      questions: definition.questions.map((question, index) =>
        index === 0 ? { ...question, deleted: true } : question),
    };
    const prepared = prepareRevision({ definition: edited, current: revision });
    expect(prepared.kind).toBe("publish");
  });

  it("prepares a next revision for a legal weight change", () => {
    const { definition, revision } = publishFirst();
    const edited = {
      ...definition,
      questions: definition.questions.map((question, index) =>
        index === 0 ? { ...question, weight: 3 } : question),
    };
    const prepared = prepareRevision({ definition: edited, current: revision });
    expect(prepared.kind).toBe("publish");
    if (prepared.kind !== "publish") return;
    expect(prepared.pending.revision.questions[0].weight).toBe(3);
  });

  it("refuses a text edit under an existing question id", () => {
    const { definition, revision } = publishFirst();
    const edited = {
      ...definition,
      questions: definition.questions.map((question, index) =>
        index === 0 ? { ...question, text: "Rewritten?" } : question),
    };
    expect(() => prepareRevision({ definition: edited, current: revision })).toThrow(/text/i);
  });

  it("refuses a removed question rather than stranding its answers", () => {
    const { definition, revision } = publishFirst();
    const edited = { ...definition, questions: [definition.questions[0]] };
    expect(() => prepareRevision({ definition: edited, current: revision })).toThrow(/removed|soft-delete/i);
  });

  it("refuses a non-positive weight", () => {
    const { definition, revision } = publishFirst();
    const edited = {
      ...definition,
      questions: definition.questions.map((question, index) =>
        index === 0 ? { ...question, weight: 0 } : question),
    };
    expect(() => prepareRevision({ definition: edited, current: revision })).toThrow();
  });

  it("refuses a definition claiming a different lineage", () => {
    const { definition, revision } = publishFirst();
    const edited = { ...definition, checklistId: "cl_someone_else" };
    expect(() => prepareRevision({ definition: edited, current: revision })).toThrow(/lineage|checklist/i);
  });

  it("refuses a definition claiming a version ahead of current", () => {
    const { definition, revision } = publishFirst();
    const edited = { ...definition, version: 5 };
    expect(() => prepareRevision({ definition: edited, current: revision })).toThrow(/version/i);
  });
});

describe("stale external definitions", () => {
  function publishSecond() {
    const first = publishFirst();
    const edited = {
      ...first.definition,
      questions: [...first.definition.questions, { text: "Sourced?" }],
    };
    const prepared = prepareRevision({ definition: normalizeDefinition(edited), current: first.revision });
    if (prepared.kind !== "publish") throw new Error("expected publish");
    const published = publishPendingRevision({ datasetDir, pending: prepared.pending, definitionPath });
    return { first, second: published.revision };
  }

  it("refreshes an unedited stale definition from current", () => {
    const { first, second } = publishSecond();
    // first.definition is now stale: it still records version 1, unedited.
    const prepared = prepareRevision({ definition: first.definition, current: second });
    expect(prepared.kind).toBe("refresh-definition");
    if (prepared.kind !== "refresh-definition") return;
    expect(prepared.revision.version).toBe(2);
  });

  it("rejects a stale definition that was ALSO edited, rather than overwriting newer criteria", () => {
    const { first, second } = publishSecond();
    const staleAndEdited = {
      ...first.definition,
      questions: [...first.definition.questions, { text: "Something else?" }],
    };
    expect(() => prepareRevision({ definition: normalizeDefinition(staleAndEdited), current: second }))
      .toThrow(/ambiguous|stale/i);
  });

  it("refuses a definition whose recorded hash does not match its recorded version", () => {
    const { first } = publishSecond();
    const tampered = { ...first.definition, hash: `sha256:${"9".repeat(64)}` };
    expect(() => prepareRevision({ definition: tampered, current: first.revision })).toThrow(/hash/i);
  });
});

describe("publishPendingRevision idempotence", () => {
  it("replays an identical existing revision instead of failing", () => {
    const { definition, revision } = publishFirst();
    const edited = {
      ...definition,
      questions: [...definition.questions, { text: "Sourced?" }],
    };
    const prepared = prepareRevision({ definition: normalizeDefinition(edited), current: revision });
    if (prepared.kind !== "publish") throw new Error("expected publish");

    const first = publishPendingRevision({ datasetDir, pending: prepared.pending, definitionPath });
    const second = publishPendingRevision({ datasetDir, pending: prepared.pending, definitionPath });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(currentRevision(revision.checklistId).version).toBe(2);
  });

  it("refuses to overwrite a different revision already stored at that version", () => {
    // Reachable after a crash between the immutable rename and the current
    // pointer update: version 2 exists on disk while current still says 1. A
    // second session then legitimately prepares its own version 2, and must
    // not be allowed to replace the stored one.
    const { definition, revision } = publishFirst();
    const edited = {
      ...definition,
      questions: [...definition.questions, { text: "Sourced?" }],
    };
    const prepared = prepareRevision({ definition: normalizeDefinition(edited), current: revision });
    if (prepared.kind !== "publish") throw new Error("expected publish");
    publishPendingRevision({ datasetDir, pending: prepared.pending, definitionPath });

    // Roll the pointer back to the parent, as a crash would have left it.
    fs.writeFileSync(
      path.join(datasetDir, "checklists", revision.checklistId, "current.json"),
      JSON.stringify({
        schemaVersion: 1, checklistId: revision.checklistId,
        version: revision.version, hash: revision.hash,
      }),
    );

    const conflicting = {
      ...definition,
      questions: [...definition.questions, { text: "A different question?" }],
    };
    const other = prepareRevision({ definition: normalizeDefinition(conflicting), current: revision });
    if (other.kind !== "publish") throw new Error("expected publish");
    expect(() => publishPendingRevision({ datasetDir, pending: other.pending, definitionPath }))
      .toThrow(/already exists|immutable/i);
  });

  it("completes a publication whose current pointer was never updated", () => {
    const { definition, revision } = publishFirst();
    const edited = {
      ...definition,
      questions: [...definition.questions, { text: "Sourced?" }],
    };
    const prepared = prepareRevision({ definition: normalizeDefinition(edited), current: revision });
    if (prepared.kind !== "publish") throw new Error("expected publish");
    publishPendingRevision({ datasetDir, pending: prepared.pending, definitionPath });
    fs.writeFileSync(
      path.join(datasetDir, "checklists", revision.checklistId, "current.json"),
      JSON.stringify({
        schemaVersion: 1, checklistId: revision.checklistId,
        version: revision.version, hash: revision.hash,
      }),
    );

    const replay = publishPendingRevision({ datasetDir, pending: prepared.pending, definitionPath });
    expect(replay.replayed).toBe(true);
    expect(currentRevision(revision.checklistId).version).toBe(2);
  });

  it("refuses a pending revision whose expected parent no longer matches current", () => {
    const { definition, revision } = publishFirst();
    const edited = {
      ...definition,
      questions: [...definition.questions, { text: "Sourced?" }],
    };
    const prepared = prepareRevision({ definition: normalizeDefinition(edited), current: revision });
    if (prepared.kind !== "publish") throw new Error("expected publish");
    publishPendingRevision({ datasetDir, pending: prepared.pending, definitionPath });

    const stalePending = {
      ...prepared.pending,
      revision: { ...prepared.pending.revision, version: 3, parentVersion: 2 },
    };
    expect(() => publishPendingRevision({ datasetDir, pending: stalePending, definitionPath }))
      .toThrow(/parent|current/i);
  });
});

describe("syncChecklistDefinition", () => {
  it("rewrites the external file to match a revision", () => {
    const { revision } = publishFirst();
    const next = revisionFromDefinition({
      definition: normalizeDefinition({
        ...readDefinition(),
        questions: [...readDefinition().questions, { text: "Sourced?" }],
      }),
      version: 2,
      parentVersion: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    syncChecklistDefinition({ definitionPath, revision: next });
    const definition = readDefinition();
    expect(definition.version).toBe(2);
    expect(definition.questions).toHaveLength(3);
    expect(definition.checklistId).toBe(revision.checklistId);
  });
});
