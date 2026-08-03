import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertBindingIsCoherent,
  assertDraftMatches,
  DraftSchema,
  draftPath,
  loadDraftFile,
  saveDraftFile,
  type Draft,
} from "./draft.js";

const HASH = `sha256:${"0".repeat(64)}`;
const SESSION_ID = `session_${"c".repeat(64)}`;
const OUT_A = `out_${"a".repeat(64)}`;
const OUT_B = `out_${"b".repeat(64)}`;

let storeDir: string;

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "label-draft-"));
});

afterEach(() => {
  fs.rmSync(storeDir, { recursive: true, force: true });
});

function draft(over: Partial<Draft> = {}): Draft {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    binding: {
      outputIds: [OUT_A, OUT_B],
      checklistId: "cl_news",
      checklist: { kind: "published", version: 1, hash: HASH },
      annotator: { kind: "human", id: "adit" },
    },
    currentIndex: 0,
    answersByOutputId: {},
    notesByOutputId: {},
    reviewedByOutputId: {},
    stagedQuestions: null,
    pendingRevision: null,
    pendingAnnotation: null,
    activeMsByOutputId: {},
    ...over,
  };
}

describe("draft persistence", () => {
  it("round-trips", () => {
    saveDraftFile(storeDir, draft());
    expect(loadDraftFile(storeDir, SESSION_ID)?.binding.outputIds).toEqual([OUT_A, OUT_B]);
  });

  it("returns undefined when there is no draft", () => {
    expect(loadDraftFile(storeDir, SESSION_ID)).toBeUndefined();
  });

  it("writes atomically, leaving no temporary file", () => {
    saveDraftFile(storeDir, draft());
    const dir = path.dirname(draftPath(storeDir, SESSION_ID));
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("replaces the previous draft rather than appending", () => {
    saveDraftFile(storeDir, draft());
    saveDraftFile(storeDir, draft({ currentIndex: 1 }));
    expect(loadDraftFile(storeDir, SESSION_ID)?.currentIndex).toBe(1);
  });

  it("rejects a draft file with unknown fields", () => {
    const file = draftPath(storeDir, SESSION_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...draft(), surprise: true }));
    expect(() => loadDraftFile(storeDir, SESSION_ID)).toThrow(/not a valid labelling draft/i);
  });

  it("rejects an unsafe session id", () => {
    expect(DraftSchema.safeParse(draft({ sessionId: "../escape" })).success).toBe(false);
  });

  it("rejects a negative accumulated time", () => {
    expect(DraftSchema.safeParse(draft({ activeMsByOutputId: { [OUT_A]: -1 } })).success).toBe(false);
  });
});

describe("assertDraftMatches", () => {
  const expected = {
    outputIds: [OUT_A, OUT_B],
    checklistId: "cl_news",
    annotator: { kind: "human", id: "adit" },
  };

  it("accepts an exact match", () => {
    expect(() => assertDraftMatches(draft(), expected)).not.toThrow();
  });

  it("rejects a reordered source, which would misalign the cursor", () => {
    const reordered = draft({ binding: { ...draft().binding, outputIds: [OUT_B, OUT_A] } });
    expect(() => assertDraftMatches(reordered, expected)).toThrow(/order/i);
  });

  it("rejects a different set of outputs", () => {
    const fewer = draft({ binding: { ...draft().binding, outputIds: [OUT_A] } });
    expect(() => assertDraftMatches(fewer, expected)).toThrow(/set or order/i);
  });

  it("rejects a different checklist lineage", () => {
    const other = draft({ binding: { ...draft().binding, checklistId: "cl_other" } });
    expect(() => assertDraftMatches(other, expected)).toThrow(/checklist/i);
  });

  it("rejects a different annotator", () => {
    const other = draft({
      binding: { ...draft().binding, annotator: { kind: "human", id: "someone" } },
    });
    expect(() => assertDraftMatches(other, expected)).toThrow(/belongs to human "someone"/i);
  });

  it("rejects a machine annotator sharing the human's id", () => {
    const other = draft({
      binding: { ...draft().binding, annotator: { kind: "llm", id: "adit" } },
    });
    expect(() => assertDraftMatches(other, expected)).toThrow(/llm/i);
  });
});

describe("assertBindingIsCoherent", () => {
  it("accepts a published binding", () => {
    expect(() => assertBindingIsCoherent(draft())).not.toThrow();
  });

  it("accepts an unpublished binding while a version-1 revision is pending", () => {
    const bootstrap = draft({
      binding: { ...draft().binding, checklist: { kind: "unpublished" } },
      pendingRevision: {
        revision: {
          schemaVersion: 1, checklistId: "cl_news", name: "news", version: 1,
          parentVersion: null, createdAt: "2026-08-03T00:00:00.000Z", hash: HASH, questions: [],
        },
        expectedParentVersion: null,
        expectedParentHash: null,
      },
    });
    expect(() => assertBindingIsCoherent(bootstrap)).not.toThrow();
  });

  it("rejects an unpublished binding with nothing pending", () => {
    const stranded = draft({ binding: { ...draft().binding, checklist: { kind: "unpublished" } } });
    expect(() => assertBindingIsCoherent(stranded)).toThrow(/unpublished/i);
  });

  it("rejects an unpublished binding whose pending revision has a parent", () => {
    const wrong = draft({
      binding: { ...draft().binding, checklist: { kind: "unpublished" } },
      pendingRevision: {
        revision: {
          schemaVersion: 1, checklistId: "cl_news", name: "news", version: 2,
          parentVersion: 1, createdAt: "2026-08-03T00:00:00.000Z", hash: HASH, questions: [],
        },
        expectedParentVersion: 1,
        expectedParentHash: HASH,
      },
    });
    expect(() => assertBindingIsCoherent(wrong)).toThrow(/unpublished/i);
  });
});
